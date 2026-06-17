import { join } from "node:path";
import cron from "node-cron";
import chokidar from "chokidar";
import type { Agent, Job } from "./index.ts";

// ---------------------------------------------------------------------------
// In-process scheduler — runs enabled jobs (and agent heartbeats) on their cron
// schedules via node-cron; a chokidar watcher on agents/ + jobs/ reloads the
// schedule set when files change. No separate daemon (one-container default).
// The cron + watch boundaries are injectable so ticks/reloads are deterministic
// in tests.
// ---------------------------------------------------------------------------

const HEARTBEAT_PROMPT = "Perform your scheduled routine.";

export interface CronTask {
  stop: () => void;
}

export interface FsWatcher {
  close: () => void | Promise<void>;
}

export interface SchedulerDeps {
  store: { listJobs(): Promise<Job[]>; listAgents(): Promise<Agent[]> };
  runAgent: (input: { agentSlug: string; prompt: string; jobSlug?: string; providerOverride?: string }) => Promise<unknown>;
  workspaceDir: string;
  /**
   * Reindex the agent/job/conversation file areas before (re)building schedules,
   * so out-of-band file edits (hand-authored files, git pull) that bypass the
   * server writer are picked up. The server wires this to reindexAllAgentAreas.
   */
  reindex?: () => Promise<void>;
  /** Defaults to node-cron. */
  scheduleCron?: (expr: string, fn: () => void) => CronTask;
  /** Defaults to chokidar. */
  watch?: (paths: string[], onChange: () => void) => FsWatcher;
}

export function createScheduler(deps: SchedulerDeps) {
  const scheduleCron = deps.scheduleCron ?? ((expr, fn) => cron.schedule(expr, fn) as unknown as CronTask);
  const watchFactory =
    deps.watch ??
    ((paths, onChange) => {
      const w = chokidar.watch(paths, { ignoreInitial: true });
      w.on("all", onChange);
      return w;
    });

  let tasks: CronTask[] = [];
  let watcher: FsWatcher | null = null;
  const running = new Set<string>();
  let reloadChain: Promise<void> = Promise.resolve();

  // Schedule defensively: a hand-authored agent/job with an invalid cron must
  // not crash the (awaited) scheduler start — skip + warn instead of throwing.
  function safeSchedule(expr: string, fn: () => void, label: string): CronTask | null {
    if (!cron.validate(expr)) {
      console.warn(`[scheduler] skipping ${label}: invalid cron schedule "${expr}"`);
      return null;
    }
    try {
      return scheduleCron(expr, fn);
    } catch (err) {
      console.warn(`[scheduler] failed to schedule ${label}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  function fire(key: string, run: () => Promise<unknown>, deregister?: () => void): void {
    if (deregister) deregister(); // oneShot: stop before running so it never re-fires
    if (running.has(key)) return; // overlap guard
    running.add(key);
    void Promise.resolve()
      .then(run)
      .catch(() => {
        /* a run failure is recorded as a failed transcript by runAgent; never crash the scheduler */
      })
      .finally(() => running.delete(key));
  }

  async function reloadSchedules(): Promise<void> {
    // Pick up out-of-band file changes before reading the derived rows.
    if (deps.reindex) {
      try {
        await deps.reindex();
      } catch (err) {
        console.warn(`[scheduler] reindex before reload failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const task of tasks) task.stop();
    tasks = [];

    const jobs = (await deps.store.listJobs()).filter((j) => j.enabled);
    for (const job of jobs) {
      let task: CronTask | null = null;
      const fn = () =>
        fire(
          `job:${job.slug}`,
          () => deps.runAgent({ agentSlug: job.agent, prompt: job.prompt, jobSlug: job.slug, providerOverride: job.provider ?? undefined }),
          job.oneShot ? () => task?.stop() : undefined
        );
      task = safeSchedule(job.schedule, fn, `job:${job.slug}`);
      if (task) tasks.push(task);
    }

    const agents = (await deps.store.listAgents()).filter((a) => a.enabled && a.schedule);
    for (const agent of agents) {
      const task = safeSchedule(
        agent.schedule!,
        () => fire(`agent:${agent.slug}`, () => deps.runAgent({ agentSlug: agent.slug, prompt: HEARTBEAT_PROMPT, providerOverride: agent.provider ?? undefined })),
        `agent:${agent.slug}`
      );
      if (task) tasks.push(task);
    }
  }

  return {
    async start(): Promise<void> {
      await reloadSchedules();
      watcher = watchFactory([join(deps.workspaceDir, "agents"), join(deps.workspaceDir, "jobs")], () => {
        reloadChain = reloadChain.then(reloadSchedules).catch(() => {});
      });
    },
    async stop(): Promise<void> {
      for (const task of tasks) task.stop();
      tasks = [];
      if (watcher) await watcher.close();
      watcher = null;
    },
    reloadSchedules,
    taskCount: () => tasks.length,
    runningCount: () => running.size,
  };
}

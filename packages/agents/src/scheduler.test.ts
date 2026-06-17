import assert from "node:assert/strict";
import test from "node:test";
import { createScheduler, type CronTask } from "./scheduler.ts";
import type { Agent, Job } from "./index.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  slug: "nightly",
  name: "Nightly",
  enabled: true,
  schedule: "0 2 * * *",
  agent: "scribe",
  prompt: "do it",
  provider: null,
  oneShot: false,
  ...over,
});

/** A fake cron whose tasks the test ticks by calling .fn(); tracks stop(). */
function fakeCron() {
  const tasks: Array<{ expr: string; fn: () => void; stopped: boolean; stop: () => void }> = [];
  const scheduleCron = (expr: string, fn: () => void): CronTask => {
    const t = { expr, fn, stopped: false, stop() { this.stopped = true; } };
    tasks.push(t);
    return t;
  };
  return { tasks, scheduleCron };
}

function harness(initialJobs: Job[], initialAgents: Agent[] = []) {
  let jobs = initialJobs;
  let agents = initialAgents;
  const runs: Array<{ agentSlug: string; prompt: string; jobSlug?: string }> = [];
  const { tasks, scheduleCron } = fakeCron();
  let watchPaths: string[] = [];
  let onChange: (() => void) | null = null;
  let reindexCalls = 0;
  let runImpl: (input: { agentSlug: string; prompt: string; jobSlug?: string }) => Promise<unknown> = async (input) => {
    runs.push(input);
  };

  const scheduler = createScheduler({
    store: { listJobs: async () => jobs, listAgents: async () => agents },
    runAgent: (input) => runImpl(input),
    workspaceDir: "/ws",
    reindex: async () => {
      reindexCalls += 1;
    },
    scheduleCron,
    watch: (paths, cb) => {
      watchPaths = paths;
      onChange = cb;
      return { close: () => {} };
    },
  });

  return {
    scheduler,
    tasks,
    runs,
    get watchPaths() { return watchPaths; },
    get reindexCalls() { return reindexCalls; },
    triggerWatch: () => onChange?.(),
    setJobs: (j: Job[]) => { jobs = j; },
    setRunImpl: (fn: typeof runImpl) => { runImpl = fn; },
    active: () => tasks.filter((t) => !t.stopped),
  };
}

test("a job whose cron fires invokes runAgent with the job's agent + prompt", async () => {
  const h = harness([job({ agent: "scribe", prompt: "summarize" })]);
  await h.scheduler.start();
  assert.equal(h.active().length, 1);
  h.active()[0].fn();
  await flush();
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0], { agentSlug: "scribe", prompt: "summarize", jobSlug: "nightly", providerOverride: undefined });
});

test("start watches the agents + jobs directories", async () => {
  const h = harness([]);
  await h.scheduler.start();
  assert.equal(h.watchPaths.some((p) => p.endsWith("/agents")), true);
  assert.equal(h.watchPaths.some((p) => p.endsWith("/jobs")), true);
});

test("a disabled job is not scheduled; reload after enabling schedules it", async () => {
  const h = harness([job({ enabled: false })]);
  await h.scheduler.start();
  assert.equal(h.active().length, 0);
  h.setJobs([job({ enabled: true })]);
  await h.scheduler.reloadSchedules();
  assert.equal(h.active().length, 1);
});

test("reloadSchedules picks up an edited job (stops old, schedules new)", async () => {
  const h = harness([job({ agent: "scribe", prompt: "v1" })]);
  await h.scheduler.start();
  h.setJobs([job({ agent: "analyst", prompt: "v2" })]);
  await h.scheduler.reloadSchedules();
  assert.equal(h.active().length, 1);
  h.active()[0].fn();
  await flush();
  assert.equal(h.runs.at(-1)?.agentSlug, "analyst");
  assert.equal(h.runs.at(-1)?.prompt, "v2");
});

test("a oneShot job deregisters after firing once", async () => {
  const h = harness([job({ oneShot: true })]);
  await h.scheduler.start();
  const task = h.tasks[0];
  task.fn();
  await flush();
  assert.equal(task.stopped, true); // deregistered
  assert.equal(h.runs.length, 1);
});

test("an overlapping fire while a prior run is in-flight is skipped", async () => {
  const h = harness([job()]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  h.setRunImpl(async () => {
    calls += 1;
    await gate;
  });
  await h.scheduler.start();
  const task = h.tasks[0];
  task.fn();
  await flush();
  task.fn(); // prior run still pending -> skipped
  await flush();
  assert.equal(calls, 1);
  assert.equal(h.scheduler.runningCount(), 1);
  release();
  await flush();
  assert.equal(h.scheduler.runningCount(), 0);
});

test("an agent with an invalid cron schedule is skipped, not crashed", async () => {
  const agent: Agent = { id: "a", slug: "bad", name: "Bad", provider: null, model: null, enabled: true, schedule: "not-a-cron", tags: [] };
  const h = harness([], [agent]);
  await h.scheduler.start(); // must not throw
  assert.equal(h.active().length, 0);
});

test("a job with an invalid cron schedule is skipped, not crashed", async () => {
  const h = harness([job({ schedule: "bogus" })]);
  await h.scheduler.start(); // must not throw
  assert.equal(h.active().length, 0);
});

test("reloadSchedules reindexes canonical files before reading rows", async () => {
  const h = harness([job()]);
  await h.scheduler.start();
  assert.equal(h.reindexCalls >= 1, true); // start reindexed before first reload
  const before = h.reindexCalls;
  await h.scheduler.reloadSchedules();
  assert.equal(h.reindexCalls, before + 1); // every reload reindexes first
});

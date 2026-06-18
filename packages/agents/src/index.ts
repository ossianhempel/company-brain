import { createHash, randomUUID } from "node:crypto";
import { createDb, type CompanyBrainDb } from "@company-brain/db";
import type { GitWriter } from "@company-brain/git-writer";
import type { PageFrontmatter, Workspace } from "@company-brain/workspace";
import { parseAgent } from "./agent-file.ts";
import { parseJob } from "./job-file.ts";
import { buildConversationFile, parseConversation, type ConversationDoc, type ConversationStatus } from "./conversation-file.ts";
import type { ProviderRegistry, RunResult } from "./provider.ts";

export * from "./agent-file.ts";
export * from "./job-file.ts";
export * from "./conversation-file.ts";
export * from "./provider.ts";

// ---------------------------------------------------------------------------
// Reindex — the derived index of the agents/jobs/conversations workspace files.
// Mirrors reindexPages/reindexEntities: parse -> content_hash skip (incl slug,
// so a move re-indexes) -> upsert -> tombstone-missing. None of these have child
// rows, so content_hash is written inline. Runs inside the git writer's commit
// hook (registered by createAgentStore).
// ---------------------------------------------------------------------------

function hashStored(frontmatter: Partial<PageFrontmatter>, markdown: string): string {
  return createHash("sha256").update(JSON.stringify(frontmatter)).update("\n").update(markdown).digest("hex");
}

function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function reindexAgents(db: CompanyBrainDb, workspace: Workspace, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const stored = await workspace.readAgent(slug);
    if (!stored) {
      await db.query("update agents set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
      continue;
    }
    const hash = hashStored(stored.frontmatter, stored.markdown);
    const doc = parseAgent(stored);
    const existing = await db.query<{ content_hash: string | null; slug: string }>(
      "select content_hash, slug from agents where id = $1 and deleted_at is null",
      [doc.id]
    );
    if (existing.rows[0]?.content_hash === hash && existing.rows[0]?.slug === slug) continue;
    // One live agent per slug (move/recreate safety, mirrors reindexEntities).
    await db.query("update agents set deleted_at = now() where slug = $1 and id <> $2 and deleted_at is null", [slug, doc.id]);
    await db.query(
      `
        insert into agents (id, slug, name, provider, model, enabled, schedule, tags_json, content_hash)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (id) do update set
          slug = excluded.slug, name = excluded.name, provider = excluded.provider,
          model = excluded.model, enabled = excluded.enabled, schedule = excluded.schedule,
          tags_json = excluded.tags_json, content_hash = excluded.content_hash,
          updated_at = now(), deleted_at = null
      `,
      [doc.id, slug, doc.name, doc.provider ?? null, doc.model ?? null, doc.enabled, doc.schedule ?? null, JSON.stringify(doc.tags), hash]
    );
  }
}

export async function reindexJobs(db: CompanyBrainDb, workspace: Workspace, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const raw = await workspace.readJob(slug);
    if (raw === null) {
      await db.query("update jobs set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
      continue;
    }
    const hash = hashRaw(raw);
    let doc;
    try {
      doc = parseJob(raw, slug);
    } catch {
      // An invalid job file shouldn't crash the reindex of other files; tombstone
      // any prior valid row so a broken edit doesn't keep scheduling.
      await db.query("update jobs set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
      continue;
    }
    const existing = await db.query<{ content_hash: string | null; slug: string }>(
      "select content_hash, slug from jobs where id = $1 and deleted_at is null",
      [doc.id]
    );
    if (existing.rows[0]?.content_hash === hash && existing.rows[0]?.slug === slug) continue;
    await db.query("update jobs set deleted_at = now() where slug = $1 and id <> $2 and deleted_at is null", [slug, doc.id]);
    await db.query(
      `
        insert into jobs (id, slug, name, enabled, schedule, agent_slug, prompt, provider, model, timeout_ms, one_shot, content_hash)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict (id) do update set
          slug = excluded.slug, name = excluded.name, enabled = excluded.enabled,
          schedule = excluded.schedule, agent_slug = excluded.agent_slug, prompt = excluded.prompt,
          provider = excluded.provider, model = excluded.model, timeout_ms = excluded.timeout_ms,
          one_shot = excluded.one_shot, content_hash = excluded.content_hash, updated_at = now(), deleted_at = null
      `,
      [doc.id, slug, doc.name, doc.enabled, doc.schedule, doc.agent, doc.prompt, doc.provider ?? null, doc.model ?? null, doc.timeoutMs ?? null, doc.oneShot ?? false, hash]
    );
  }
}

export async function reindexConversations(db: CompanyBrainDb, workspace: Workspace, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const stored = await workspace.readConversation(slug);
    if (!stored) {
      await db.query("update conversations set deleted_at = now() where id = $1 and deleted_at is null", [slug]);
      continue;
    }
    const hash = hashStored(stored.frontmatter, stored.markdown);
    const doc = parseConversation(stored);
    const id = doc.id || slug;
    const existing = await db.query<{ content_hash: string | null }>(
      "select content_hash from conversations where id = $1 and deleted_at is null",
      [id]
    );
    if (existing.rows[0]?.content_hash === hash) continue;
    await db.query(
      `
        insert into conversations (id, agent_slug, job_slug, status, provider, model, started_at, ended_at, usage_json, error, content_hash)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (id) do update set
          agent_slug = excluded.agent_slug, job_slug = excluded.job_slug, status = excluded.status,
          provider = excluded.provider, model = excluded.model, started_at = excluded.started_at,
          ended_at = excluded.ended_at, usage_json = excluded.usage_json, error = excluded.error,
          content_hash = excluded.content_hash, deleted_at = null
      `,
      [
        id,
        doc.agent,
        doc.job ?? null,
        doc.status,
        doc.provider ?? null,
        doc.model ?? null,
        doc.startedAt || null,
        doc.endedAt ?? null,
        doc.usage ? JSON.stringify(doc.usage) : null,
        doc.error ?? null,
        hash,
      ]
    );
  }
}

export async function reindexAllAgents(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  const slugs = await workspace.listAgentSlugs();
  await reindexAgents(db, workspace, slugs);
  const onDisk = new Set(slugs);
  const live = await db.query<{ slug: string }>("select slug from agents where deleted_at is null");
  for (const { slug } of live.rows) {
    if (!onDisk.has(slug)) await db.query("update agents set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
  }
}

export async function reindexAllJobs(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  const slugs = await workspace.listJobSlugs();
  await reindexJobs(db, workspace, slugs);
  const onDisk = new Set(slugs);
  const live = await db.query<{ slug: string }>("select slug from jobs where deleted_at is null");
  for (const { slug } of live.rows) {
    if (!onDisk.has(slug)) await db.query("update jobs set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
  }
}

export async function reindexAllConversations(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  const slugs = await workspace.listConversationSlugs();
  await reindexConversations(db, workspace, slugs);
  const onDisk = new Set(slugs);
  const live = await db.query<{ id: string }>("select id from conversations where deleted_at is null");
  for (const { id } of live.rows) {
    if (!onDisk.has(id)) await db.query("update conversations set deleted_at = now() where id = $1 and deleted_at is null", [id]);
  }
}

/** Rebuild every Phase 3 area from files — used by the admin/CLI reindex recovery path. */
export async function reindexAllAgentAreas(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  await reindexAllAgents(db, workspace);
  await reindexAllJobs(db, workspace);
  await reindexAllConversations(db, workspace);
}

/**
 * A git-writer commit hook that reindexes whichever of the three areas a commit
 * touched. Register via gitWriter.addCommitHook (createAgentStore does this).
 */
export function agentAreasCommitHook(db: CompanyBrainDb, workspace: Workspace) {
  return async ({ paths }: { paths: string[] }): Promise<void> => {
    const pick = (area: string) => [
      ...new Set(paths.filter((p) => workspace.pathArea(p) === area).map((p) => workspace.slugFromPath(p))),
    ];
    const agents = pick("agents");
    const jobs = pick("jobs");
    const conversations = pick("conversations");
    if (agents.length) await reindexAgents(db, workspace, agents);
    if (jobs.length) await reindexJobs(db, workspace, jobs);
    if (conversations.length) await reindexConversations(db, workspace, conversations);
  };
}

// ---------------------------------------------------------------------------
// Agent store — reads over the derived index + the file-write seams (raw agent
// edit, write-once transcript) through the single git writer. Mirrors
// createMemoryStore: file mode activates when gitWriter + workspace are supplied.
// ---------------------------------------------------------------------------

export interface AgentStoreOptions {
  gitWriter?: GitWriter;
  workspace?: Workspace;
  /** Provider registry for runAgent; required to execute runs. */
  providers?: ProviderRegistry;
  /** Optional post-completion hook (e.g. memory extraction). Fired best-effort
   *  AFTER the transcript is persisted — never inside the writer mutex — only for
   *  successfully-completed (`done`) runs. Errors are swallowed (best-effort). */
  onConversationComplete?: (conversation: Conversation) => void | Promise<void>;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
  schedule: string | null;
  tags: string[];
}

export interface Job {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  schedule: string;
  agent: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  timeoutMs: number | null;
  oneShot: boolean;
}

export interface Conversation {
  id: string;
  agent: string;
  job: string | null;
  status: ConversationStatus;
  provider: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
}

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
  schedule: string | null;
  tags_json: string;
};

type JobRow = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  schedule: string;
  agent_slug: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  timeout_ms: number | null;
  one_shot: boolean;
};

type ConversationRow = {
  id: string;
  agent_slug: string;
  job_slug: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  usage_json: string | null;
  error: string | null;
};

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    provider: row.provider,
    model: row.model,
    enabled: row.enabled,
    schedule: row.schedule,
    tags: parseTags(row.tags_json),
  };
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    schedule: row.schedule,
    agent: row.agent_slug,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    timeoutMs: row.timeout_ms,
    oneShot: row.one_shot,
  };
}

function toConversation(row: ConversationRow): Conversation {
  let usage: Record<string, unknown> | null = null;
  if (row.usage_json) {
    try {
      const parsed = JSON.parse(row.usage_json);
      if (parsed && typeof parsed === "object") usage = parsed;
    } catch {
      /* leave null */
    }
  }
  return {
    id: row.id,
    agent: row.agent_slug,
    job: row.job_slug,
    status: row.status as ConversationStatus,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    usage,
    error: row.error,
  };
}

export async function createAgentStore(db?: CompanyBrainDb, opts?: AgentStoreOptions) {
  const agentDb = db ?? (await createDb());
  const gitWriter = opts?.gitWriter;
  const workspace = opts?.workspace;
  const providers = opts?.providers;
  const fileMode = Boolean(gitWriter && workspace);

  if (fileMode) {
    gitWriter!.addCommitHook(agentAreasCommitHook(agentDb, workspace!));
  }

  return {
    async listAgents(): Promise<Agent[]> {
      const result = await agentDb.query<AgentRow>("select * from agents where deleted_at is null order by name asc");
      return result.rows.map(toAgent);
    },

    async getAgent(slug: string): Promise<Agent | null> {
      const result = await agentDb.query<AgentRow>("select * from agents where slug = $1 and deleted_at is null", [slug]);
      return result.rows[0] ? toAgent(result.rows[0]) : null;
    },

    /** The raw agent file (system-prompt body) for editing in the workspace UI. */
    async getAgentFile(slug: string): Promise<{ slug: string; name: string; markdown: string } | null> {
      if (!fileMode) return null;
      const stored = await workspace!.readAgent(slug);
      if (!stored) return null;
      return { slug, name: stored.frontmatter.title, markdown: stored.markdown };
    },

    /** Save a raw human edit of an agent file through the single writer -> reindex. */
    async saveAgentFile(
      slug: string,
      markdown: string,
      actor = "local-user",
      patch?: { name?: string; provider?: string; model?: string; enabled?: boolean },
      opts?: { exclusive?: boolean }
    ): Promise<Agent | null> {
      if (!fileMode) throw new Error("Editing agent files requires file mode (gitWriter + workspace).");
      const ws = workspace!;
      await gitWriter!.enqueue({
        paths: [ws.agentFilePath(slug)],
        message: `agent: ${opts?.exclusive ? "create" : "edit"} ${slug}`,
        actor: { name: actor },
        write: async () => {
          const cur = await ws.readAgent(slug);
          // Exclusive create: refuse if the canonical workspace file already exists.
          // Checked here (inside the serialized writer) against files — not the derived
          // index — so a stale/empty index can't let setup clobber an existing persona.
          if (opts?.exclusive && cur) {
            throw new Error(`Agent "${slug}" already exists`);
          }
          // Preserve existing frontmatter identity/config; apply the patch (lets the
          // UI set provider/model/name/enabled, not just the system-prompt body).
          // NOTE: for a new agent `id` is absent here, but writeFileIn's ensureId
          // generates + persists a stable id before writing (and readFileIn backfills
          // on read), so the file's id is stable across reindex — no churn.
          const base: Partial<PageFrontmatter> = cur?.frontmatter ?? { title: slug };
          const frontmatter: Partial<PageFrontmatter> = { ...base };
          if (patch?.name !== undefined) frontmatter.title = patch.name;
          if (patch?.provider !== undefined) frontmatter.provider = patch.provider;
          if (patch?.model !== undefined) frontmatter.model = patch.model;
          if (patch?.enabled !== undefined) frontmatter.enabled = patch.enabled;
          await ws.writeAgent(slug, { frontmatter, markdown }, new Date().toISOString(), { exclusive: opts?.exclusive });
        },
      });
      return this.getAgent(slug);
    },

    async listJobs(): Promise<Job[]> {
      const result = await agentDb.query<JobRow>("select * from jobs where deleted_at is null order by name asc");
      return result.rows.map(toJob);
    },

    async getJob(slug: string): Promise<Job | null> {
      const result = await agentDb.query<JobRow>("select * from jobs where slug = $1 and deleted_at is null", [slug]);
      return result.rows[0] ? toJob(result.rows[0]) : null;
    },

    /** Whether a job has ever produced a conversation — the durable "has fired"
     *  signal for one-shot jobs (conversations are files-canonical, so this
     *  survives reload, restart, and a full reindex). */
    async hasJobRun(jobSlug: string): Promise<boolean> {
      const result = await agentDb.query("select 1 from conversations where job_slug = $1 and deleted_at is null limit 1", [jobSlug]);
      return result.rows.length > 0;
    },

    async listConversations(input?: { status?: ConversationStatus; agent?: string; limit?: number }): Promise<Conversation[]> {
      const where = ["deleted_at is null"];
      const params: unknown[] = [];
      if (input?.status) {
        params.push(input.status);
        where.push(`status = $${params.length}`);
      }
      if (input?.agent) {
        params.push(input.agent);
        where.push(`agent_slug = $${params.length}`);
      }
      // Guard NaN/non-finite (e.g. from a bad ?limit= query) so it can't reach SQL.
      const requested = input?.limit;
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested as number, 1), 500) : 100;
      const result = await agentDb.query<ConversationRow>(
        `select * from conversations where ${where.join(" and ")} order by started_at desc nulls last limit ${limit}`,
        params
      );
      return result.rows.map(toConversation);
    },

    /** A conversation's metadata plus its full transcript turns (from the file). */
    async getConversation(id: string): Promise<(Conversation & { turns: ConversationDoc["turns"] }) | null> {
      const result = await agentDb.query<ConversationRow>("select * from conversations where id = $1 and deleted_at is null", [id]);
      const row = result.rows[0];
      if (!row) return null;
      let turns: ConversationDoc["turns"] = [];
      if (fileMode) {
        const stored = await workspace!.readConversation(id);
        if (stored) turns = parseConversation(stored).turns;
      }
      return { ...toConversation(row), turns };
    },

    /**
     * Archive a conversation: a single status→archived lifecycle edit to its
     * transcript file, through the single writer → reindex. The only
     * post-completion edit to a transcript (otherwise write-once). Idempotent;
     * null if the conversation file is missing.
     */
    async archiveConversation(id: string, actor = "system"): Promise<Conversation | null> {
      if (!fileMode) throw new Error("Archiving conversations requires file mode (gitWriter + workspace).");
      const ws = workspace!;
      const stored = await ws.readConversation(id);
      if (!stored) return null;
      const doc = parseConversation(stored);
      if (doc.status !== "archived") {
        await gitWriter!.enqueue({
          paths: [ws.conversationFilePath(id)],
          message: `conversation: archive ${id}`,
          actor: { name: actor },
          write: async () => {
            const cur = await ws.readConversation(id);
            if (!cur) return;
            const fresh = buildConversationFile({ ...parseConversation(cur), status: "archived" });
            await ws.writeConversation(id, { frontmatter: fresh.frontmatter, markdown: fresh.markdown }, new Date().toISOString());
          },
        });
      }
      // Reconcile the derived row from the canonical file. Repairs a stale index
      // if a prior archive's reindex hook failed (file archived, row still done/failed)
      // — a retry now fixes it. Idempotent when the row already matches (hash skip).
      await reindexConversations(agentDb, workspace!, [id]);
      const result = await agentDb.query<ConversationRow>("select * from conversations where id = $1", [id]);
      if (result.rows[0]) return toConversation(result.rows[0]);
      // The file exists (read above) but the derived row is missing/stale — derive
      // the result from the file so callers don't see a spurious 404.
      return {
        id: doc.id || id,
        agent: doc.agent,
        job: doc.job ?? null,
        status: "archived",
        provider: doc.provider ?? null,
        model: doc.model ?? null,
        startedAt: doc.startedAt || null,
        endedAt: doc.endedAt ?? null,
        usage: doc.usage ?? null,
        error: doc.error ?? null,
      };
    },

    /** Write a conversation transcript once (the finalized run) through the writer. */
    async saveConversation(doc: ConversationDoc, actor = "system"): Promise<Conversation | null> {
      if (!fileMode) throw new Error("Saving conversations requires file mode (gitWriter + workspace).");
      const ws = workspace!;
      const file = buildConversationFile(doc);
      await gitWriter!.enqueue({
        paths: [ws.conversationFilePath(doc.id)],
        message: `conversation: ${doc.agent} ${doc.id}`,
        actor: { name: actor },
        write: async () => {
          await ws.writeConversation(doc.id, { frontmatter: file.frontmatter, markdown: file.markdown }, new Date().toISOString());
        },
      });
      const result = await agentDb.query<ConversationRow>("select * from conversations where id = $1", [doc.id]);
      return result.rows[0] ? toConversation(result.rows[0]) : null;
    },

    /**
     * Run an agent to completion and write the transcript once. Resolves the
     * agent's persona (system prompt) + provider, executes, and records a
     * conversation — including a `failed` transcript when the provider is
     * unavailable or errors (never throws on a run failure, only on bad input).
     */
    async runAgent(input: {
      agentSlug: string;
      prompt: string;
      jobSlug?: string;
      providerOverride?: string;
      modelOverride?: string;
      timeoutMs?: number;
      actor?: string;
    }): Promise<Conversation | null> {
      if (!fileMode) throw new Error("runAgent requires file mode (gitWriter + workspace).");
      if (!providers) throw new Error("runAgent requires a provider registry.");
      const agent = await this.getAgent(input.agentSlug);
      if (!agent) throw new Error(`Agent not found: ${input.agentSlug}`);

      const file = await this.getAgentFile(input.agentSlug);
      const systemPrompt = file?.markdown ?? "";
      const providerId = input.providerOverride ?? agent.provider ?? null;
      const model = input.modelOverride ?? agent.model ?? undefined;
      const startedAt = new Date().toISOString();

      let result: RunResult;
      if (!agent.enabled) {
        // A disabled agent must not run via any path (job, API, CLI) — record a
        // failed transcript so the refusal is auditable.
        result = { status: "failed", turns: [], error: `Agent "${input.agentSlug}" is disabled.` };
      } else if (!providerId) {
        result = { status: "failed", turns: [], error: `No provider configured for agent "${input.agentSlug}".` };
      } else {
        const provider = providers.get(providerId);
        if (!provider) {
          result = { status: "failed", turns: [], error: `Unknown provider "${providerId}".` };
        } else {
          // detect() is the availability boundary — gate here so an unavailable
          // provider is recorded as a failed transcript without invoking run().
          // A run() that still throws is caught (audit contract: every attempt is
          // persisted, never escapes this call).
          try {
            const detection = await provider.detect();
            result = detection.available
              ? await provider.run({ systemPrompt, prompt: input.prompt, model, timeoutMs: input.timeoutMs })
              : { status: "failed", turns: [], error: detection.error ?? `Provider "${providerId}" is unavailable.` };
          } catch (err) {
            result = { status: "failed", turns: [], error: err instanceof Error ? err.message : String(err) };
          }
        }
      }

      const doc: ConversationDoc = {
        id: randomUUID(),
        agent: input.agentSlug,
        job: input.jobSlug,
        status: result.status,
        provider: providerId ?? "none",
        model,
        startedAt,
        endedAt: new Date().toISOString(),
        usage: result.usage,
        error: result.error,
        turns: [{ role: "user", content: input.prompt }, ...result.turns],
      };
      const conversation = await this.saveConversation(doc, input.actor ?? input.agentSlug);
      // Fire the post-completion hook best-effort, AFTER persistence (not in the writer
      // mutex), only for successful runs. A hook failure must not fail the run.
      if (conversation && conversation.status === "done" && opts?.onConversationComplete) {
        try {
          await opts.onConversationComplete(conversation);
        } catch (err) {
          console.error("[agents] onConversationComplete hook failed:", err instanceof Error ? err.message : err);
        }
      }
      return conversation;
    },
  };
}
export * from "./providers/local-cli.ts";
export * from "./scheduler.ts";

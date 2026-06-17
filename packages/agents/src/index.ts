import { createHash } from "node:crypto";
import type { CompanyBrainDb } from "@company-brain/db";
import type { PageFrontmatter, Workspace } from "@company-brain/workspace";
import { parseAgent } from "./agent-file.ts";
import { parseJob } from "./job-file.ts";
import { parseConversation } from "./conversation-file.ts";

export * from "./agent-file.ts";
export * from "./job-file.ts";
export * from "./conversation-file.ts";

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
        insert into jobs (id, slug, name, enabled, schedule, agent_slug, provider, content_hash)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (id) do update set
          slug = excluded.slug, name = excluded.name, enabled = excluded.enabled,
          schedule = excluded.schedule, agent_slug = excluded.agent_slug,
          provider = excluded.provider, content_hash = excluded.content_hash,
          updated_at = now(), deleted_at = null
      `,
      [doc.id, slug, doc.name, doc.enabled, doc.schedule, doc.agent, doc.provider ?? null, hash]
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

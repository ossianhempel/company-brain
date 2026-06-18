import { createHash } from "node:crypto";
import type { CompanyBrainDb } from "@company-brain/db";
import type { GitWriter, CommitHookInfo } from "@company-brain/git-writer";
import type { Workspace, PageFrontmatter } from "@company-brain/workspace";
import { buildSuggestionFile, parseSuggestion, type SuggestionDoc, type SuggestionStatus } from "./suggestion-file.ts";

export { parseSuggestion, buildSuggestionFile, type SuggestionDoc, type SuggestionStatus };

function hashStored(frontmatter: Partial<PageFrontmatter>, markdown: string): string {
  return createHash("sha256").update(JSON.stringify(frontmatter)).update("\n").update(markdown).digest("hex");
}

const SUGGESTIONS_AREA = "suggestions";

/**
 * Reindex suggestion files into the derived `suggestions` table. Mirrors
 * reindexConversations: parse → content_hash skip → upsert. Runs inside the git
 * writer's commit hook so the index is atomic with the proposal commit.
 */
export async function reindexSuggestions(db: CompanyBrainDb, workspace: Workspace, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const stored = await workspace.readSuggestion(slug);
    if (!stored) {
      await db.query("update suggestions set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
      continue;
    }
    const hash = hashStored(stored.frontmatter, stored.markdown);
    const doc = parseSuggestion(stored);
    const id = doc.id || slug;
    const existing = await db.query<{ content_hash: string | null }>(
      "select content_hash from suggestions where id = $1 and deleted_at is null",
      [id]
    );
    if (existing.rows[0]?.content_hash === hash) continue;
    await db.query(
      `
        insert into suggestions (id, slug, target_page_id, base_oid, author, status, title, content_hash)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (id) do update set
          slug = excluded.slug, target_page_id = excluded.target_page_id, base_oid = excluded.base_oid,
          author = excluded.author, status = excluded.status, title = excluded.title,
          content_hash = excluded.content_hash, updated_at = now(), deleted_at = null
      `,
      [id, slug, doc.targetPageId, doc.baseOid ?? null, doc.author, doc.status, doc.title, hash]
    );
  }
}

export async function reindexAllSuggestions(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  const slugs = await workspace.listSuggestionSlugs();
  await reindexSuggestions(db, workspace, slugs);
  const onDisk = new Set(slugs);
  const live = await db.query<{ slug: string }>("select slug from suggestions where deleted_at is null");
  for (const { slug } of live.rows) {
    if (!onDisk.has(slug)) {
      await db.query("update suggestions set deleted_at = now() where slug = $1 and deleted_at is null", [slug]);
    }
  }
}

/** Commit-hook: reindex only the suggestion files a commit touched. */
export function suggestionsCommitHook(db: CompanyBrainDb, workspace: Workspace) {
  return async (info: CommitHookInfo) => {
    const slugs = new Set<string>();
    for (const path of info.paths) {
      if (path.startsWith(`${SUGGESTIONS_AREA}/`) && path.endsWith(".md")) {
        slugs.add(workspace.slugFromPath(path));
      }
    }
    if (slugs.size) await reindexSuggestions(db, workspace, [...slugs]);
  };
}

export type { GitWriter };

// ---------------------------------------------------------------------------
// Suggest-changes store: propose → approve/reject. A proposal is a workspace
// file; approval applies the proposed body to the target page THROUGH the single
// writer (co-attributed, file-first), then marks the suggestion approved.
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string;
  targetPageId: string;
  baseOid: string | null;
  author: string;
  status: SuggestionStatus;
  title: string;
}

export interface SuggestionDetail extends Suggestion {
  proposedMarkdown: string;
}

interface SuggestionRow {
  id: string;
  slug: string;
  target_page_id: string;
  base_oid: string | null;
  author: string;
  status: string;
  title: string;
}

/** Minimal page-store surface the approval flow needs (avoids a hard type coupling). */
export interface PageStoreLike {
  get(id: string): Promise<{ id: string; slug: string } | null>;
  pageVersion(slug: string): Promise<string | null>;
  update(
    id: string,
    input: { html?: string; actor?: string; baseVersion?: string | null }
  ): Promise<unknown | null>;
}

export interface SuggestionStoreOptions {
  gitWriter: GitWriter;
  workspace: Workspace;
  pages: PageStoreLike;
  /** Stable id generator (injected for determinism in tests). */
  newId?: () => string;
}

function toSuggestion(row: SuggestionRow): Suggestion {
  const status: SuggestionStatus = row.status === "approved" || row.status === "rejected" ? row.status : "open";
  return {
    id: row.id,
    targetPageId: row.target_page_id,
    baseOid: row.base_oid,
    author: row.author,
    status,
    title: row.title,
  };
}

export async function createSuggestionStore(db: CompanyBrainDb, opts: SuggestionStoreOptions) {
  const { gitWriter, workspace, pages } = opts;
  const newId = opts.newId ?? (() => `sg-${createHash("sha256").update(`${Math.random()}`).digest("hex").slice(0, 12)}`);

  async function writeDoc(doc: SuggestionDoc, actor: string, message: string): Promise<void> {
    const file = buildSuggestionFile(doc);
    await gitWriter.enqueue({
      paths: [workspace.suggestionFilePath(doc.id)],
      message,
      actor: { name: actor },
      write: async () => {
        await workspace.writeSuggestion(doc.id, { frontmatter: file.frontmatter, markdown: file.markdown }, new Date().toISOString());
      },
    });
  }

  async function loadDoc(id: string): Promise<SuggestionDoc | null> {
    const stored = await workspace.readSuggestion(id);
    return stored ? parseSuggestion(stored) : null;
  }

  return {
    /** Propose an edit to a page (status open). Captures the target's current version as base_oid. */
    async create(input: { targetPageId: string; proposedMarkdown: string; title: string; author: string }): Promise<Suggestion | null> {
      const page = await pages.get(input.targetPageId);
      if (!page) return null;
      const baseOid = await pages.pageVersion(page.slug);
      const id = newId();
      const doc: SuggestionDoc = {
        id,
        targetPageId: input.targetPageId,
        baseOid,
        author: input.author,
        status: "open",
        title: input.title,
        proposedMarkdown: input.proposedMarkdown,
      };
      await writeDoc(doc, input.author, `suggestion: propose ${id}`);
      const row = await db.query<SuggestionRow>("select * from suggestions where id = $1 and deleted_at is null", [id]);
      if (row.rows[0]) return toSuggestion(row.rows[0]);
      return { id, targetPageId: doc.targetPageId, baseOid, author: doc.author, status: "open", title: doc.title };
    },

    async list(filter: { status?: SuggestionStatus; targetPageId?: string } = {}): Promise<Suggestion[]> {
      const where: string[] = ["deleted_at is null"];
      const params: unknown[] = [];
      if (filter.status) {
        params.push(filter.status);
        where.push(`status = $${params.length}`);
      }
      if (filter.targetPageId) {
        params.push(filter.targetPageId);
        where.push(`target_page_id = $${params.length}`);
      }
      const result = await db.query<SuggestionRow>(
        `select * from suggestions where ${where.join(" and ")} order by created_at desc`,
        params
      );
      return result.rows.map(toSuggestion);
    },

    async get(id: string): Promise<SuggestionDetail | null> {
      const doc = await loadDoc(id);
      if (!doc) return null;
      return {
        id: doc.id || id,
        targetPageId: doc.targetPageId,
        baseOid: doc.baseOid ?? null,
        author: doc.author,
        status: doc.status,
        title: doc.title,
        proposedMarkdown: doc.proposedMarkdown,
      };
    },

    /**
     * Apply a suggestion to its target page through the single writer (co-attributed),
     * then mark it approved. The target page's per-file version is checked against the
     * proposal's base_oid, so approving a stale suggestion conflicts (409) instead of
     * clobbering changes made since the proposal.
     */
    async approve(id: string, approver: string): Promise<Suggestion | null> {
      const doc = await loadDoc(id);
      if (!doc) return null;
      if (doc.status !== "open") {
        const current = await db.query<SuggestionRow>("select * from suggestions where id = $1 and deleted_at is null", [id]);
        return current.rows[0] ? toSuggestion(current.rows[0]) : null; // idempotent: already decided
      }
      const html = workspace.markdownToHtml(doc.proposedMarkdown);
      // Apply via the page store's writer; baseVersion = the proposal's base oid.
      await pages.update(doc.targetPageId, {
        html,
        actor: `${approver} (apply suggestion by ${doc.author})`,
        baseVersion: doc.baseOid,
      });
      await writeDoc({ ...doc, status: "approved" }, approver, `suggestion: approve ${id}`);
      const row = await db.query<SuggestionRow>("select * from suggestions where id = $1 and deleted_at is null", [id]);
      return row.rows[0] ? toSuggestion(row.rows[0]) : null;
    },

    async reject(id: string, approver: string): Promise<Suggestion | null> {
      const doc = await loadDoc(id);
      if (!doc) return null;
      if (doc.status === "open") await writeDoc({ ...doc, status: "rejected" }, approver, `suggestion: reject ${id}`);
      const row = await db.query<SuggestionRow>("select * from suggestions where id = $1 and deleted_at is null", [id]);
      return row.rows[0] ? toSuggestion(row.rows[0]) : null;
    },
  };
}

export type SuggestionStore = Awaited<ReturnType<typeof createSuggestionStore>>;

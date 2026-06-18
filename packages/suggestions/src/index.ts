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

import type { PageFrontmatter } from "@company-brain/workspace";

/** Minimal stored-file shape (StoredPage is assignable to this). */
type StoredFile = { frontmatter: Partial<PageFrontmatter>; markdown: string };

// ---------------------------------------------------------------------------
// Suggestion (suggest-changes) — a workspace markdown file (suggestions/<id>.md).
// Frontmatter carries the proposal metadata (target page, base version it was
// drafted against, author, lifecycle status); the body IS the proposed page
// markdown that an approver will apply to the target page through the writer.
// Files-canonical + reindexed into the `suggestions` table (rebuildable).
// ---------------------------------------------------------------------------

export type SuggestionStatus = "open" | "approved" | "rejected";

export interface SuggestionDoc {
  id: string;
  targetPageId: string;
  /** The target page's last-commit oid the proposal was drafted against (for stale detection). */
  baseOid?: string | null;
  author: string;
  status: SuggestionStatus;
  title: string;
  /** Proposed page body (markdown). */
  proposedMarkdown: string;
}

type SuggestionFrontmatter = Partial<PageFrontmatter> & {
  targetPageId?: string;
  baseOid?: string | null;
  author?: string;
  status?: SuggestionStatus;
};

const STATUSES: SuggestionStatus[] = ["open", "approved", "rejected"];

export function parseSuggestion(stored: StoredFile): SuggestionDoc {
  const fm = stored.frontmatter as SuggestionFrontmatter;
  const status = STATUSES.includes(fm.status as SuggestionStatus) ? (fm.status as SuggestionStatus) : "open";
  return {
    id: fm.id ?? "",
    targetPageId: typeof fm.targetPageId === "string" ? fm.targetPageId : "",
    baseOid: typeof fm.baseOid === "string" ? fm.baseOid : null,
    author: typeof fm.author === "string" ? fm.author : "",
    status,
    title: typeof fm.title === "string" ? fm.title : "",
    proposedMarkdown: stored.markdown.trim() + "\n",
  };
}

export function buildSuggestionFile(doc: SuggestionDoc): {
  frontmatter: Partial<PageFrontmatter>;
  markdown: string;
} {
  const frontmatter: SuggestionFrontmatter = {
    id: doc.id,
    title: doc.title || `Suggestion ${doc.id}`,
    targetPageId: doc.targetPageId,
    author: doc.author,
    status: doc.status,
  };
  if (doc.baseOid) frontmatter.baseOid = doc.baseOid;
  return { frontmatter, markdown: doc.proposedMarkdown.trim() + "\n" };
}

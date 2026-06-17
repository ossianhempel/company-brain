import type { PageFrontmatter, StoredPage } from "@company-brain/workspace";

// ---------------------------------------------------------------------------
// Conversation transcript — a workspace markdown file (conversations/<id>.md),
// written ONCE at run completion (immutable). Frontmatter carries run metadata;
// the body is the turns, one `## <role>` section each. Turn parsing is
// fence-aware so a `## ` line inside a fenced code block in a turn's content
// does not split the transcript.
// ---------------------------------------------------------------------------

export type ConversationStatus = "running" | "awaiting_input" | "done" | "failed" | "archived";

export interface ConversationTurn {
  role: string; // user | agent | system | tool | …
  content: string;
}

export interface ConversationDoc {
  id: string;
  agent: string; // agent slug
  job?: string; // job slug, when run by a scheduled job
  status: ConversationStatus;
  provider: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  usage?: Record<string, unknown>;
  error?: string;
  turns: ConversationTurn[];
}

type ConversationFrontmatter = Partial<PageFrontmatter> & {
  agent?: string;
  job?: string;
  status?: ConversationStatus;
  provider?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  usage?: Record<string, unknown>;
  error?: string;
};

const STATUSES: ConversationStatus[] = ["running", "awaiting_input", "done", "failed", "archived"];

/** Split a transcript body into turns by `## <role>`, ignoring headings inside fences. */
function parseTurns(body: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: { role: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) turns.push({ role: current.role, content: current.lines.join("\n").trim() });
      current = { role: heading[1].toLowerCase(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) turns.push({ role: current.role, content: current.lines.join("\n").trim() });
  return turns;
}

export function parseConversation(stored: StoredPage): ConversationDoc {
  const fm = stored.frontmatter as ConversationFrontmatter;
  const status = STATUSES.includes(fm.status as ConversationStatus) ? (fm.status as ConversationStatus) : "done";
  return {
    id: fm.id ?? "",
    agent: typeof fm.agent === "string" ? fm.agent : "",
    job: typeof fm.job === "string" ? fm.job : undefined,
    status,
    provider: typeof fm.provider === "string" ? fm.provider : "",
    model: typeof fm.model === "string" ? fm.model : undefined,
    startedAt: typeof fm.startedAt === "string" ? fm.startedAt : "",
    endedAt: typeof fm.endedAt === "string" ? fm.endedAt : undefined,
    usage: fm.usage && typeof fm.usage === "object" ? fm.usage : undefined,
    error: typeof fm.error === "string" ? fm.error : undefined,
    turns: parseTurns(stored.markdown),
  };
}

export function buildConversationFile(doc: ConversationDoc): {
  frontmatter: Partial<PageFrontmatter>;
  markdown: string;
} {
  const frontmatter: ConversationFrontmatter = {
    id: doc.id,
    title: `${doc.agent} · ${doc.id}`,
    agent: doc.agent,
    status: doc.status,
    provider: doc.provider,
    startedAt: doc.startedAt,
  };
  if (doc.job) frontmatter.job = doc.job;
  if (doc.model) frontmatter.model = doc.model;
  if (doc.endedAt) frontmatter.endedAt = doc.endedAt;
  if (doc.usage) frontmatter.usage = doc.usage;
  if (doc.error) frontmatter.error = doc.error;

  const body = doc.turns.map((t) => `## ${t.role}\n\n${t.content}`).join("\n\n");
  return { frontmatter, markdown: body.trim() + "\n" };
}

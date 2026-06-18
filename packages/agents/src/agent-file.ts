import { randomUUID } from "node:crypto";
import type { PageFrontmatter, StoredPage } from "@company-brain/workspace";

// ---------------------------------------------------------------------------
// Agent persona file — a workspace markdown file (agents/<slug>.md):
//   - frontmatter: id, title (= display name), provider, model, effort,
//     enabled, schedule (optional heartbeat cron), tags
//   - body: the agent's system prompt (verbatim)
// Mirrors packages/memory/src/entity-file.ts: stable id, defaults, round-trip.
// ---------------------------------------------------------------------------

export interface AgentDoc {
  id: string;
  /** Display name (stored as frontmatter `title`). */
  name: string;
  /** Provider id, e.g. "claude_local" / "codex_local". */
  provider?: string;
  model?: string;
  effort?: string;
  /** Whether the agent's heartbeat schedule + runs are active. */
  enabled: boolean;
  /** Optional cron schedule for a persona heartbeat run. */
  schedule?: string;
  tags: string[];
  /** The system prompt — the markdown body. */
  systemPrompt: string;
}

type AgentFrontmatter = Partial<PageFrontmatter> & {
  provider?: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  schedule?: string;
};

/** Build a new agent doc with a stable id; enabled defaults true. */
export function newAgent(input: {
  name: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  schedule?: string;
  tags?: string[];
  id?: string;
}): AgentDoc {
  return {
    id: input.id ?? randomUUID(),
    name: input.name,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    enabled: input.enabled ?? true,
    schedule: input.schedule,
    tags: input.tags ?? [],
    systemPrompt: input.systemPrompt.trim(),
  };
}

/** Parse an agent file (frontmatter + body) into a structured doc. */
export function parseAgent(stored: StoredPage): AgentDoc {
  const fm = stored.frontmatter as AgentFrontmatter;
  return {
    id: fm.id ?? randomUUID(),
    name: fm.title ?? "Untitled agent",
    provider: typeof fm.provider === "string" ? fm.provider : undefined,
    model: typeof fm.model === "string" ? fm.model : undefined,
    effort: typeof fm.effort === "string" ? fm.effort : undefined,
    // Default enabled true; only an explicit `false` disables (no falsy coercion).
    enabled: fm.enabled !== false,
    schedule: typeof fm.schedule === "string" ? fm.schedule : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    systemPrompt: stored.markdown.trim(),
  };
}

/** Serialize an agent doc to a workspace file (frontmatter + system-prompt body). */
export function buildAgentFile(doc: AgentDoc): { frontmatter: Partial<PageFrontmatter>; markdown: string } {
  const frontmatter: AgentFrontmatter = {
    id: doc.id,
    title: doc.name,
    enabled: doc.enabled,
    tags: doc.tags,
  };
  if (doc.provider) frontmatter.provider = doc.provider;
  if (doc.model) frontmatter.model = doc.model;
  if (doc.effort) frontmatter.effort = doc.effort;
  if (doc.schedule) frontmatter.schedule = doc.schedule;
  return { frontmatter, markdown: doc.systemPrompt.trim() + "\n" };
}

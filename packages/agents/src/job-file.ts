import cron from "node-cron";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Job file — a workspace YAML definition (jobs/<slug>.yaml) describing a
// scheduled agent run. The slug (filename) is the stable identity; the YAML
// carries the schedule, target agent, prompt, and lifecycle hooks.
// ---------------------------------------------------------------------------

export interface JobDoc {
  /** Stable id — explicit `id:` in the YAML, else the path-derived slug. */
  id: string;
  /** Path-derived slug (filename without extension). */
  slug: string;
  name: string;
  enabled: boolean;
  /** Cron schedule (validated against node-cron). */
  schedule: string;
  provider?: string;
  model?: string;
  /** Target agent slug to run. */
  agent: string;
  prompt: string;
  timeoutMs?: number;
  oneShot?: boolean;
  /** Optional follow-up actions on success (e.g. "extract-memory"). */
  onComplete?: string[];
  /** Optional action on failure. */
  onFailure?: string;
}

export class JobValidationError extends Error {}

function asString(value: unknown, field: string, slug: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new JobValidationError(`Job "${slug}": "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

/** Parse + validate a job YAML for the given slug (filename). */
export function parseJob(raw: string, slug: string): JobDoc {
  let obj: Record<string, unknown>;
  try {
    const parsed = parseYaml(raw);
    obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    throw new JobValidationError(`Job "${slug}": invalid YAML — ${(error as Error).message}`);
  }

  const schedule = asString(obj.schedule, "schedule", slug);
  if (!cron.validate(schedule)) {
    throw new JobValidationError(`Job "${slug}": invalid cron schedule "${schedule}".`);
  }
  const agent = asString(obj.agent, "agent", slug);
  const prompt = asString(obj.prompt, "prompt", slug);

  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : slug,
    slug,
    name: typeof obj.name === "string" && obj.name ? obj.name : slug,
    enabled: obj.enabled !== false, // default true; only explicit false disables
    schedule,
    provider: typeof obj.provider === "string" ? obj.provider : undefined,
    model: typeof obj.model === "string" ? obj.model : undefined,
    agent,
    prompt,
    timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
    oneShot: obj.oneShot === true,
    onComplete: Array.isArray(obj.onComplete) ? obj.onComplete.filter((x): x is string => typeof x === "string") : undefined,
    onFailure: typeof obj.onFailure === "string" ? obj.onFailure : undefined,
  };
}

/** Serialize a job doc back to YAML (slug is path-derived, not emitted). */
export function serializeJob(doc: JobDoc): string {
  const out: Record<string, unknown> = {
    name: doc.name,
    enabled: doc.enabled,
    schedule: doc.schedule,
    agent: doc.agent,
    prompt: doc.prompt,
  };
  if (doc.provider) out.provider = doc.provider;
  if (doc.model) out.model = doc.model;
  if (doc.timeoutMs !== undefined) out.timeoutMs = doc.timeoutMs;
  if (doc.oneShot) out.oneShot = true;
  if (doc.onComplete?.length) out.onComplete = doc.onComplete;
  if (doc.onFailure) out.onFailure = doc.onFailure;
  return stringifyYaml(out);
}

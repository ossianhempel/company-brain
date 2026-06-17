import { createHash, randomUUID } from "node:crypto";
import type { MemoryKind, MemorySource, MemoryStatus } from "./index.ts";
import type { PageFrontmatter, StoredPage } from "@company-brain/workspace";

/** A citation on a fact (full MemorySource minus the derived id/memoryId). */
export type FactSource = Omit<MemorySource, "id" | "memoryId">;

// ---------------------------------------------------------------------------
// Entity file model — GBrain "compiled-truth + timeline"
//
// An entity file is a workspace markdown file (memory/<slug>.md) with:
//   - frontmatter: id, title, type, tags
//   - "## Summary"  — the profile (compiled current understanding)
//   - "## Timeline" — dated facts, one markdown list item each
//
// A timeline fact line:
//   - <date> · **<kind>** · <content with [[cites]]> <!--id:<id> conf:<n> status:<s>-->
// The visible text is human-readable; the trailing comment carries the stable
// id (so atomized memory rows survive edits), confidence, and status.
// ---------------------------------------------------------------------------

export type EntityType = "person" | "team" | "project" | "company" | "repo" | "topic";

export interface EntityFact {
  id: string;
  date: string; // ISO date (YYYY-MM-DD)
  kind: MemoryKind;
  content: string; // may contain [[slug]] citations
  citations: string[]; // slugs extracted from [[...]]
  confidence: number;
  status: MemoryStatus;
  /**
   * Full structured citations (artifact/manual/chunk/page incl. quotes),
   * round-tripped via the fact's machine comment so file-mode saveMemory keeps
   * the complete source contract. [[slug]] in content is the human-visible
   * page link; this is the authoritative provenance.
   */
  sources: FactSource[];
}

export interface EntityDoc {
  id: string;
  title: string;
  type: EntityType;
  tags: string[];
  profile: string; // the Summary section
  facts: EntityFact[];
}

const FACT_META = /<!--\s*id:(\S+)\s+conf:([\d.]+)\s+status:(\w+)(?:\s+src:(\S+))?\s*-->\s*$/;
const CITATION = /\[\[([^\]]+)\]\]/g;
const DEFAULT_TYPE: EntityType = "topic";

function encodeSources(sources: FactSource[]): string {
  return Buffer.from(JSON.stringify(sources), "utf8").toString("base64");
}

function decodeSources(encoded: string): FactSource[] {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Build a new fact with a stable id; defaults confidence 1, status active. */
export function newFact(input: {
  kind: MemoryKind;
  content: string;
  date: string;
  confidence?: number;
  id?: string;
  sources?: FactSource[];
}): EntityFact {
  return {
    id: input.id ?? randomUUID(),
    date: input.date,
    kind: input.kind,
    content: input.content.trim(),
    citations: extractCitations(input.content),
    confidence: input.confidence ?? 1,
    status: "active",
    sources: input.sources ?? [],
  };
}

function extractCitations(content: string): string[] {
  const slugs: string[] = [];
  for (const m of content.matchAll(CITATION)) {
    // Support [[slug]] and [[slug|label]] — the slug is before the pipe.
    const slug = m[1]?.split("|")[0]?.trim();
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/**
 * Stable id for a fact that has no explicit marker (e.g. hand-authored). Derived
 * from the entity id + content so repeated parses / full rebuilds produce the
 * same memory id (the rebuild-from-files invariant) AND identical hand-authored
 * lines in different entities don't collide (the id is the global memories PK).
 * App-written facts always carry a marker, bypassing this.
 */
function deterministicFactId(entityId: string, date: string, kind: string, content: string): string {
  return "h" + createHash("sha1").update(`${entityId}|${date}|${kind}|${content}`).digest("hex").slice(0, 12);
}

/** Split the body into named `## ` sections (heading text → content). */
function sectionMap(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const re = /^##\s+(.+?)\s*$/gm;
  const matches = [...markdown.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim().toLowerCase();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : markdown.length;
    sections.set(name, markdown.slice(start, end).trim());
  }
  return sections;
}

/** Parse one timeline list item into a fact (null if not a fact line). */
function parseFactLine(line: string, entityId: string): EntityFact | null {
  const item = line.replace(/^\s*[-*]\s+/, "");
  if (item === line) return null; // not a list item
  let markerId: string | null = null;
  let confidence = 1;
  let status: MemoryStatus = "active";
  let visible = item;
  const meta = item.match(FACT_META);
  if (meta) {
    markerId = meta[1];
    const conf = Number(meta[2]);
    confidence = Number.isFinite(conf) ? conf : 1; // allow 0 (don't coerce via ||)
    status = (meta[3] as MemoryStatus) || "active";
    visible = item.slice(0, meta.index).trim();
  }
  const parts = visible.split(" · ");
  if (parts.length < 3) return null;
  const date = parts[0].trim();
  const kind = parts[1].replace(/\*\*/g, "").trim() as MemoryKind;
  const content = parts.slice(2).join(" · ").trim();
  // Marker id wins; otherwise derive a stable, entity-namespaced id.
  const id = markerId ?? deterministicFactId(entityId, date, kind, content);
  const sources = meta && meta[4] ? decodeSources(meta[4]) : [];
  return { id, date, kind, content, citations: extractCitations(content), confidence, status, sources };
}

function serializeFact(fact: EntityFact): string {
  // A timeline fact is a single list item; collapse newlines so multi-line
  // content can't split the item across lines (which the parser reads line-wise).
  const content = fact.content.replace(/\s*\n\s*/g, " ").trim();
  const src = fact.sources.length ? ` src:${encodeSources(fact.sources)}` : "";
  return `- ${fact.date} · **${fact.kind}** · ${content} <!--id:${fact.id} conf:${fact.confidence} status:${fact.status}${src}-->`;
}

/** Parse an entity file (frontmatter + body) into a structured doc. */
export function parseEntity(stored: StoredPage): EntityDoc {
  const fm = stored.frontmatter as PageFrontmatter & { type?: EntityType };
  const sections = sectionMap(stored.markdown);
  const profile = sections.get("summary") ?? "";
  const timeline = sections.get("timeline") ?? "";
  const facts: EntityFact[] = [];
  for (const line of timeline.split("\n")) {
    const fact = parseFactLine(line, fm.id);
    if (fact) facts.push(fact);
  }
  return {
    id: fm.id,
    title: fm.title,
    type: (fm.type as EntityType) ?? DEFAULT_TYPE,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    profile,
    facts,
  };
}

/** Serialize a doc back into { frontmatter, markdown } for workspace.writeEntity. */
export function buildEntityFile(doc: EntityDoc): {
  frontmatter: Partial<PageFrontmatter> & { type: EntityType };
  markdown: string;
} {
  const timeline = doc.facts.map(serializeFact).join("\n");
  const markdown = `## Summary\n\n${doc.profile.trim()}\n\n## Timeline\n\n${timeline}\n`;
  return {
    frontmatter: { id: doc.id, title: doc.title, type: doc.type, tags: doc.tags },
    markdown,
  };
}

/** Append a fact to a doc (returns a new doc). */
export function appendFact(doc: EntityDoc, fact: EntityFact): EntityDoc {
  return { ...doc, facts: [...doc.facts, fact] };
}

/** Set a fact's status (e.g. forget/supersede); returns a new doc. */
export function setFactStatus(doc: EntityDoc, factId: string, status: MemoryStatus): EntityDoc {
  return {
    ...doc,
    facts: doc.facts.map((f) => (f.id === factId ? { ...f, status } : f)),
  };
}

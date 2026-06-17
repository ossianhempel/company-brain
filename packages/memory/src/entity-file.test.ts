import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEntity,
  buildEntityFile,
  newFact,
  appendFact,
  setFactStatus,
  type EntityDoc,
} from "./entity-file.ts";

const NOW = "2026-06-17";

function doc(overrides: Partial<EntityDoc> = {}): EntityDoc {
  return {
    id: "e1",
    title: "Ada Lovelace",
    type: "person",
    tags: ["eng"],
    profile: "Lead on the storage refactor.",
    facts: [],
    ...overrides,
  };
}

test("round-trips an entity doc through build -> parse", () => {
  const d = doc({
    facts: [
      newFact({ kind: "decision", content: "Chose isomorphic-git over simple-git. [[refactor-spec]]", date: NOW, confidence: 0.9, id: "a1" }),
      newFact({ kind: "preference", content: "Prefers files-canonical storage.", date: "2026-06-15", id: "b2" }),
    ],
  });
  const file = buildEntityFile(d);
  const stored = { frontmatter: { ...file.frontmatter, created: NOW, updated: NOW } as any, markdown: file.markdown };
  const parsed = parseEntity(stored);

  assert.equal(parsed.id, "e1");
  assert.equal(parsed.title, "Ada Lovelace");
  assert.equal(parsed.type, "person");
  assert.equal(parsed.profile, "Lead on the storage refactor.");
  assert.equal(parsed.facts.length, 2);
  assert.equal(parsed.facts[0].id, "a1");
  assert.equal(parsed.facts[0].kind, "decision");
  assert.equal(parsed.facts[0].confidence, 0.9);
  assert.deepEqual(parsed.facts[0].citations, ["refactor-spec"]);
  assert.equal(parsed.facts[1].kind, "preference");
  assert.equal(parsed.facts[1].confidence, 1); // default
});

test("serialize is stable across a second round-trip", () => {
  const d = doc({ facts: [newFact({ kind: "fact", content: "Born 1815.", date: NOW, id: "x1" })] });
  const md1 = buildEntityFile(d).markdown;
  const stored1 = { frontmatter: { id: "e1", title: "Ada Lovelace", type: "person", tags: ["eng"], created: NOW, updated: NOW } as any, markdown: md1 };
  const md2 = buildEntityFile(parseEntity(stored1)).markdown;
  assert.equal(md1, md2);
});

test("appendFact assigns a stable id and preserves existing facts", () => {
  let d = doc({ facts: [newFact({ kind: "fact", content: "A", date: NOW, id: "k1" })] });
  const f = newFact({ kind: "decision", content: "B", date: NOW });
  d = appendFact(d, f);
  assert.equal(d.facts.length, 2);
  assert.match(d.facts[1].id, /[0-9a-f-]{8,}/);
  assert.equal(d.facts[0].id, "k1");
});

test("setFactStatus marks a fact (e.g. forgotten) and survives round-trip", () => {
  let d = doc({ facts: [newFact({ kind: "status", content: "Active fact", date: NOW, id: "s1" })] });
  d = setFactStatus(d, "s1", "forgotten");
  const stored = { frontmatter: { id: "e1", title: "Ada", type: "person", tags: [], created: NOW, updated: NOW } as any, markdown: buildEntityFile(d).markdown };
  assert.equal(parseEntity(stored).facts[0].status, "forgotten");
});

test("parses a hand-authored file (no machine comment) and tolerates a new entity", () => {
  const handAuthored = [
    "## Summary",
    "",
    "A project.",
    "",
    "## Timeline",
    "",
    "- 2026-06-10 · **decision** · Adopted markdown-first storage. [[spec]]",
  ].join("\n");
  const parsed = parseEntity({ frontmatter: { id: "e2", title: "Project X", type: "project", tags: [], created: NOW, updated: NOW } as any, markdown: handAuthored });
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].kind, "decision");
  assert.deepEqual(parsed.facts[0].citations, ["spec"]);
  assert.match(parsed.facts[0].id, /[0-9a-f-]{8,}/); // backfilled id

  // a brand-new entity (no timeline yet) parses to zero facts
  const empty = parseEntity({ frontmatter: { id: "e3", title: "New", type: "topic", tags: [], created: NOW, updated: NOW } as any, markdown: "## Summary\n\n\n\n## Timeline\n\n" });
  assert.equal(empty.facts.length, 0);
});

// --- code-review fixes ------------------------------------------------------

test("confidence 0 round-trips (not coerced to 1)", () => {
  const d = doc({ facts: [newFact({ kind: "fact", content: "Low.", date: NOW, confidence: 0, id: "z1" })] });
  const stored = { frontmatter: { id: "e1", title: "Ada", type: "person", tags: [], created: NOW, updated: NOW } as any, markdown: buildEntityFile(d).markdown };
  assert.equal(parseEntity(stored).facts[0].confidence, 0);
});

test("a marker-less fact gets a deterministic id (stable across rebuilds)", () => {
  const handAuthored = "## Summary\n\nx\n\n## Timeline\n\n- 2026-06-10 · **decision** · Adopted markdown-first.";
  const fm = { id: "e9", title: "X", type: "project", tags: [], created: NOW, updated: NOW } as any;
  const a = parseEntity({ frontmatter: fm, markdown: handAuthored }).facts[0].id;
  const b = parseEntity({ frontmatter: fm, markdown: handAuthored }).facts[0].id;
  assert.equal(a, b); // deterministic — full reindex won't churn the memory id
  assert.match(a, /^h[0-9a-f]{12}$/);
});

test("multi-line content collapses to one line and survives round-trip", () => {
  const d = doc({ facts: [newFact({ kind: "fact", content: "Line one.\nLine two.", date: NOW, id: "n1" })] });
  const stored = { frontmatter: { id: "e1", title: "Ada", type: "person", tags: [], created: NOW, updated: NOW } as any, markdown: buildEntityFile(d).markdown };
  const parsed = parseEntity(stored).facts[0];
  assert.equal(parsed.content, "Line one. Line two.");
  assert.equal(parsed.content.includes("\n"), false);
});

test("[[slug|label]] citation extracts the slug, not the label", () => {
  const f = newFact({ kind: "decision", content: "Per [[the-spec|the spec doc]].", date: NOW, id: "c9" });
  assert.deepEqual(f.citations, ["the-spec"]);
});

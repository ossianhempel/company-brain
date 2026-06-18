import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createMemoryStore, createEmbeddingRegistry } from "./index.ts";
import { embedChunks, gatherChunks } from "./embedding-store.ts";
import { reciprocalRankFusion, rankVectorPool } from "./hybrid.ts";
import type { EmbeddingProvider } from "./embedding.ts";

test("reciprocalRankFusion accumulates 1/(k+rank) across lists", () => {
  const a = [{ k: "x" }, { k: "y" }]; // x rank0, y rank1
  const b = [{ k: "y" }, { k: "z" }]; // y rank0, z rank1
  const fused = reciprocalRankFusion([a, b], (i) => i.k, 60);
  // y is in both → highest; x and z each in one
  assert.ok(fused.get("y")! > fused.get("x")!);
  assert.ok(fused.get("y")! > fused.get("z")!);
  assert.equal(fused.get("x"), 1 / 61);
});

test("rankVectorPool orders by cosine and drops non-positive sims", () => {
  const pool = [
    { chunkType: "memory" as const, ownerId: "near", chunkIndex: 0, vector: [1, 0, 0] },
    { chunkType: "memory" as const, ownerId: "far", chunkIndex: 0, vector: [0, 1, 0] },
  ];
  const ranked = rankVectorPool([1, 0.1, 0], pool, 10);
  assert.equal(ranked[0].ownerId, "near"); // higher cosine to [1,0.1,0]
});

// --- recall integration: degradation + semantic-beyond-recency ---------------

async function withMemory<T>(run: (mem: Awaited<ReturnType<typeof createMemoryStore>>, db: Awaited<ReturnType<typeof createDb>>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "cb-hyb-"));
  const db = await createDb(dir);
  try {
    return await run(await createMemoryStore(db), db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A fake provider that embeds by keyword presence so "semantic" matches are deterministic.
function keywordProvider(axes: string[]): EmbeddingProvider {
  const vec = (text: string) => axes.map((a) => (text.toLowerCase().includes(a) ? 1 : 0));
  return {
    id: "kw",
    model: "kw-v1",
    dim: axes.length,
    async detect() {
      return { available: true, model: "kw-v1", dim: axes.length };
    },
    async embed(texts) {
      return texts.map(vec);
    },
  };
}

test("hybrid degrades to BM25 when no embedding provider is configured", async () => {
  await withMemory(async (mem, db) => {
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'fact','ada','ada prefers typescript','active')", ["m1"]);
    const hybrid = await mem.recall("typescript", 10, "hybrid_rrf_v1");
    const bm25 = await mem.recall("typescript", 10, "bm25_local_v1");
    assert.deepEqual(hybrid.results.map((r) => r.id), bm25.results.map((r) => r.id));
  });
});

test("hybrid surfaces a semantically-related memory that shares no query terms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cb-hyb2-"));
  const db = await createDb(dir);
  try {
    const embeddings = createEmbeddingRegistry();
    embeddings.register(keywordProvider(["vehicle", "typescript"]));
    const mem = await createMemoryStore(db, { embeddings });
    // A memory about "vehicle" — the query "car" shares no lexical term, but both embed on the "vehicle" axis.
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'fact','bob','bob owns a vehicle','active')", ["m1"]);
    // embed the memory chunk on the vehicle axis
    const chunks = await gatherChunks(db);
    await embedChunks(db, embeddings.get("kw")!, chunks);

    // BM25 on "vehicle car" → matches lexically; but test the vector contribution with a term-disjoint query.
    const bm25 = await mem.recall("vehicle", 10, "bm25_local_v1");
    assert.equal(bm25.results.length, 1); // lexical works for "vehicle"

    // hybrid with a query that embeds on the vehicle axis still finds it via the vector track
    const hybrid = await mem.recall("vehicle", 10, "hybrid_rrf_v1");
    assert.ok(hybrid.results.some((r) => r.id === "m1"));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("kind filter restricts hybrid/bm25 results to matching memories", async () => {
  await withMemory(async (mem, db) => {
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'decision','x','choose typescript','active')", ["d1"]);
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'fact','x','typescript is typed','active')", ["f1"]);
    const all = await mem.recall("typescript", 10, "bm25_local_v1");
    assert.equal(all.results.length, 2);
    const decisions = await mem.recall("typescript", 10, "bm25_local_v1", { kind: "decision" });
    assert.deepEqual(decisions.results.map((r) => r.id), ["d1"]);
  });
});

test("hybrid results expose the fused RRF score (not zeroed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cb-hyb3-"));
  const db = await createDb(dir);
  try {
    const embeddings = createEmbeddingRegistry();
    embeddings.register(keywordProvider(["typescript"]));
    const mem = await createMemoryStore(db, { embeddings });
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'fact','ada','ada likes typescript','active')", ["m1"]);
    await embedChunks(db, embeddings.get("kw")!, await gatherChunks(db));
    const hybrid = await mem.recall("typescript", 10, "hybrid_rrf_v1");
    assert.ok(hybrid.results.length >= 1);
    assert.ok(hybrid.results[0].score > 0, "fused RRF score should be exposed, not 0");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

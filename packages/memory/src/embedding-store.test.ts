import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createEmbeddingRegistry, type EmbeddingProvider } from "./embedding.ts";
import { embedChunks, gatherChunks, reindexEmbeddings, loadEmbeddings, type EmbeddableChunk } from "./embedding-store.ts";

async function withDb<T>(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "cb-emb-"));
  const db = await createDb(dir);
  try {
    return await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fake embedding provider that records how many texts it embedded. */
function fakeProvider(): EmbeddingProvider & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    id: "fake",
    model: "fake-v1",
    dim: 3,
    embedded,
    async detect() {
      return { available: true, model: "fake-v1", dim: 3 };
    },
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((_t, i) => [i + 1, 0, 0]);
    },
  };
}

const chunk = (over: Partial<EmbeddableChunk> = {}): EmbeddableChunk => ({
  chunkType: "memory",
  ownerId: "m1",
  chunkIndex: 0,
  text: "hello world",
  contentHash: "h1",
  ...over,
});

test("embedChunks embeds new chunks and upserts them", async () => {
  await withDb(async (db) => {
    const provider = fakeProvider();
    const n = await embedChunks(db, provider, [chunk(), chunk({ ownerId: "m2", contentHash: "h2" })]);
    assert.equal(n, 2);
    const rows = await db.query<{ c: number }>("select count(*)::int as c from chunk_embeddings");
    assert.equal(rows.rows[0].c, 2);
  });
});

test("embedChunks skips unchanged chunks (stable-key content-hash skip) even across re-gather", async () => {
  await withDb(async (db) => {
    const provider = fakeProvider();
    await embedChunks(db, provider, [chunk()]);
    assert.equal(provider.embedded.length, 1);
    // same stable key + same content_hash → skip (the critical idempotency case)
    const n = await embedChunks(db, provider, [chunk()]);
    assert.equal(n, 0);
    assert.equal(provider.embedded.length, 1); // not re-embedded
  });
});

test("embedChunks re-embeds when content_hash changes (updates in place on the stable key)", async () => {
  await withDb(async (db) => {
    const provider = fakeProvider();
    await embedChunks(db, provider, [chunk()]);
    const n = await embedChunks(db, provider, [chunk({ text: "changed", contentHash: "h-new" })]);
    assert.equal(n, 1);
    const rows = await db.query<{ c: number; content_hash: string }>(
      "select count(*)::int as c, max(content_hash) as content_hash from chunk_embeddings where owner_id = 'm1'"
    );
    assert.equal(rows.rows[0].c, 1); // updated in place, not duplicated
    assert.equal(rows.rows[0].content_hash, "h-new");
  });
});

test("reindexEmbeddings is a no-op with no registry or no available provider", async () => {
  await withDb(async (db) => {
    assert.equal(await reindexEmbeddings(db, undefined), null);
    const empty = createEmbeddingRegistry();
    assert.equal(await reindexEmbeddings(db, empty), null);
    const rows = await db.query<{ c: number }>("select count(*)::int as c from chunk_embeddings");
    assert.equal(rows.rows[0].c, 0); // nothing embedded
  });
});

test("reindexEmbeddings embeds gathered chunks when a provider is available", async () => {
  await withDb(async (db) => {
    await db.query("insert into memories (id, kind, subject, content, status) values ($1,'fact','ada','prefers ts','active')", ["m1"]);
    const reg = createEmbeddingRegistry();
    reg.register(fakeProvider());
    const result = await reindexEmbeddings(db, reg);
    assert.equal(result?.embedded, 1);
    const loaded = await loadEmbeddings(db, "fake-v1");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].ownerId, "m1");
  });
});

test("gatherChunks pulls active memories with stable owner ids", async () => {
  await withDb(async (db) => {
    await db.query("insert into memories (id, kind, content, status) values ($1,'fact','x','active')", ["m1"]);
    await db.query("insert into memories (id, kind, content, status) values ($1,'fact','y','forgotten')", ["m2"]);
    const chunks = await gatherChunks(db);
    const memChunks = chunks.filter((c) => c.chunkType === "memory");
    assert.equal(memChunks.length, 1); // only the active one
    assert.equal(memChunks[0].ownerId, "m1");
  });
});

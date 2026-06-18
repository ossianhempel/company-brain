import assert from "node:assert/strict";
import test from "node:test";
import { createEmbeddingRegistry, cosineSimilarity } from "./embedding.ts";
import { apiEmbeddingConfigFromEnv, createApiEmbeddingProvider, EmbeddingError, type FetchLike } from "./providers/api-embedding.ts";

const cfg = { endpoint: "https://x/embed", apiKey: "k", model: "m", dim: 3, batchSize: 2 };

test("apiEmbeddingConfigFromEnv returns null unless fully configured", () => {
  assert.equal(apiEmbeddingConfigFromEnv({}), null);
  assert.equal(apiEmbeddingConfigFromEnv({ COMPANY_BRAIN_EMBEDDING_ENDPOINT: "e", COMPANY_BRAIN_EMBEDDING_API_KEY: "k" }), null); // no model/dim
  const ok = apiEmbeddingConfigFromEnv({
    COMPANY_BRAIN_EMBEDDING_ENDPOINT: "e",
    COMPANY_BRAIN_EMBEDDING_API_KEY: "k",
    COMPANY_BRAIN_EMBEDDING_MODEL: "m",
    COMPANY_BRAIN_EMBEDDING_DIM: "1536",
  });
  assert.equal(ok?.dim, 1536);
  assert.equal(ok?.batchSize, 64);
});

test("registry.active() is null with no provider; resolves a configured one", async () => {
  const empty = createEmbeddingRegistry();
  assert.equal(await empty.active(), null);

  const reg = createEmbeddingRegistry();
  reg.register(createApiEmbeddingProvider(cfg, async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
  const active = await reg.active();
  assert.equal(active?.id, "api_embedding");
});

test("embed batches inputs by batchSize and returns one vector per text", async () => {
  let calls = 0;
  const vectors = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let cursor = 0;
  const fetch: FetchLike = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body) as { input: string[] };
    return { ok: true, status: 200, json: async () => ({ data: body.input.map(() => ({ embedding: vectors[cursor++] })) }) };
  };
  const provider = createApiEmbeddingProvider(cfg, fetch);
  const out = await provider.embed(["a", "b", "c"]);
  assert.equal(out.length, 3);
  assert.equal(calls, 2); // batchSize 2 → [a,b] then [c]
  assert.deepEqual(out[0], [1, 0, 0]);
});

test("a non-ok response raises EmbeddingError (caller falls back, never a silent bad vector)", async () => {
  const fetch: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const provider = createApiEmbeddingProvider(cfg, fetch);
  await assert.rejects(() => provider.embed(["a"]), EmbeddingError);
});

test("a shape mismatch raises EmbeddingError", async () => {
  const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }); // expected 1
  const provider = createApiEmbeddingProvider(cfg, fetch);
  await assert.rejects(() => provider.embed(["a"]), EmbeddingError);
});

test("cosineSimilarity: identical → 1, orthogonal → 0, degenerate → 0", () => {
  assert.equal(Math.round(cosineSimilarity([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0); // length mismatch
});

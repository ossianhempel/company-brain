import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createMemoryStore } from "./index.ts";

async function withMemoryStore<T>(
  run: (memory: Awaited<ReturnType<typeof createMemoryStore>>, db: Awaited<ReturnType<typeof createDb>>) => Promise<T>
) {
  const dataDir = await mkdtemp(join(tmpdir(), "company-brain-memory-test-"));
  const db = await createDb(dataDir);

  try {
    const memory = await createMemoryStore(db);
    return await run(memory, db);
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("ingests source artifacts and recalls source chunks with explicit local BM25 mode", async () => {
  await withMemoryStore(async (memory) => {
    const artifact = await memory.ingestArtifact({
      sourceType: "chat",
      title: "Deployment Chat",
      rawText: "The team decided Railway deployment is not the default. The default target is one local container.",
      actor: "test-agent"
    });

    assert.equal(artifact.sourceType, "chat");
    assert.equal(artifact.createdBy, "test-agent");

    const recall = await memory.recall("local container deployment");
    assert.equal(recall.searchMode, "bm25_local_v1");
    assert.equal(recall.results[0].type, "source_chunk");
    assert.equal(recall.results[0].sourceId, artifact.id);
    assert.match(recall.results[0].snippet, /local container/);

    const lexicalRecall = await memory.recall("local container deployment", 10, "lexical_v1");
    assert.equal(lexicalRecall.searchMode, "lexical_v1");
    assert.equal(lexicalRecall.results[0].sourceId, artifact.id);

    const forgotten = await memory.forgetArtifact(artifact.id, "test-agent");
    assert.equal(forgotten?.deletedAt !== null, true);

    const afterForget = await memory.recall("local container deployment");
    assert.equal(afterForget.results.some((result) => result.sourceId === artifact.id), false);

    const noMatch = await memory.recall("phrase-that-does-not-exist");
    assert.equal(noMatch.results.length, 0);
  });
});

test("preserves source chunk order when an oversized paragraph follows buffered text", async () => {
  await withMemoryStore(async (memory, db) => {
    const oversizedParagraph = Array.from({ length: 220 }, (_, index) => `oversized${index}`).join(" ");
    const artifact = await memory.ingestArtifact({
      sourceType: "meeting",
      title: "Ordered Chunk Source",
      rawText: `Opening context stays first.\n\n${oversizedParagraph}`,
      actor: "test-agent"
    });

    const chunks = await db.query<{ chunk_index: number; text: string }>(
      "select chunk_index, text from source_chunks where artifact_id = $1 order by chunk_index",
      [artifact.id]
    );

    assert.equal(chunks.rows[0].chunk_index, 0);
    assert.match(chunks.rows[0].text, /Opening context stays first/);
    assert.equal(chunks.rows[1].chunk_index, 1);
    assert.match(chunks.rows[1].text, /oversized0/);
  });
});

test("saves and forgets active memories", async () => {
  await withMemoryStore(async (memory) => {
    const artifact = await memory.ingestArtifact({
      sourceType: "chat",
      title: "Deployment Source",
      rawText: "Decision source: Company Brain should run as one local container.",
      actor: "test-agent"
    });
    const saved = await memory.saveMemory({
      kind: "decision",
      subject: "Company Brain deployment",
      content: "Company Brain defaults to a one-container self-hosted deployment.",
      confidence: 0.9,
      actor: "test-agent",
      sources: [
        {
          sourceType: "artifact",
          artifactId: artifact.id,
          pageId: null,
          pageChunkId: null,
          sourceChunkId: null,
          quote: "Company Brain should run as one local container."
        },
        {
          sourceType: "manual",
          pageId: null,
          pageChunkId: null,
          artifactId: null,
          sourceChunkId: null,
          quote: "Manual citation with no source object should still persist."
        }
      ]
    });

    assert.equal(saved.kind, "decision");
    assert.equal(saved.status, "active");
    assert.equal(saved.sources.length, 2);
    assert.equal(saved.sources.every((source) => source.id.length > 0), true);

    const listed = await memory.listMemories({ status: "active" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].sources.length, 2);

    const hydrated = await memory.getMemory(saved.id);
    assert.equal(hydrated?.sources.length, 2);
    assert.equal(hydrated?.sources.every((source) => source.id.length > 0), true);
    assert.equal(
      hydrated?.sources.some((source) => source.sourceType === "artifact" && source.artifactId === artifact.id),
      true
    );
    assert.equal(
      hydrated?.sources.some(
        (source) => source.sourceType === "manual" && source.quote === "Manual citation with no source object should still persist."
      ),
      true
    );

    const beforeForget = await memory.recall("one-container deployment");
    assert.equal(beforeForget.results[0].type, "memory");
    assert.equal(beforeForget.results[0].sourceId, saved.id);
    assert.equal(
      (beforeForget.results[0].metadata.sources as typeof saved.sources).some(
        (source) => source.sourceType === "artifact" && source.artifactId === artifact.id
      ),
      true
    );

    const forgotten = await memory.forgetMemory(saved.id, "test-agent");
    assert.equal(forgotten?.status, "forgotten");

    const afterForget = await memory.recall("one-container deployment");
    assert.equal(afterForget.results.some((result) => result.sourceId === saved.id), false);
  });
});

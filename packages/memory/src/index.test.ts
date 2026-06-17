import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { createMemoryStore, reindexEntities, reindexAllEntities } from "./index.ts";
import { buildEntityFile, newFact, type EntityDoc } from "./entity-file.ts";

async function withEntityIndex<T>(
  run: (db: Awaited<ReturnType<typeof createDb>>, ws: ReturnType<typeof createWorkspace>) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "company-brain-ent-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "company-brain-ent-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  try {
    return await run(db, ws);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

async function writeEntityDoc(ws: ReturnType<typeof createWorkspace>, slug: string, doc: EntityDoc) {
  const file = buildEntityFile(doc);
  await ws.writeEntity(slug, { frontmatter: file.frontmatter, markdown: file.markdown }, "2026-06-17T00:00:00.000Z");
}

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

// --- U3: migration 12 (entities + memories.entity_id) ----------------------

test("migration 12: entities table and memories.entity_id are usable", async () => {
  await withMemoryStore(async (_memory, db) => {
    await db.query(
      "insert into entities (id, slug, title, type, profile) values ($1,$2,$3,$4,$5)",
      ["ent1", "ada", "Ada", "person", "Lead."]
    );
    await db.query(
      "insert into memories (id, kind, content, entity_id) values ($1,$2,$3,$4)",
      ["mem1", "fact", "Born 1815", "ent1"]
    );
    const ent = await db.query<{ slug: string; profile: string }>("select slug, profile from entities where id = $1", ["ent1"]);
    assert.equal(ent.rows[0].slug, "ada");
    assert.equal(ent.rows[0].profile, "Lead.");
    const mem = await db.query<{ entity_id: string }>("select entity_id from memories where id = $1", ["mem1"]);
    assert.equal(mem.rows[0].entity_id, "ent1");
  });
});

// --- U4: reindexEntities ----------------------------------------------------

const baseDoc = (over: Partial<EntityDoc> = {}): EntityDoc => ({
  id: "ent-ada", title: "Ada", type: "person", tags: ["eng"], profile: "Lead.", facts: [], ...over,
});

test("reindexEntities atomizes an entity file into entities + memories rows", async () => {
  await withEntityIndex(async (db, ws) => {
    await writeEntityDoc(ws, "ada", baseDoc({
      facts: [
        newFact({ kind: "decision", content: "Chose isomorphic-git.", date: "2026-06-17", id: "f1" }),
        newFact({ kind: "preference", content: "Prefers files-canonical.", date: "2026-06-15", id: "f2" }),
      ],
    }));
    await reindexEntities(db, ws, ["ada"]);

    const ent = await db.query<{ title: string; profile: string }>("select title, profile from entities where slug = $1", ["ada"]);
    assert.equal(ent.rows[0].title, "Ada");
    assert.equal(ent.rows[0].profile, "Lead.");
    const mems = await db.query<{ id: string }>("select id from memories where entity_id = $1 order by id", ["ent-ada"]);
    assert.deepEqual(mems.rows.map((r) => r.id), ["f1", "f2"]);
  });
});

test("reindexEntities is incremental (unchanged file is skipped, no dup rows)", async () => {
  await withEntityIndex(async (db, ws) => {
    await writeEntityDoc(ws, "ada", baseDoc({ facts: [newFact({ kind: "fact", content: "A", date: "2026-06-17", id: "f1" })] }));
    await reindexEntities(db, ws, ["ada"]);
    await reindexEntities(db, ws, ["ada"]); // unchanged
    const mems = await db.query<{ n: string }>("select count(*) as n from memories where entity_id = $1", ["ent-ada"]);
    assert.equal(Number(mems.rows[0].n), 1);
  });
});

test("reindexAllEntities tombstones an entity whose file was removed", async () => {
  await withEntityIndex(async (db, ws) => {
    await writeEntityDoc(ws, "ada", baseDoc({ facts: [newFact({ kind: "fact", content: "A", date: "2026-06-17", id: "f1" })] }));
    await reindexAllEntities(db, ws);
    await ws.deleteEntity("ada");
    await reindexAllEntities(db, ws);
    const ent = await db.query<{ deleted_at: string | null }>("select deleted_at from entities where id = $1", ["ent-ada"]);
    assert.notEqual(ent.rows[0].deleted_at, null);
    const mems = await db.query<{ n: string }>("select count(*) as n from memories where entity_id = $1", ["ent-ada"]);
    assert.equal(Number(mems.rows[0].n), 0);
  });
});

test("reindexEntities resolves [[slug]] citations to a page id", async () => {
  await withEntityIndex(async (db, ws) => {
    await db.query(
      "insert into pages (id, title, slug, html, plain_text, creator, created_by, updated_by) values ($1,$2,$3,$4,$5,'t','t','t')",
      ["page-spec", "Spec", "spec", "<h1>Spec</h1>", "Spec"]
    );
    await writeEntityDoc(ws, "ada", baseDoc({ facts: [newFact({ kind: "decision", content: "Per the [[spec]].", date: "2026-06-17", id: "f1" })] }));
    await reindexEntities(db, ws, ["ada"]);
    const src = await db.query<{ page_id: string | null }>("select page_id from memory_sources where memory_id = $1", ["f1"]);
    assert.equal(src.rows[0].page_id, "page-spec");
  });
});

// --- U5: file-first memory store --------------------------------------------

import { createGitWriter } from "@company-brain/git-writer";

async function withFileMemoryStore<T>(
  run: (memory: Awaited<ReturnType<typeof createMemoryStore>>, db: Awaited<ReturnType<typeof createDb>>, ws: ReturnType<typeof createWorkspace>, wsDir: string) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "company-brain-fmem-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "company-brain-fmem-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  const gitWriter = createGitWriter({ workspaceDir: wsDir });
  try {
    const memory = await createMemoryStore(db, { gitWriter, workspace: ws });
    return await run(memory, db, ws, wsDir);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

test("file mode: saveMemory writes an entity file and the memory is recallable", async () => {
  await withFileMemoryStore(async (memory, _db, _ws, wsDir) => {
    const saved = await memory.saveMemory({ kind: "decision", subject: "Ada", content: "Chose files-canonical storage.", actor: "alice" });
    assert.equal(existsSync(join(wsDir, "memory", "ada.md")), true);
    assert.equal(saved.kind, "decision");

    const recall = await memory.recall("files-canonical storage");
    assert.equal(recall.results.some((r) => r.sourceId === saved.id), true);
  });
});

test("file mode: two saves for the same subject append to one entity file", async () => {
  await withFileMemoryStore(async (memory, db, ws) => {
    await memory.saveMemory({ kind: "fact", subject: "Ada", content: "Born 1815." });
    await memory.saveMemory({ kind: "preference", subject: "Ada", content: "Prefers async." });
    assert.deepEqual(await ws.listEntitySlugs(), ["ada"]);
    const ent = await db.query<{ id: string }>("select id from entities where slug = $1", ["ada"]);
    const mems = await db.query<{ n: string }>("select count(*) as n from memories where entity_id = $1", [ent.rows[0].id]);
    assert.equal(Number(mems.rows[0].n), 2);
  });
});

test("file mode: forgetMemory drops the fact from active recall", async () => {
  await withFileMemoryStore(async (memory) => {
    const saved = await memory.saveMemory({ kind: "status", subject: "Ada", content: "Currently on leave." });
    const forgotten = await memory.forgetMemory(saved.id);
    assert.equal(forgotten?.status, "forgotten");
    const recall = await memory.recall("currently on leave");
    assert.equal(recall.results.some((r) => r.sourceId === saved.id), false);
  });
});

test("file mode: a page source becomes a resolvable [[slug]] citation", async () => {
  await withFileMemoryStore(async (memory, db) => {
    await db.query(
      "insert into pages (id, title, slug, html, plain_text, creator, created_by, updated_by) values ($1,$2,$3,$4,$5,'t','t','t')",
      ["page-spec", "Spec", "spec", "<h1>Spec</h1>", "Spec"]
    );
    const saved = await memory.saveMemory({
      kind: "decision",
      subject: "Storage",
      content: "Decided per the spec.",
      sources: [{ sourceType: "page", pageId: "page-spec", pageChunkId: null, artifactId: null, sourceChunkId: null, quote: null }],
    });
    const src = await db.query<{ page_id: string | null }>("select page_id from memory_sources where memory_id = $1", [saved.id]);
    assert.equal(src.rows[0]?.page_id, "page-spec");
  });
});

// --- U6: entities/profiles surfaces -----------------------------------------

test("U6: listEntities and getProfile expose the derived entities", async () => {
  await withEntityIndex(async (db, ws) => {
    await writeEntityDoc(ws, "ada", baseDoc({ facts: [newFact({ kind: "fact", content: "Born 1815.", date: "2026-06-17", id: "f1" })] }));
    await reindexEntities(db, ws, ["ada"]);
    const store = await createMemoryStore(db);

    const entities = await store.listEntities();
    assert.equal(entities.some((e) => e.slug === "ada" && e.title === "Ada"), true);

    const profile = await store.getProfile("ada");
    assert.equal(profile?.entity.profile, "Lead.");
    assert.equal(profile?.memories.length, 1);
    assert.equal(profile?.memories[0].id, "f1");

    assert.equal(await store.getProfile("does-not-exist"), null);
  });
});

// --- U7: a memory's page citation survives a page rename --------------------

import { createPageStore } from "@company-brain/pages";

test("U7: memory page citation survives a page rename (id stable)", async () => {
  const wsDir = await mkdtemp(join(tmpdir(), "company-brain-cite-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "company-brain-cite-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  const gitWriter = createGitWriter({ workspaceDir: wsDir });
  try {
    const pages = await createPageStore(db, { gitWriter, workspace: ws });
    const memory = await createMemoryStore(db, { gitWriter, workspace: ws });

    const page = await pages.create({ title: "Spec", html: "<h1>Spec</h1><p>x</p>", actor: "a" });
    assert.equal(page.slug, "spec");

    const saved = await memory.saveMemory({
      kind: "decision",
      subject: "Storage",
      content: "Decided per the spec.",
      sources: [{ sourceType: "page", pageId: page.id, pageChunkId: null, artifactId: null, sourceChunkId: null, quote: null }],
    });
    const before = await db.query<{ page_id: string | null }>("select page_id from memory_sources where memory_id = $1", [saved.id]);
    assert.equal(before.rows[0]?.page_id, page.id); // citation resolved to the page id

    // Rename the page (title -> slug change); the page id is invariant.
    const renamed = await pages.update(page.id, { title: "Specification", html: "<h1>Specification</h1><p>x</p>", actor: "a" });
    assert.equal(renamed?.id, page.id);
    assert.notEqual(renamed?.slug, "spec");

    // The citation still points at the same (now-renamed) page.
    const after = await db.query<{ page_id: string | null }>("select page_id from memory_sources where memory_id = $1", [saved.id]);
    assert.equal(after.rows[0]?.page_id, page.id);
    const stillResolves = await db.query<{ slug: string }>("select slug from pages where id = $1 and deleted_at is null", [page.id]);
    assert.equal(stillResolves.rows[0]?.slug, renamed?.slug); // same id, new slug

    const recall = await memory.recall("decided per the spec");
    assert.equal(recall.results.some((r) => r.sourceId === saved.id), true);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

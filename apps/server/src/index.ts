import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createDb } from "@company-brain/db";
import { createMemoryStore } from "@company-brain/memory";
import { createPageStore } from "@company-brain/pages";

const pageInput = z.object({
  title: z.string().min(1),
  html: z.string().min(1),
  actor: z.string().min(1).optional()
});
const pageActionInput = z.object({
  actor: z.string().min(1).optional()
});
const pageMoveInput = z.object({
  parentPageId: z.string().min(1).nullable().optional(),
  actor: z.string().min(1).optional()
});
const searchInput = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const artifactInput = z.object({
  sourceType: z.string().min(1),
  title: z.string().min(1),
  rawText: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  actor: z.string().min(1).optional()
});
const memorySourceInput = z.object({
  sourceType: z.enum(["page", "page_chunk", "artifact", "source_chunk", "manual"]),
  pageId: z.string().min(1).nullable().optional(),
  pageChunkId: z.string().min(1).nullable().optional(),
  artifactId: z.string().min(1).nullable().optional(),
  sourceChunkId: z.string().min(1).nullable().optional(),
  quote: z.string().nullable().optional()
});
const memoryInput = z.object({
  kind: z.enum(["fact", "decision", "preference", "status", "contradiction"]),
  content: z.string().min(1),
  subject: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  actor: z.string().min(1).optional(),
  sources: z.array(memorySourceInput).optional()
});
const recallInput = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  mode: z.enum(["bm25_local_v1", "lexical_v1"]).optional()
});
const memoryListInput = z.object({
  status: z.enum(["active", "superseded", "forgotten"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const app = new Hono();
const db = await createDb();
const pages = await createPageStore(db);
const memory = await createMemoryStore(db);

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({ ok: true });
});

app.get("/api/pages", async (c) => {
  return c.json({ pages: await pages.list() });
});

app.get("/api/search/pages", async (c) => {
  const input = searchInput.parse({ q: c.req.query("q"), limit: c.req.query("limit") });
  return c.json({ results: await pages.search(input.q, input.limit) });
});

app.post("/api/workspace/init", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  return c.json({ pages: await pages.ensureParaWorkspace(body.actor) }, 201);
});

app.post("/api/projects", async (c) => {
  const body = z
    .object({
      name: z.string().min(1),
      actor: z.string().min(1).optional()
    })
    .parse(await c.req.json());
  return c.json({ pages: await pages.createProject(body.name, body.actor) }, 201);
});

app.get("/api/recall", async (c) => {
  const input = recallInput.parse({ q: c.req.query("q"), limit: c.req.query("limit"), mode: c.req.query("mode") });
  return c.json(await memory.recall(input.q, input.limit, input.mode));
});

app.post("/api/source-artifacts", async (c) => {
  const body = artifactInput.parse(await c.req.json());
  const artifact = await memory.ingestArtifact(body);
  return c.json({ artifact }, 201);
});

app.post("/api/source-artifacts/:id/forget", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const artifact = await memory.forgetArtifact(c.req.param("id"), body.actor);
  if (!artifact) {
    return c.json({ error: "Source artifact not found" }, 404);
  }

  return c.json({ artifact });
});

app.post("/api/memories", async (c) => {
  const body = memoryInput.parse(await c.req.json());
  const savedMemory = await memory.saveMemory({
    ...body,
    sources: body.sources?.map((source) => ({
      sourceType: source.sourceType,
      pageId: source.pageId ?? null,
      pageChunkId: source.pageChunkId ?? null,
      artifactId: source.artifactId ?? null,
      sourceChunkId: source.sourceChunkId ?? null,
      quote: source.quote ?? null
    }))
  });
  return c.json({ memory: savedMemory }, 201);
});

app.get("/api/memories", async (c) => {
  const input = memoryListInput.parse({ status: c.req.query("status"), limit: c.req.query("limit") });
  return c.json({ memories: await memory.listMemories(input) });
});

app.get("/api/memories/:id", async (c) => {
  const savedMemory = await memory.getMemory(c.req.param("id"));
  if (!savedMemory) {
    return c.json({ error: "Memory not found" }, 404);
  }

  return c.json({ memory: savedMemory });
});

app.post("/api/memories/:id/forget", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const savedMemory = await memory.forgetMemory(c.req.param("id"), body.actor);
  if (!savedMemory) {
    return c.json({ error: "Memory not found" }, 404);
  }

  return c.json({ memory: savedMemory });
});

app.get("/api/pages/:id", async (c) => {
  const page = await pages.getWithRelations(c.req.param("id"));
  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ page });
});

app.get("/api/pages/:id/versions", async (c) => {
  const versions = await pages.listVersions(c.req.param("id"));
  if (!versions) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ versions });
});

app.get("/api/pages/:id/versions/:versionId", async (c) => {
  const version = await pages.getVersion(c.req.param("id"), c.req.param("versionId"));
  if (!version) {
    return c.json({ error: "Page version not found" }, 404);
  }

  return c.json({ version });
});

app.post("/api/pages/:id/versions/:versionId/restore", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const page = await pages.restoreVersion(c.req.param("id"), c.req.param("versionId"), body.actor);
  if (!page) {
    return c.json({ error: "Page version not found" }, 404);
  }

  return c.json({ page });
});

app.post("/api/pages", async (c) => {
  const body = pageInput.parse(await c.req.json());
  const page = await pages.create(body);
  return c.json({ page }, 201);
});

app.put("/api/pages/:id", async (c) => {
  const body = pageInput.partial().parse(await c.req.json());
  const page = await pages.update(c.req.param("id"), body);
  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ page });
});

app.delete("/api/pages/:id", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const page = await pages.softDelete(c.req.param("id"), body.actor);
  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ page });
});

app.post("/api/pages/:id/duplicate", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const page = await pages.duplicate(c.req.param("id"), body.actor);
  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ page }, 201);
});

app.post("/api/pages/:id/move", async (c) => {
  const body = pageMoveInput.parse(await c.req.json().catch(() => ({})));
  try {
    const page = await pages.move(c.req.param("id"), body);
    if (!page) {
      return c.json({ error: "Page not found" }, 404);
    }

    return c.json({ page });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Page move failed" }, 400);
  }
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Company Brain server listening on http://localhost:${info.port}`);
});

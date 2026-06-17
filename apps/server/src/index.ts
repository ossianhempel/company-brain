import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createDb } from "@company-brain/db";
import { createGitWriter, WorkspaceConflictError } from "@company-brain/git-writer";
import { createWorkspace, resolveWorkspaceDir } from "@company-brain/workspace";
import { createMemoryStore, reindexAllEntities } from "@company-brain/memory";
import { createPageStore, reindexAllPages } from "@company-brain/pages";
import {
  createAgentStore,
  createProviderRegistry,
  createScheduler,
  reindexAllAgentAreas,
  claudeLocalProvider,
  codexLocalProvider,
} from "@company-brain/agents";

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
const pageCommentInput = z.object({
  body: z.string().min(1),
  anchorText: z.string().min(1).nullable().optional(),
  actor: z.string().min(1).optional()
});
const pageShareInput = z.object({
  label: z.string().min(1).optional(),
  accessLevel: z.enum(["view", "comment"]).optional(),
  password: z.string().min(1).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  actor: z.string().min(1).optional()
});
const pagePermissionInput = z.object({
  visibility: z.enum(["workspace", "restricted", "public"]).optional(),
  owner: z.string().min(1).optional(),
  permissionNote: z.string().nullable().optional(),
  actor: z.string().min(1).optional()
});
const pageSourceInput = z.object({
  sourceType: z.string().min(1),
  title: z.string().min(1),
  rawText: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  actor: z.string().min(1).optional()
});
const pageSourceAttachInput = z.object({
  artifactId: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
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

// Files+git are canonical; the DB is the derived index. The server is the
// single writer to the workspace git repo.
const workspaceDir = resolveWorkspaceDir();
const workspace = createWorkspace({ workspaceDir });
const gitWriter = createGitWriter({ workspaceDir });
const pages = await createPageStore(db, { gitWriter, workspace });
const memory = await createMemoryStore(db, { gitWriter, workspace });

// Agent runtime: provider registry (local-CLI providers), the agent store, and
// the in-process scheduler. The scheduler can run installed agent CLIs on a
// schedule, so it is opt-out via COMPANY_BRAIN_DISABLE_SCHEDULER for operators
// who don't want host execution.
const providers = createProviderRegistry();
providers.register(claudeLocalProvider());
providers.register(codexLocalProvider());
const agents = await createAgentStore(db, { gitWriter, workspace, providers });
const scheduler = createScheduler({
  store: agents,
  runAgent: (input) => agents.runAgent(input),
  workspaceDir,
  reindex: () => reindexAllAgentAreas(db, workspace),
});
if (process.env.COMPANY_BRAIN_DISABLE_SCHEDULER !== "1") {
  await scheduler.start();
}

// CORS is closed to cross-origin by default. The agent runtime can spawn local
// agent CLIs (host execution); a wide-open policy would let any web page the
// operator visits drive the API cross-origin (e.g. trigger agent runs). The
// same-origin web app and non-browser CLI/MCP clients are unaffected; operators
// expose specific origins via COMPANY_BRAIN_ALLOWED_ORIGINS (comma-separated).
// NOTE: this is hardening, not authentication — authn/RBAC is Phase 5, and the
// server must not be exposed to untrusted networks until then.
const allowedOrigins = (process.env.COMPANY_BRAIN_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("*", cors({ origin: (origin) => (allowedOrigins.includes(origin) ? origin : null) }));

// Optimistic-concurrency conflicts from the git writer map to HTTP 409.
app.onError((err, c) => {
  if (err instanceof WorkspaceConflictError) {
    return c.json({ error: "conflict", message: err.message }, 409);
  }
  console.error(err);
  return c.json({ error: "internal", message: err instanceof Error ? err.message : "error" }, 500);
});

app.get("/health", (c) => {
  return c.json({ ok: true });
});

// Rebuild the derived index from the workspace files (admin/recovery).
app.post("/api/admin/reindex", async (c) => {
  await reindexAllPages(db, workspace);
  await reindexAllEntities(db, workspace);
  await reindexAllAgentAreas(db, workspace);
  return c.json({ ok: true });
});

// --- Agent runtime: agents, jobs, conversations, providers ------------------

app.get("/api/agents", async (c) => {
  return c.json({ agents: await agents.listAgents() });
});

app.get("/api/agents/:slug", async (c) => {
  const agent = await agents.getAgent(c.req.param("slug"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  return c.json({ agent });
});

app.get("/api/agents/:slug/file", async (c) => {
  const file = await agents.getAgentFile(c.req.param("slug"));
  if (!file) return c.json({ error: "Agent file not found" }, 404);
  return c.json(file);
});

app.put("/api/agents/:slug/file", async (c) => {
  const body = z.object({ markdown: z.string(), actor: z.string().min(1).optional() }).parse(await c.req.json());
  const agent = await agents.saveAgentFile(c.req.param("slug"), body.markdown, body.actor);
  return c.json({ agent });
});

// Executes the agent's configured provider (may spawn a local CLI). Unauthenticated
// like the rest of the API today — authn/RBAC is Phase 5; CORS is closed cross-origin
// (above) so a browser drive-by can't reach this, and the server must stay off
// untrusted networks until Phase 5.
app.post("/api/agents/:slug/run", async (c) => {
  const body = z
    .object({ prompt: z.string().min(1), provider: z.string().optional(), actor: z.string().min(1).optional() })
    .parse(await c.req.json());
  try {
    const conversation = await agents.runAgent({
      agentSlug: c.req.param("slug"),
      prompt: body.prompt,
      providerOverride: body.provider,
      actor: body.actor,
    });
    return c.json({ conversation });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "run failed" }, 404);
  }
});

app.get("/api/jobs", async (c) => {
  return c.json({ jobs: await agents.listJobs() });
});

app.get("/api/jobs/:slug", async (c) => {
  const job = await agents.getJob(c.req.param("slug"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ job });
});

const conversationStatus = z.enum(["running", "awaiting_input", "done", "failed", "archived"]);

app.get("/api/conversations", async (c) => {
  const statusParam = c.req.query("status");
  const parsedStatus = conversationStatus.safeParse(statusParam);
  const conversations = await agents.listConversations({
    status: parsedStatus.success ? parsedStatus.data : undefined,
    agent: c.req.query("agent") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
  return c.json({ conversations });
});

app.get("/api/conversations/:id", async (c) => {
  const conversation = await agents.getConversation(c.req.param("id"));
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ conversation });
});

app.get("/api/providers", async (c) => {
  return c.json({ providers: await providers.detectAll() });
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

app.get("/api/entities", async (c) => {
  const type = c.req.query("type") || undefined;
  return c.json({ entities: await memory.listEntities({ type }) });
});

app.get("/api/entities/:slug", async (c) => {
  const profile = await memory.getProfile(c.req.param("slug"));
  if (!profile) {
    return c.json({ error: "Entity not found" }, 404);
  }
  return c.json(profile);
});

app.get("/api/entities/:slug/file", async (c) => {
  const file = await memory.getEntityFile(c.req.param("slug"));
  if (!file) {
    return c.json({ error: "Entity file not found" }, 404);
  }
  return c.json(file);
});

app.put("/api/entities/:slug/file", async (c) => {
  const body = z
    .object({ markdown: z.string(), actor: z.string().min(1).optional() })
    .parse(await c.req.json());
  const profile = await memory.saveEntityFile(c.req.param("slug"), body.markdown, body.actor);
  return c.json(profile);
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

app.post("/api/pages/:id/comments", async (c) => {
  const body = pageCommentInput.parse(await c.req.json());
  try {
    const comment = await pages.addComment(c.req.param("id"), body);
    if (!comment) {
      return c.json({ error: "Page not found" }, 404);
    }

    return c.json({ comment }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Comment failed" }, 400);
  }
});

app.delete("/api/pages/:id/comments/:commentId", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const comment = await pages.deleteComment(c.req.param("id"), c.req.param("commentId"), body.actor);
  if (!comment) {
    return c.json({ error: "Comment not found" }, 404);
  }

  return c.json({ comment });
});

app.post("/api/pages/:id/share-links", async (c) => {
  const body = pageShareInput.parse(await c.req.json().catch(() => ({})));
  const shareLink = await pages.createShareLink(c.req.param("id"), body);
  if (!shareLink) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ shareLink }, 201);
});

app.post("/api/pages/:id/share-links/:shareLinkId/revoke", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const shareLink = await pages.revokeShareLink(c.req.param("id"), c.req.param("shareLinkId"), body.actor);
  if (!shareLink) {
    return c.json({ error: "Share link not found" }, 404);
  }

  return c.json({ shareLink });
});

app.put("/api/pages/:id/permissions", async (c) => {
  const body = pagePermissionInput.parse(await c.req.json());
  const page = await pages.updatePermissions(c.req.param("id"), body);
  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ page });
});

app.post("/api/pages/:id/source-artifacts", async (c) => {
  const body = pageSourceInput.parse(await c.req.json());
  const source = await pages.createAndAttachSourceArtifact(c.req.param("id"), body);
  if (!source) {
    return c.json({ error: "Page not found" }, 404);
  }

  return c.json({ source }, 201);
});

app.post("/api/pages/:id/source-artifacts/attach", async (c) => {
  const body = pageSourceAttachInput.parse(await c.req.json());
  try {
    const source = await pages.attachSourceArtifact(c.req.param("id"), body);
    if (!source) {
      return c.json({ error: "Page not found" }, 404);
    }

    return c.json({ source }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Source attach failed" }, 400);
  }
});

app.delete("/api/pages/:id/source-artifacts/:sourceId", async (c) => {
  const body = pageActionInput.parse(await c.req.json().catch(() => ({})));
  const source = await pages.detachSourceArtifact(c.req.param("id"), c.req.param("sourceId"), body.actor);
  if (!source) {
    return c.json({ error: "Page source not found" }, 404);
  }

  return c.json({ source });
});

const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Company Brain server listening on http://localhost:${info.port}`);
});

async function shutdown() {
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

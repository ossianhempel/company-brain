import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { newAgent, buildAgentFile } from "./agent-file.ts";
import { buildConversationFile, type ConversationDoc } from "./conversation-file.ts";
import {
  reindexAgents,
  reindexJobs,
  reindexConversations,
  reindexAllAgents,
  agentAreasCommitHook,
} from "./index.ts";

const NOW = "2026-06-18T00:00:00.000Z";

async function withIndex<T>(
  run: (db: Awaited<ReturnType<typeof createDb>>, ws: ReturnType<typeof createWorkspace>) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-agents-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-agents-db-"));
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

async function writeAgentDoc(ws: ReturnType<typeof createWorkspace>, slug: string, doc = newAgent({ id: "ag-" + slug, name: slug, systemPrompt: "Do " + slug })) {
  const file = buildAgentFile(doc);
  await ws.writeAgent(slug, { frontmatter: file.frontmatter, markdown: file.markdown }, NOW);
}

test("reindexAgents indexes, skips unchanged, and updates on edit", async () => {
  await withIndex(async (db, ws) => {
    await writeAgentDoc(ws, "scribe", newAgent({ id: "ag-scribe", name: "Scribe", provider: "claude_local", systemPrompt: "v1" }));
    await reindexAgents(db, ws, ["scribe"]);
    const row = await db.query<{ name: string; provider: string }>("select name, provider from agents where slug = $1", ["scribe"]);
    assert.equal(row.rows[0].name, "Scribe");
    assert.equal(row.rows[0].provider, "claude_local");

    await reindexAgents(db, ws, ["scribe"]); // unchanged -> skip, no error
    await writeAgentDoc(ws, "scribe", newAgent({ id: "ag-scribe", name: "Scribe 2", systemPrompt: "v2" }));
    await reindexAgents(db, ws, ["scribe"]);
    const updated = await db.query<{ name: string }>("select name from agents where slug = $1", ["scribe"]);
    assert.equal(updated.rows[0].name, "Scribe 2");
  });
});

test("reindexAllAgents tombstones a removed agent and survives a move", async () => {
  await withIndex(async (db, ws) => {
    await writeAgentDoc(ws, "scribe", newAgent({ id: "ag-move", name: "Scribe", systemPrompt: "body" }));
    await reindexAllAgents(db, ws);

    // Move to a nested slug with the same body + id.
    await writeAgentDoc(ws, "team/scribe", newAgent({ id: "ag-move", name: "Scribe", systemPrompt: "body" }));
    await ws.deleteAgent("scribe");
    await reindexAllAgents(db, ws);
    const live = await db.query<{ slug: string }>("select slug from agents where id = $1 and deleted_at is null", ["ag-move"]);
    assert.equal(live.rows.length, 1);
    assert.equal(live.rows[0].slug, "team/scribe"); // moved, not tombstoned

    // Remove entirely.
    await ws.deleteAgent("team/scribe");
    await reindexAllAgents(db, ws);
    const gone = await db.query<{ n: string }>("select count(*) as n from agents where id = $1 and deleted_at is null", ["ag-move"]);
    assert.equal(Number(gone.rows[0].n), 0);
  });
});

test("reindexJobs indexes a valid job and tombstones an invalid one", async () => {
  await withIndex(async (db, ws) => {
    await ws.writeJob("nightly", `name: Nightly\nschedule: "0 2 * * *"\nagent: scribe\nprompt: go\n`);
    await reindexJobs(db, ws, ["nightly"]);
    const row = await db.query<{ agent_slug: string; schedule: string }>("select agent_slug, schedule from jobs where slug = $1", ["nightly"]);
    assert.equal(row.rows[0].agent_slug, "scribe");
    assert.equal(row.rows[0].schedule, "0 2 * * *");

    // Break the file (invalid cron) -> reindex tombstones the prior row.
    await ws.writeJob("nightly", `name: Nightly\nschedule: "bogus"\nagent: scribe\nprompt: go\n`);
    await reindexJobs(db, ws, ["nightly"]);
    const live = await db.query<{ n: string }>("select count(*) as n from jobs where slug = $1 and deleted_at is null", ["nightly"]);
    assert.equal(Number(live.rows[0].n), 0);
  });
});

test("reindexConversations indexes a transcript row", async () => {
  await withIndex(async (db, ws) => {
    const doc: ConversationDoc = {
      id: "c1",
      agent: "scribe",
      status: "done",
      provider: "claude_local",
      startedAt: NOW,
      usage: { outputTokens: 10 },
      turns: [{ role: "agent", content: "done" }],
    };
    const file = buildConversationFile(doc);
    await ws.writeConversation("c1", { frontmatter: file.frontmatter, markdown: file.markdown }, NOW);
    await reindexConversations(db, ws, ["c1"]);
    const row = await db.query<{ status: string; agent_slug: string; usage_json: string }>(
      "select status, agent_slug, usage_json from conversations where id = $1",
      ["c1"]
    );
    assert.equal(row.rows[0].status, "done");
    assert.equal(row.rows[0].agent_slug, "scribe");
    assert.match(row.rows[0].usage_json, /outputTokens/);
  });
});

test("agentAreasCommitHook routes a multi-area commit to the right reindexers", async () => {
  await withIndex(async (db, ws) => {
    await writeAgentDoc(ws, "scribe", newAgent({ id: "ag-h", name: "Scribe", systemPrompt: "x" }));
    await ws.writeJob("nightly", `schedule: "* * * * *"\nagent: scribe\nprompt: go\n`);
    const hook = agentAreasCommitHook(db, ws);
    await hook({ paths: ["agents/scribe.md", "jobs/nightly.yaml", "pages/unrelated.md"] });
    const a = await db.query<{ n: string }>("select count(*) as n from agents where slug = $1 and deleted_at is null", ["scribe"]);
    const j = await db.query<{ n: string }>("select count(*) as n from jobs where slug = $1 and deleted_at is null", ["nightly"]);
    assert.equal(Number(a.rows[0].n), 1);
    assert.equal(Number(j.rows[0].n), 1);
  });
});

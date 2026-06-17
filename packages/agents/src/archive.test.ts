import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { createGitWriter } from "@company-brain/git-writer";
import { createAgentStore, type ConversationDoc } from "./index.ts";

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof createAgentStore>>, db: Awaited<ReturnType<typeof createDb>>) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-arch-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-arch-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  const gw = createGitWriter({ workspaceDir: wsDir });
  try {
    return await run(await createAgentStore(db, { gitWriter: gw, workspace: ws }), db);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

const doneConv = (id: string): ConversationDoc => ({
  id,
  agent: "scribe",
  status: "done",
  provider: "claude_local",
  startedAt: "2026-06-18T00:00:00.000Z",
  turns: [{ role: "agent", content: "ok" }],
});

test("archiveConversation moves a done conversation to archived (file + row)", async () => {
  await withStore(async (store) => {
    await store.saveConversation(doneConv("c1"));
    const archived = await store.archiveConversation("c1");
    assert.equal(archived?.status, "archived");

    // leaves the active lanes
    const active = await store.listConversations({ status: "done" });
    assert.equal(active.some((c) => c.id === "c1"), false);
    const arch = await store.listConversations({ status: "archived" });
    assert.equal(arch.some((c) => c.id === "c1"), true);

    // transcript still parses (turns preserved)
    const full = await store.getConversation("c1");
    assert.equal(full?.turns.length, 1);
  });
});

test("archiveConversation is idempotent and null for a missing id", async () => {
  await withStore(async (store) => {
    assert.equal(await store.archiveConversation("nope"), null);
    await store.saveConversation(doneConv("c2"));
    await store.archiveConversation("c2");
    const again = await store.archiveConversation("c2"); // already archived
    assert.equal(again?.status, "archived");
  });
});

test("archive returns a file-derived conversation when the index row is missing", async () => {
  await withStore(async (store, db) => {
    await store.saveConversation(doneConv("c3"));
    // Simulate a stale/missing derived index: drop the row but keep the file.
    await db.query("delete from conversations where id = $1", ["c3"]);
    const archived = await store.archiveConversation("c3");
    assert.ok(archived); // not a spurious null/404
    assert.equal(archived.id, "c3");
    assert.equal(archived.status, "archived");
  });
});

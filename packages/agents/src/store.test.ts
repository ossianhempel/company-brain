import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { createGitWriter } from "@company-brain/git-writer";
import { createAgentStore, type ConversationDoc } from "./index.ts";

const NOW = "2026-06-18T00:00:00.000Z";

async function withStore<T>(
  run: (store: Awaited<ReturnType<typeof createAgentStore>>, ws: ReturnType<typeof createWorkspace>, gw: ReturnType<typeof createGitWriter>) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-agentstore-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-agentstore-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  const gw = createGitWriter({ workspaceDir: wsDir });
  try {
    const store = await createAgentStore(db, { gitWriter: gw, workspace: ws });
    return await run(store, ws, gw);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

test("saveAgentFile writes an agent through the writer and it indexes via the hook", async () => {
  await withStore(async (store) => {
    await store.saveAgentFile("scribe", "You are the scribe. Keep notes concise.", "alice");
    const agent = await store.getAgent("scribe");
    assert.ok(agent);
    assert.equal(agent.slug, "scribe");
    assert.equal((await store.listAgents()).some((a) => a.slug === "scribe"), true);

    const file = await store.getAgentFile("scribe");
    assert.match(file?.markdown ?? "", /Keep notes concise\./);
  });
});

test("listJobs reflects a committed job file (hook reindex)", async () => {
  await withStore(async (store, ws, gw) => {
    await gw.enqueue({
      paths: [ws.jobFilePath("nightly")],
      message: "job: nightly",
      actor: { name: "alice" },
      write: async () => {
        await ws.writeJob("nightly", `name: Nightly\nschedule: "0 2 * * *"\nagent: scribe\nprompt: summarize\n`);
      },
    });
    const jobs = await store.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].agent, "scribe");
    assert.equal(jobs[0].schedule, "0 2 * * *");
  });
});

test("saveConversation writes a transcript once and getConversation returns its turns", async () => {
  await withStore(async (store) => {
    const doc: ConversationDoc = {
      id: "c1",
      agent: "scribe",
      job: "nightly",
      status: "done",
      provider: "claude_local",
      startedAt: NOW,
      endedAt: NOW,
      usage: { outputTokens: 12 },
      turns: [
        { role: "user", content: "Summarize." },
        { role: "agent", content: "3 commits." },
      ],
    };
    const saved = await store.saveConversation(doc);
    assert.equal(saved?.status, "done");

    const got = await store.getConversation("c1");
    assert.equal(got?.agent, "scribe");
    assert.equal(got?.job, "nightly");
    assert.deepEqual(got?.usage, { outputTokens: 12 });
    assert.equal(got?.turns.length, 2);
    assert.equal(got?.turns[1].content, "3 commits.");

    const list = await store.listConversations({ status: "done" });
    assert.equal(list.some((c) => c.id === "c1"), true);
    const byAgent = await store.listConversations({ agent: "scribe" });
    assert.equal(byAgent.length, 1);
    const other = await store.listConversations({ agent: "nobody" });
    assert.equal(other.length, 0);
  });
});

test("saveAgentFile gives a new agent a stable id (no churn on re-save)", async () => {
  await withStore(async (store) => {
    await store.saveAgentFile("scribe", "v1");
    const first = await store.getAgent("scribe");
    assert.ok(first?.id);
    await store.saveAgentFile("scribe", "v2"); // edit
    const second = await store.getAgent("scribe");
    assert.equal(second?.id, first?.id); // id is stable across saves/reindex
    const all = await store.listAgents();
    assert.equal(all.filter((a) => a.slug === "scribe").length, 1); // no duplicate row
  });
});

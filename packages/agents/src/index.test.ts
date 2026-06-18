import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";

async function withDb<T>(run: (db: Awaited<ReturnType<typeof createDb>>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "company-brain-agents-db-"));
  const db = await createDb(dir);
  try {
    return await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("migration 13: agents, jobs, conversations tables are usable", async () => {
  await withDb(async (db) => {
    await db.query("insert into agents (id, slug, name, provider, enabled) values ($1,$2,$3,$4,true)", [
      "ag1",
      "scribe",
      "Scribe",
      "claude_local",
    ]);
    await db.query("insert into jobs (id, slug, name, schedule, agent_slug) values ($1,$2,$3,$4,$5)", [
      "nightly",
      "nightly",
      "Nightly",
      "0 2 * * *",
      "scribe",
    ]);
    await db.query(
      "insert into conversations (id, agent_slug, status, provider, started_at) values ($1,$2,$3,$4, now())",
      ["c1", "scribe", "done", "claude_local"]
    );

    const a = await db.query<{ name: string }>("select name from agents where slug = $1", ["scribe"]);
    assert.equal(a.rows[0].name, "Scribe");
    const j = await db.query<{ agent_slug: string }>("select agent_slug from jobs where slug = $1", ["nightly"]);
    assert.equal(j.rows[0].agent_slug, "scribe");
    const c = await db.query<{ status: string }>("select status from conversations where agent_slug = $1", ["scribe"]);
    assert.equal(c.rows[0].status, "done");
  });
});

test("migration 13: live-only unique slug index allows a tombstoned + live agent", async () => {
  await withDb(async (db) => {
    await db.query("insert into agents (id, slug, name, deleted_at) values ($1,$2,$3, now())", ["old", "scribe", "Old"]);
    // a live row with the same slug must be allowed alongside the tombstoned one
    await db.query("insert into agents (id, slug, name) values ($1,$2,$3)", ["new", "scribe", "New"]);
    const live = await db.query<{ id: string }>("select id from agents where slug = $1 and deleted_at is null", ["scribe"]);
    assert.equal(live.rows.length, 1);
    assert.equal(live.rows[0].id, "new");
  });
});

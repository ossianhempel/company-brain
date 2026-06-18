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

test("migration 14: users/sessions/role_grants + suggestions tables are usable", async () => {
  await withDb(async (db) => {
    await db.query("insert into users (id, name, email, role) values ($1,$2,$3,$4)", ["u1", "Ada", "ada@x.io", "admin"]);
    await db.query("insert into sessions (id, user_id, expires_at) values ($1,$2, now())", ["s1", "u1"]);
    await db.query("insert into role_grants (id, user_id, scope, role) values ($1,$2,'workspace','editor')", ["g1", "u1"]);
    await db.query(
      "insert into suggestions (id, slug, target_page_id, author, status, title) values ($1,$2,$3,$4,'open',$5)",
      ["sg1", "fix-home", "page-home", "ada", "Fix home"]
    );
    const u = await db.query<{ role: string }>("select role from users where id = $1", ["u1"]);
    assert.equal(u.rows[0].role, "admin");
    const sg = await db.query<{ status: string }>("select status from suggestions where slug = $1", ["fix-home"]);
    assert.equal(sg.rows[0].status, "open");
    // live-only unique slug: a tombstoned + live suggestion can share a slug
    await db.query("update suggestions set deleted_at = now() where id = $1", ["sg1"]);
    await db.query("insert into suggestions (id, slug, target_page_id, author, status, title) values ($1,$2,$3,$4,'open',$5)", ["sg2", "fix-home", "page-home", "bob", "Fix home again"]);
    const live = await db.query<{ id: string }>("select id from suggestions where slug = $1 and deleted_at is null", ["fix-home"]);
    assert.equal(live.rows.length, 1);
    assert.equal(live.rows[0].id, "sg2");
  });
});

test("migration 15: chunk_embeddings is portable (no vector extension) + stable key", async () => {
  await withDb(async (db) => {
    await db.query(
      "insert into chunk_embeddings (chunk_type, owner_id, chunk_index, model, dim, vector_json, content_hash) values ($1,$2,$3,$4,$5,$6,$7)",
      ["page_chunk", "page-1", 0, "test-embed-v1", 3, JSON.stringify([0.1, 0.2, 0.3]), "h1"]
    );
    const row = await db.query<{ vector_json: string; dim: number }>(
      "select vector_json, dim from chunk_embeddings where chunk_type=$1 and owner_id=$2 and chunk_index=$3 and model=$4",
      ["page_chunk", "page-1", 0, "test-embed-v1"]
    );
    assert.equal(row.rows[0].dim, 3);
    assert.deepEqual(JSON.parse(row.rows[0].vector_json), [0.1, 0.2, 0.3]);
    // stable key: re-upsert on the same (type,owner,index,model) updates in place (no dup)
    await db.query(
      `insert into chunk_embeddings (chunk_type, owner_id, chunk_index, model, dim, vector_json, content_hash)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (chunk_type, owner_id, chunk_index, model) do update set vector_json = excluded.vector_json, content_hash = excluded.content_hash`,
      ["page_chunk", "page-1", 0, "test-embed-v1", 3, JSON.stringify([0.4, 0.5, 0.6]), "h2"]
    );
    const after = await db.query<{ content_hash: string }>(
      "select content_hash from chunk_embeddings where chunk_type=$1 and owner_id=$2 and chunk_index=$3 and model=$4",
      ["page_chunk", "page-1", 0, "test-embed-v1"]
    );
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].content_hash, "h2");
  });
});

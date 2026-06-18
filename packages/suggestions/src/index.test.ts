import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { createGitWriter } from "@company-brain/git-writer";
import { buildSuggestionFile, reindexAllSuggestions, reindexSuggestions, suggestionsCommitHook } from "./index.ts";

async function withCtx<T>(
  run: (ctx: {
    db: Awaited<ReturnType<typeof createDb>>;
    workspace: ReturnType<typeof createWorkspace>;
    gitWriter: ReturnType<typeof createGitWriter>;
  }) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-sug-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-sug-db-"));
  const db = await createDb(dbDir);
  const workspace = createWorkspace({ workspaceDir: wsDir });
  const gitWriter = createGitWriter({ workspaceDir: wsDir });
  gitWriter.addCommitHook(suggestionsCommitHook(db, workspace));
  try {
    return await run({ db, workspace, gitWriter });
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

async function commitSuggestion(ctx: Awaited<Parameters<Parameters<typeof withCtx>[0]>[0]>, id: string, status: "open" | "approved" | "rejected", title = "T") {
  const file = buildSuggestionFile({ id, targetPageId: "page-1", baseOid: "base1", author: "ada", status, title, proposedMarkdown: "# P\n\nbody\n" });
  await ctx.gitWriter.enqueue({
    paths: [ctx.workspace.suggestionFilePath(id)],
    message: `suggestion ${id}`,
    actor: { name: "ada" },
    write: async () => {
      await ctx.workspace.writeSuggestion(id, { frontmatter: file.frontmatter, markdown: file.markdown }, new Date().toISOString());
    },
  });
}

test("commit-hook reindexes a suggestion file into the index", async () => {
  await withCtx(async (ctx) => {
    await commitSuggestion(ctx, "sg1", "open", "Fix intro");
    const row = await ctx.db.query<{ status: string; target_page_id: string; title: string }>(
      "select status, target_page_id, title from suggestions where id = $1 and deleted_at is null",
      ["sg1"]
    );
    assert.equal(row.rows[0]?.status, "open");
    assert.equal(row.rows[0]?.target_page_id, "page-1");
    assert.equal(row.rows[0]?.title, "Fix intro");
  });
});

test("reindex updates status on edit and tombstones a removed file", async () => {
  await withCtx(async (ctx) => {
    await commitSuggestion(ctx, "sg2", "open");
    await commitSuggestion(ctx, "sg2", "approved"); // edit
    let row = await ctx.db.query<{ status: string }>("select status from suggestions where id = $1 and deleted_at is null", ["sg2"]);
    assert.equal(row.rows[0]?.status, "approved");

    // remove the file and run a full reindex → tombstoned
    await ctx.workspace.deleteSuggestion("sg2");
    await reindexAllSuggestions(ctx.db, ctx.workspace);
    row = await ctx.db.query<{ status: string }>("select status from suggestions where id = $1 and deleted_at is null", ["sg2"]);
    assert.equal(row.rows.length, 0);
  });
});

test("reindexSuggestions content_hash skip is a no-op when unchanged", async () => {
  await withCtx(async (ctx) => {
    await commitSuggestion(ctx, "sg3", "open");
    const before = await ctx.db.query<{ updated_at: Date }>("select updated_at from suggestions where id = $1", ["sg3"]);
    await reindexSuggestions(ctx.db, ctx.workspace, ["sg3"]); // unchanged → skip (no updated_at bump)
    const after = await ctx.db.query<{ updated_at: Date }>("select updated_at from suggestions where id = $1", ["sg3"]);
    assert.equal(new Date(after.rows[0].updated_at).getTime(), new Date(before.rows[0].updated_at).getTime());
  });
});

// --- U6: suggest-changes store flow -----------------------------------------
import { createPageStore } from "@company-brain/pages";
import { createSuggestionStore } from "./index.ts";

async function withStores<T>(
  run: (s: {
    db: Awaited<ReturnType<typeof createDb>>;
    pages: Awaited<ReturnType<typeof createPageStore>>;
    suggestions: Awaited<ReturnType<typeof createSuggestionStore>>;
  }) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-sugflow-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-sugflow-db-"));
  const db = await createDb(dbDir);
  const workspace = createWorkspace({ workspaceDir: wsDir });
  const gitWriter = createGitWriter({ workspaceDir: wsDir });
  const pages = await createPageStore(db, { gitWriter, workspace });
  gitWriter.addCommitHook(suggestionsCommitHook(db, workspace));
  let n = 0;
  const suggestions = await createSuggestionStore(db, { gitWriter, workspace, pages, newId: () => `sg-${++n}` });
  try {
    return await run({ db, pages, suggestions });
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

test("create → open suggestion listed; approve applies the proposed body to the page", async () => {
  await withStores(async ({ pages, suggestions }) => {
    const page = await pages.create({ title: "Home", html: "<h1>Home</h1><p>old</p>", actor: "owner" });
    const sug = await suggestions.create({ targetPageId: page.id, proposedMarkdown: "# Home\n\nshiny new body\n", title: "Refresh", author: "ada" });
    assert.ok(sug);
    const open = await suggestions.list({ status: "open" });
    assert.equal(open.length, 1);

    const approved = await suggestions.approve(sug!.id, "boss");
    assert.equal(approved?.status, "approved");
    // the target page now carries the proposed content (applied via the single writer)
    const updated = await pages.get(page.id);
    assert.match(updated!.plainText, /shiny new body/);
    // and it left the open queue
    assert.equal((await suggestions.list({ status: "open" })).length, 0);
  });
});

test("reject leaves the target page unchanged", async () => {
  await withStores(async ({ pages, suggestions }) => {
    const page = await pages.create({ title: "Doc", html: "<h1>Doc</h1><p>keep me</p>", actor: "owner" });
    const sug = await suggestions.create({ targetPageId: page.id, proposedMarkdown: "# Doc\n\nrejected body\n", title: "X", author: "ada" });
    const rejected = await suggestions.reject(sug!.id, "boss");
    assert.equal(rejected?.status, "rejected");
    const after = await pages.get(page.id);
    assert.match(after!.plainText, /keep me/);
    assert.doesNotMatch(after!.plainText, /rejected body/);
  });
});

test("approving a stale suggestion conflicts (target changed since base)", async () => {
  await withStores(async ({ pages, suggestions }) => {
    const page = await pages.create({ title: "Race", html: "<h1>Race</h1><p>v1</p>", actor: "owner" });
    const sug = await suggestions.create({ targetPageId: page.id, proposedMarkdown: "# Race\n\nfrom-suggestion\n", title: "S", author: "ada" });
    // someone edits the page directly after the proposal was drafted
    const v1 = await pages.pageVersion(page.slug);
    await pages.update(page.id, { html: "<h1>Race</h1><p>v2</p>", actor: "owner", baseVersion: v1 });
    // approving now must conflict rather than clobber the v2 edit
    await assert.rejects(() => suggestions.approve(sug!.id, "boss"), /Stale write|conflict/i);
  });
});

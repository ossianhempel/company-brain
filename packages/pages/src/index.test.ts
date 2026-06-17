import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb, type CompanyBrainDb } from "@company-brain/db";
import { createGitWriter } from "@company-brain/git-writer";
import { createWorkspace } from "@company-brain/workspace";
import { createPageStore, reindexAllPages } from "./index.ts";

/** Harness for file-canonical mode: separate temp dirs for git workspace + db. */
async function withFilePageStore<T>(
  run: (
    pages: Awaited<ReturnType<typeof createPageStore>>,
    ctx: { db: CompanyBrainDb; workspace: ReturnType<typeof createWorkspace>; gitWriter: ReturnType<typeof createGitWriter>; wsDir: string }
  ) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "company-brain-pages-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "company-brain-pages-db-"));
  const db = await createDb(dbDir);
  const workspace = createWorkspace({ workspaceDir: wsDir });
  const gitWriter = createGitWriter({ workspaceDir: wsDir });
  try {
    const pages = await createPageStore(db, { gitWriter, workspace });
    return await run(pages, { db, workspace, gitWriter, wsDir });
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

async function withPageStore<T>(
  run: (pages: Awaited<ReturnType<typeof createPageStore>>, db: CompanyBrainDb) => Promise<T>
) {
  const dataDir = await mkdtemp(join(tmpdir(), "company-brain-pages-test-"));
  const db = await createDb(dataDir);

  try {
    const pages = await createPageStore(db);
    return await run(pages, db);
  } finally {
    await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("creates pages with sanitized HTML, metadata, and searchable chunks", async () => {
  await withPageStore(async (pages) => {
    const page = await pages.create({
      title: "Launch Plan",
      html: '<h1>Launch Plan</h1><script>alert("x")</script><h2>Checklist</h2><p>Prepare customer rollout.</p>',
      actor: "test-agent"
    });

    assert.equal(page.title, "Launch Plan");
    assert.equal(page.slug, "launch-plan");
    assert.equal(page.creator, "test-agent");
    assert.equal(page.createdBy, "test-agent");
    assert.equal(page.updatedBy, "test-agent");
    assert.equal(page.html.includes("<script"), false);
    assert.match(page.plainText, /Prepare customer rollout/);

    const results = await pages.search("customer rollout");
    assert.equal(results.length, 1);
    assert.equal(results[0].pageId, page.id);
    assert.equal(results[0].slug, "launch-plan");
    assert.equal(results[0].headingPath, "Launch Plan / Checklist");
    assert.equal(results[0].matchReason, "body");
  });
});

test("updates title and HTML through the same page action", async () => {
  await withPageStore(async (pages) => {
    const page = await pages.create({
      title: "Untitled page",
      html: "<h1>Draft</h1><p>Original body.</p>",
      actor: "creator"
    });

    const updated = await pages.update(page.id, {
      title: "Operations Handbook",
      html: "<h1>Operations Handbook</h1><p>Updated runbook.</p>",
      actor: "editor"
    });

    assert.ok(updated);
    assert.equal(updated.title, "Operations Handbook");
    assert.equal(updated.slug, "operations-handbook");
    assert.equal(updated.updatedBy, "editor");

    const bySlug = await pages.getBySlug("operations-handbook");
    assert.equal(bySlug?.id, page.id);
    assert.equal(await pages.getBySlug("untitled-page"), null);

    const results = await pages.search("runbook");
    assert.equal(results[0].pageId, page.id);
  });
});

test("keeps generic page titles in sync with the first heading", async () => {
  await withPageStore(async (pages) => {
    const page = await pages.create({
      title: "Untitled page",
      html: "<h1>Customer Onboarding</h1><p>Welcome sequence.</p>",
      actor: "creator"
    });

    assert.equal(page.title, "Customer Onboarding");
    assert.equal(page.slug, "customer-onboarding");

    const updatedFromHeading = await pages.update(page.id, {
      html: "<h1>Customer Success Onboarding</h1><p>Updated sequence.</p>",
      actor: "editor"
    });

    assert.ok(updatedFromHeading);
    assert.equal(updatedFromHeading.title, "Customer Success Onboarding");
    assert.equal(updatedFromHeading.slug, "customer-success-onboarding");
  });
});

test("syncs title changes into the first heading only when the heading still follows the title", async () => {
  await withPageStore(async (pages) => {
    const synced = await pages.create({
      title: "Draft Handbook",
      html: "<h1>New page</h1><p>Body.</p>",
      actor: "creator"
    });
    assert.match(synced.html, /<h1>Draft Handbook<\/h1>/);

    const renamed = await pages.update(synced.id, {
      title: "Team Handbook",
      html: synced.html,
      actor: "editor"
    });
    assert.ok(renamed);
    assert.match(renamed.html, /<h1>Team Handbook<\/h1>/);

    const customHeading = await pages.create({
      title: "Architecture",
      html: "<h1>System Map</h1><p>Body.</p>",
      actor: "creator"
    });
    const renamedCustomHeading = await pages.update(customHeading.id, {
      title: "Architecture Notes",
      html: customHeading.html,
      actor: "editor"
    });
    assert.ok(renamedCustomHeading);
    assert.match(renamedCustomHeading.html, /<h1>System Map<\/h1>/);
  });
});

test("extracts internal links from wiki syntax and WYSIWYG anchors", async () => {
  await withPageStore(async (pages) => {
    const target = await pages.create({
      title: "Target Page",
      html: "<h1>Target Page</h1><p>Destination.</p>",
      actor: "test-agent"
    });
    const wikiSource = await pages.create({
      title: "Wiki Source",
      html: "<p>See [[Target Page|the target]].</p>",
      actor: "test-agent"
    });
    const wysiwygSource = await pages.create({
      title: "WYSIWYG Source",
      html: '<p>See <a href="/pages/target-page" data-page-slug="target-page">Target Page</a>.</p>',
      actor: "test-agent"
    });

    const targetDetail = await pages.getWithRelations(target.id);
    assert.ok(targetDetail);
    assert.deepEqual(
      targetDetail.relatedPages.map((page) => page.slug).sort(),
      [wikiSource.slug, wysiwygSource.slug].sort()
    );

    const wikiDetail = await pages.getWithRelations(wikiSource.id);
    assert.equal(wikiDetail?.outgoingLinks[0]?.targetSlug, "target-page");
    assert.equal(wikiDetail?.outgoingLinks[0]?.targetTitle, "Target Page");

    const wysiwygDetail = await pages.getWithRelations(wysiwygSource.id);
    assert.equal(wysiwygDetail?.outgoingLinks[0]?.targetSlug, "target-page");
    assert.equal(wysiwygDetail?.outgoingLinks[0]?.targetTitle, "Target Page");
  });
});

test("lists, reads, and restores page versions without deleting history", async () => {
  await withPageStore(async (pages) => {
    const page = await pages.create({
      title: "Versioned Page",
      html: "<h1>Versioned Page</h1><p>First body.</p>",
      actor: "creator"
    });
    const firstVersions = await pages.listVersions(page.id);
    assert.equal(firstVersions?.length, 1);
    const initialVersion = firstVersions?.[0];
    assert.ok(initialVersion);
    assert.equal(initialVersion.title, "Versioned Page");
    assert.match(initialVersion.html, /First body/);

    const updated = await pages.update(page.id, {
      title: "Versioned Page Updated",
      html: "<h1>Versioned Page Updated</h1><p>Second body.</p>",
      actor: "editor"
    });
    assert.ok(updated);

    const version = await pages.getVersion(page.id, initialVersion.id);
    assert.equal(version?.id, initialVersion.id);
    assert.match(version?.html ?? "", /First body/);

    const restored = await pages.restoreVersion(page.id, initialVersion.id, "restorer");
    assert.ok(restored);
    assert.equal(restored.title, "Versioned Page");
    assert.equal(restored.updatedBy, "restorer");
    assert.match(restored.html, /First body/);

    const restoredVersions = await pages.listVersions(page.id);
    assert.equal(restoredVersions?.length, 3);
    assert.equal(restoredVersions?.[0]?.createdBy, "restorer");

    const searchResults = await pages.search("First body");
    assert.equal(searchResults[0].pageId, page.id);
  });
});

test("tracks v1 page collaboration data and activity", async () => {
  await withPageStore(async (pages, db) => {
    const page = await pages.create({
      title: "Team Handbook",
      html: "<h1>Team Handbook</h1><p>Operating notes.</p>",
      actor: "owner",
      visibility: "restricted",
      owner: "ops"
    });

    assert.equal(page.visibility, "restricted");
    assert.equal(page.owner, "ops");

    const updatedPermissions = await pages.updatePermissions(page.id, {
      visibility: "workspace",
      owner: "lead",
      permissionNote: "Visible to the default workspace.",
      actor: "admin"
    });
    assert.equal(updatedPermissions?.visibility, "workspace");
    assert.equal(updatedPermissions?.owner, "lead");
    assert.equal(updatedPermissions?.permissionNote, "Visible to the default workspace.");

    const comment = await pages.addComment(page.id, {
      body: "Clarify the escalation owner.",
      anchorText: "Operating notes",
      actor: "reviewer"
    });
    assert.equal(comment?.body, "Clarify the escalation owner.");
    assert.equal(comment?.anchorText, "Operating notes");

    const shareLink = await pages.createShareLink(page.id, {
      label: "Client read-only",
      accessLevel: "view",
      password: "secret",
      actor: "admin"
    });
    assert.equal(shareLink?.label, "Client read-only");
    assert.equal(shareLink?.hasPassword, true);
    assert.equal(shareLink?.revokedAt, null);
    const storedShareLink = await db.query<{ password: string | null; password_hash: string | null }>(
      "select password, password_hash from page_share_links where id = $1",
      [shareLink.id]
    );
    assert.equal(storedShareLink.rows[0]?.password, null);
    assert.notEqual(storedShareLink.rows[0]?.password_hash, "secret");
    assert.match(storedShareLink.rows[0]?.password_hash ?? "", /^scrypt\$/);

    const detail = await pages.getWithRelations(page.id);
    assert.equal(detail?.comments.length, 1);
    assert.equal(detail?.shareLinks.length, 1);
    assert.ok(detail?.activity.some((event) => event.eventType === "comment.created"));
    assert.ok(detail?.activity.some((event) => event.eventType === "permissions.updated"));

    const revoked = await pages.revokeShareLink(page.id, shareLink.id, "admin");
    assert.ok(revoked?.revokedAt);

    const deletedComment = await pages.deleteComment(page.id, comment.id, "reviewer");
    assert.ok(deletedComment?.deletedAt);

    const finalDetail = await pages.getWithRelations(page.id);
    assert.equal(finalDetail?.comments.length, 0);
    assert.equal(finalDetail?.shareLinks[0]?.revokedAt !== null, true);
    assert.ok(finalDetail?.activity.some((event) => event.eventType === "share.revoked"));
  });
});

test("attaches source artifacts to pages and keeps them recall-indexed", async () => {
  await withPageStore(async (pages, db) => {
    const page = await pages.create({
      title: "Client Notes",
      html: "<h1>Client Notes</h1><p>Source-backed context.</p>",
      actor: "owner"
    });

    const source = await pages.createAndAttachSourceArtifact(page.id, {
      sourceType: "meeting_note",
      title: "Kickoff Notes",
      rawText: "The client prefers weekly Friday summaries and wants Azure DevOps links included.",
      label: "Kickoff",
      actor: "researcher"
    });

    assert.equal(source?.title, "Kickoff Notes");
    assert.equal(source?.label, "Kickoff");
    assert.equal(source?.sourceType, "meeting_note");

    const detail = await pages.getWithRelations(page.id);
    assert.equal(detail?.sources.length, 1);
    assert.equal(detail?.sources[0]?.title, "Kickoff Notes");
    assert.ok(detail?.activity.some((event) => event.eventType === "source.attached"));

    const chunks = await db.query<{ count: string }>("select count(*)::text as count from source_chunks where artifact_id = $1", [
      source?.artifactId
    ]);
    assert.equal(Number(chunks.rows[0]?.count ?? 0), 1);

    const detached = await pages.detachSourceArtifact(page.id, source.id, "owner");
    assert.ok(detached?.deletedAt);

    const afterDetach = await pages.getWithRelations(page.id);
    assert.equal(afterDetach?.sources.length, 0);
    assert.ok(afterDetach?.activity.some((event) => event.eventType === "source.detached"));
  });
});

test("creates PARA workspace and project template pages", async () => {
  await withPageStore(async (pages) => {
    const paraPages = await pages.ensureParaWorkspace("test-agent");
    assert.deepEqual(
      paraPages.map((page) => page.slug).sort(),
      ["archive", "areas", "projects", "resources"]
    );
    assert.deepEqual(
      (await pages.list()).slice(0, 5).map((page) => page.slug),
      ["home", "projects", "areas", "resources", "archive"]
    );

    const projectPages = await pages.createProject("Client Portal", "test-agent");
    assert.deepEqual(
      projectPages.map((page) => page.slug).sort(),
      [
        "projects/client-portal/activity-log",
        "projects/client-portal/deadlines",
        "projects/client-portal/decisions",
        "projects/client-portal/links",
        "projects/client-portal/open-questions",
        "projects/client-portal/people",
        "projects/client-portal/start"
      ]
    );

    const repeatedProjectPages = await pages.createProject("Client Portal", "test-agent");
    assert.deepEqual(
      repeatedProjectPages.map((page) => page.id).sort(),
      projectPages.map((page) => page.id).sort()
    );

    await pages.update(projectPages[0].id, {
      title: "Recently Updated Project Start",
      actor: "test-agent"
    });
    assert.deepEqual(
      (await pages.list()).slice(0, 5).map((page) => page.slug),
      ["home", "projects", "areas", "resources", "archive"]
    );

    const areas = paraPages.find((page) => page.slug === "areas");
    assert.ok(areas);
    const moved = await pages.move(projectPages[0].id, {
      parentPageId: areas.id,
      actor: "test-agent"
    });
    assert.equal(moved?.parentPageId, areas.id);

    const topLevel = await pages.move(projectPages[0].id, {
      parentPageId: null,
      actor: "test-agent"
    });
    assert.equal(topLevel?.parentPageId, null);
  });
});

// --- Phase 1: file-canonical mode (U5/U6/U7) -------------------------------

test("file mode: create writes a markdown file and one attributed commit", async () => {
  await withFilePageStore(async (pages, { gitWriter, wsDir }) => {
    const page = await pages.create({
      title: "Launch Plan",
      html: "<h1>Launch Plan</h1><p>Body.</p>",
      actor: "alice"
    });
    assert.equal(existsSync(join(wsDir, "pages", "launch-plan.md")), true);
    const hist = await gitWriter.history("pages/launch-plan.md");
    assert.equal(hist.length, 1);
    assert.equal(hist[0].author.name, "alice");

    await pages.update(page.id, { html: "<h1>Launch Plan</h1><p>Updated.</p>", actor: "bob" });
    const hist2 = await gitWriter.history("pages/launch-plan.md");
    assert.equal(hist2.length, 2);
    assert.equal(hist2[0].author.name, "bob");
  });
});

test("file mode (U5): page id is stable across a rename and the file moves", async () => {
  await withFilePageStore(async (pages, { workspace, wsDir }) => {
    const page = await pages.create({ title: "Original", html: "<h1>Original</h1>", actor: "a" });
    const updated = await pages.update(page.id, { title: "Renamed", html: "<h1>Renamed</h1>", actor: "a" });

    assert.equal(updated?.id, page.id); // id stable
    assert.notEqual(updated?.slug, page.slug); // slug changed
    assert.equal(existsSync(join(wsDir, "pages", "original.md")), false); // old file gone
    assert.equal(existsSync(join(wsDir, "pages", "renamed.md")), true);

    const stored = await workspace.readPage("renamed");
    assert.equal(stored?.frontmatter.id, page.id); // citation key preserved
  });
});

test("file mode (U7): reindexAllPages rebuilds the index from files alone", async () => {
  await withFilePageStore(async (pages, { db, workspace }) => {
    await pages.create({ title: "Alpha", html: "<h1>Alpha</h1><p>alpha body</p>", actor: "a" });
    await pages.create({ title: "Beta", html: "<h1>Beta</h1><p>beta body</p>", actor: "a" });

    // Nuke the derived index entirely.
    await db.query("delete from page_links");
    await db.query("delete from page_chunks");
    await db.query("delete from pages");
    assert.equal((await pages.list()).length, 0);

    await reindexAllPages(db, workspace);

    const list = await pages.list();
    assert.ok(list.find((p) => p.slug === "alpha"));
    assert.ok(list.find((p) => p.slug === "beta"));
    const results = await pages.search("alpha body");
    assert.ok(results.length >= 1);
  });
});

test("file mode (U7): reindex is incremental and tombstones deleted files", async () => {
  await withFilePageStore(async (pages, { db, workspace, wsDir }) => {
    const page = await pages.create({ title: "Doomed", html: "<h1>Doomed</h1><p>x</p>", actor: "a" });
    // Remove the file directly, then reindex its slug -> tombstone.
    await rm(join(wsDir, "pages", "doomed.md"), { force: true });
    await reindexAllPages(db, workspace);
    const row = await db.query<{ deleted_at: string | null }>(
      "select deleted_at from pages where id = $1",
      [page.id]
    );
    assert.notEqual(row.rows[0]?.deleted_at, null);
  });
});

test("file mode (U8): version history is backed by git", async () => {
  await withFilePageStore(async (pages) => {
    const page = await pages.create({ title: "Versioned", html: "<h1>Versioned</h1><p>v1</p>", actor: "a" });
    await pages.update(page.id, { html: "<h1>Versioned</h1><p>v2</p>", actor: "b" });

    const versions = await pages.listVersions(page.id);
    assert.equal(versions?.length, 2); // create + update commits
    assert.equal(versions?.[0].createdBy, "b"); // newest first

    const oldest = versions![versions!.length - 1];
    const got = await pages.getVersion(page.id, oldest.id);
    assert.match(got!.html, /v1/);

    const restored = await pages.restoreVersion(page.id, oldest.id, "a");
    assert.match(restored!.html, /v1/);
    assert.equal((await pages.listVersions(page.id))?.length, 3); // restore adds a commit
  });
});

test("file mode (U8): parentPageId and attribution survive a full reindex", async () => {
  await withFilePageStore(async (pages, { db, workspace }) => {
    const parent = await pages.create({ title: "Parent", html: "<h1>Parent</h1>", actor: "alice" });
    const child = await pages.create({ title: "Child", html: "<h1>Child</h1>", actor: "alice" });
    const moved = await pages.move(child.id, { parentPageId: parent.id, actor: "bob" });
    assert.equal(moved?.parentPageId, parent.id); // move reaches the DB

    // Rebuild the index from files alone.
    await db.query("delete from page_links");
    await db.query("delete from page_chunks");
    await db.query("delete from pages");
    await reindexAllPages(db, workspace);

    const rebuilt = await pages.get(child.id);
    assert.equal(rebuilt?.parentPageId, parent.id); // parent survived the rebuild
    assert.equal(rebuilt?.creator, "alice"); // original creator preserved, not overwritten
  });
});

test("file mode: getVersion attributes to the commit author, not the page owner", async () => {
  await withFilePageStore(async (pages) => {
    // owner differs from the actor so the assertion distinguishes the two.
    const page = await pages.create({ title: "Owned", html: "<h1>Owned</h1><p>v1</p>", actor: "alice", owner: "carol" });
    assert.equal(page.owner, "carol");
    const versions = await pages.listVersions(page.id);
    const got = await pages.getVersion(page.id, versions![0].id);
    assert.equal(got?.createdBy, "alice"); // commit author, not the "carol" owner
  });
});

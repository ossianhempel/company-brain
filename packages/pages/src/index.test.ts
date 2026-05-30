import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createPageStore } from "./index.ts";

async function withPageStore<T>(run: (pages: Awaited<ReturnType<typeof createPageStore>>) => Promise<T>) {
  const dataDir = await mkdtemp(join(tmpdir(), "company-brain-pages-test-"));
  const db = await createDb(dataDir);

  try {
    const pages = await createPageStore(db);
    return await run(pages);
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

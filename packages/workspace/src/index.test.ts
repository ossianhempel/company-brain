import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "./index.ts";

async function withWorkspace<T>(
  run: (ws: ReturnType<typeof createWorkspace>, dir: string) => Promise<T>
) {
  const dir = await mkdtemp(join(tmpdir(), "company-brain-workspace-test-"));
  try {
    return await run(createWorkspace({ workspaceDir: dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NOW = "2026-06-17T00:00:00.000Z";

test("writePage then readPage round-trips frontmatter and body, stamping updated", async () => {
  await withWorkspace(async (ws) => {
    const { frontmatter } = await ws.writePage(
      "engineering/onboarding",
      { frontmatter: { title: "Onboarding", created: "2026-01-01T00:00:00.000Z" }, markdown: "# Onboarding\n\nWelcome.\n" },
      NOW
    );
    assert.match(frontmatter.id, /[0-9a-f-]{36}/);
    assert.equal(frontmatter.updated, NOW);
    assert.equal(frontmatter.created, "2026-01-01T00:00:00.000Z");

    const read = await ws.readPage("engineering/onboarding");
    assert.ok(read);
    assert.equal(read.frontmatter.title, "Onboarding");
    assert.equal(read.frontmatter.id, frontmatter.id);
    assert.match(read.markdown, /Welcome\./);
  });
});

test("htmlToMarkdown(markdownToHtml(md)) is stable across headings, lists, code, tables", async () => {
  await withWorkspace(async (ws) => {
    const md = [
      "# Title",
      "",
      "Some **bold** text.",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    const round = ws.htmlToMarkdown(ws.markdownToHtml(md));
    assert.match(round, /^# Title/m);
    assert.match(round, /\*\*bold\*\*/);
    assert.match(round, /-\s+one/);
    assert.match(round, /-\s+two/);
    assert.match(round, /const x = 1;/);
    assert.match(round, /\| a \| b \|/);
    assert.match(round, /\| 1 \| 2 \|/);
    // Stable: a second round-trip equals the first.
    assert.equal(ws.htmlToMarkdown(ws.markdownToHtml(round)), round);
  });
});

test("htmlToMarkdown strips script content at the HTML boundary", async () => {
  await withWorkspace(async (ws) => {
    const out = ws.htmlToMarkdown('<h1>Launch</h1><script>alert("x")</script><p>Body.</p>');
    assert.match(out, /# Launch/);
    assert.match(out, /Body\./);
    assert.equal(out.includes("alert"), false);
  });
});

test("internal links survive the HTML->markdown->HTML round-trip as [[wiki-links]]", async () => {
  await withWorkspace(async (ws) => {
    const html = '<p>See <a href="/pages/launch-plan" data-page-slug="launch-plan">Launch Plan</a>.</p>';
    const markdown = ws.htmlToMarkdown(html);
    assert.match(markdown, /\[\[Launch Plan\]\]/);
    // Re-rendering keeps the wiki-link literal for the pages layer to resolve.
    assert.match(ws.markdownToHtml(markdown), /\[\[Launch Plan\]\]/);
  });
});

test("sanitizePageHtml strips scripts but keeps allowed tags and data-page-slug", async () => {
  await withWorkspace(async (ws) => {
    const out = ws.sanitizePageHtml(
      '<h1>T</h1><script>x</script><a href="/pages/x" data-page-slug="x">x</a>'
    );
    assert.equal(out.includes("<script"), false);
    assert.match(out, /<h1>T<\/h1>/);
    assert.match(out, /data-page-slug="x"/);
  });
});

test("readPage resolves both standalone and directory-index pages to the same slug", async () => {
  await withWorkspace(async (ws, dir) => {
    // standalone
    await ws.writePage("standalone", { frontmatter: { title: "S" }, markdown: "# S\n" }, NOW);
    assert.ok(await ws.readPage("standalone"));

    // directory page written manually as pages/dir/index.md
    await mkdir(join(dir, "pages", "dir"), { recursive: true });
    await writeFile(
      join(dir, "pages", "dir", "index.md"),
      "---\nid: 11111111-1111-1111-1111-111111111111\ntitle: D\ncreated: " + NOW + "\nupdated: " + NOW + "\n---\n# D\n",
      "utf8"
    );
    const read = await ws.readPage("dir");
    assert.ok(read);
    assert.equal(read.frontmatter.title, "D");
  });
});

test("listPageSlugs walks the pages tree and normalizes slugs", async () => {
  await withWorkspace(async (ws) => {
    await ws.writePage("a", { frontmatter: { title: "A" }, markdown: "# A\n" }, NOW);
    await ws.writePage("nested/b", { frontmatter: { title: "B" }, markdown: "# B\n" }, NOW);
    const slugs = (await ws.listPageSlugs()).sort();
    assert.deepEqual(slugs, ["a", "nested/b"]);
  });
});

test("readPage backfills a stable id for a legacy file without one", async () => {
  await withWorkspace(async (ws, dir) => {
    await mkdir(join(dir, "pages"), { recursive: true });
    await writeFile(join(dir, "pages", "legacy.md"), "---\ntitle: Legacy\n---\n# Legacy\n", "utf8");
    const read = await ws.readPage("legacy");
    assert.ok(read);
    assert.match(read.frontmatter.id, /[0-9a-f-]{36}/);
  });
});

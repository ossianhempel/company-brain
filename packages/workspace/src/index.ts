import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
// turndown-plugin-gfm ships no type declarations; the suppression travels with
// this module into any consuming program (e.g. @company-brain/pages).
// @ts-expect-error untyped module
import { gfm } from "turndown-plugin-gfm";
import sanitizeHtml from "sanitize-html";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceOptions {
  /** Absolute path to the workspace directory. */
  workspaceDir: string;
}

/** Frontmatter persisted at the top of every page file. */
export interface PageFrontmatter {
  /** Stable identity — survives renames/moves so citations stay valid. */
  id: string;
  title: string;
  created: string;
  updated: string;
  tags?: string[];
  order?: number;
  visibility?: string;
  owner?: string;
  // Persisted so the DB index is fully rebuildable from files alone.
  creator?: string;
  createdBy?: string;
  updatedBy?: string;
  parentPageId?: string | null;
  pinnedOrder?: number | null;
  permissionNote?: string | null;
  /** Prior slugs this page has had, so version history follows renames. */
  previousSlugs?: string[];
  [key: string]: unknown;
}

/**
 * Resolve the workspace directory the same way across server and CLI:
 * COMPANY_BRAIN_WORKSPACE_DIR, else `<INIT_CWD|cwd>/data/workspace`.
 */
export function resolveWorkspaceDir(): string {
  return process.env.COMPANY_BRAIN_WORKSPACE_DIR
    ? resolve(process.cwd(), process.env.COMPANY_BRAIN_WORKSPACE_DIR)
    : resolve(process.env.INIT_CWD ?? process.cwd(), "data/workspace");
}

export interface StoredPage {
  frontmatter: PageFrontmatter;
  /** The page body as canonical markdown. */
  markdown: string;
}

/** Subdirectory under the workspace where page files live. */
const PAGES_DIR = "pages";

// Sanitize allowlist mirrors packages/pages `prepareHtml` so the HTML boundary
// is identical whether content arrives from the editor or is re-derived from a
// markdown file during reindex.
export const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "img"]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "name", "target", "rel", "data-page-slug"],
    img: ["src", "alt", "title", "width", "height", "loading"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noreferrer" }, true),
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }, true),
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkspace(options: WorkspaceOptions) {
  const root = options.workspaceDir;

  const md = new MarkdownIt({ html: true, linkify: false, breaks: false });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  // Drop scripts/styles entirely at the HTML boundary.
  turndown.remove(["script", "style"]);
  // Preserve internal links as portable [[wiki-link]] syntax. The slug is
  // re-derived from the link text by the pages layer on the way back to HTML.
  turndown.addRule("wikiLink", {
    filter: (node) =>
      node.nodeName === "A" && node.getAttribute("data-page-slug") !== null,
    replacement: (content) => `[[${content}]]`,
  });

  /** Repo-relative file path for a page slug (slug may be nested, e.g. a/b/c). */
  function pageFilePath(slug: string): string {
    return `${PAGES_DIR}/${slug}.md`;
  }

  function dirIndexPath(slug: string): string {
    return `${PAGES_DIR}/${slug}/index.md`;
  }

  /** Convert sanitized HTML to canonical markdown. */
  function htmlToMarkdown(html: string): string {
    return turndown.turndown(html).trim() + "\n";
  }

  /** Render markdown back to HTML (unsanitized — pass through sanitizePageHtml). */
  function markdownToHtml(markdown: string): string {
    return md.render(markdown);
  }

  /** Apply the page HTML allowlist (same boundary as the editor write path). */
  function sanitizePageHtml(html: string): string {
    return sanitizeHtml(html, SANITIZE_OPTIONS);
  }

  /** Assign a stable id if the frontmatter lacks one (legacy backfill). */
  function ensureId(frontmatter: Partial<PageFrontmatter>): string {
    return frontmatter.id ?? randomUUID();
  }

  /** Parse a raw page file string (e.g. a git blob at a past commit). */
  function parsePage(raw: string): StoredPage {
    const parsed = matter(raw);
    const fm = parsed.data as Partial<PageFrontmatter>;
    return {
      frontmatter: { ...fm, id: ensureId(fm) } as PageFrontmatter,
      markdown: parsed.content.trim() + "\n",
    };
  }

  /**
   * Read a page by slug. Resolves either a standalone `pages/<slug>.md` or a
   * directory page `pages/<slug>/index.md`. Returns null if neither exists.
   */
  async function readPage(slug: string): Promise<StoredPage | null> {
    const candidates = [pageFilePath(slug), dirIndexPath(slug)];
    for (const rel of candidates) {
      const abs = join(root, rel);
      if (!existsSync(abs)) continue;
      const parsed = matter(await readFile(abs, "utf8"));
      const fm = parsed.data as Partial<PageFrontmatter>;
      return {
        frontmatter: { ...fm, id: ensureId(fm) } as PageFrontmatter,
        markdown: parsed.content.trim() + "\n",
      };
    }
    return null;
  }

  /**
   * Write a page file (frontmatter + markdown body), creating parent dirs.
   * Stamps `updated` and guarantees a stable `id`. Returns the repo-relative
   * path written (for explicit-path git staging).
   */
  async function writePage(
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string
  ): Promise<{ relPath: string; frontmatter: PageFrontmatter }> {
    const relPath = pageFilePath(slug);
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });

    const frontmatter: PageFrontmatter = {
      ...input.frontmatter,
      id: ensureId(input.frontmatter),
      title: input.frontmatter.title ?? "Untitled",
      created: input.frontmatter.created ?? now,
      updated: now,
    } as PageFrontmatter;

    const body = input.markdown.trim() + "\n";
    await writeFile(abs, matter.stringify(body, frontmatter), "utf8");
    return { relPath, frontmatter };
  }

  /** Remove a page file. Returns the repo-relative path removed (for staging). */
  async function deletePage(slug: string): Promise<string> {
    const relPath = pageFilePath(slug);
    const abs = join(root, relPath);
    if (existsSync(abs)) await rm(abs, { force: true });
    return relPath;
  }

  /** All page slugs on disk (recursive walk of the pages dir). */
  async function listPageSlugs(): Promise<string[]> {
    const base = join(root, PAGES_DIR);
    if (!existsSync(base)) return [];
    const slugs: string[] = [];
    const walk = async (absDir: string): Promise<void> => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.name.endsWith(".md")) {
          const rel = relative(base, abs).replace(/\\/g, "/");
          const slug = rel.replace(/\/index\.md$/, "").replace(/\.md$/, "");
          slugs.push(slug);
        }
      }
    };
    await walk(base);
    return slugs;
  }

  return {
    pageFilePath,
    htmlToMarkdown,
    markdownToHtml,
    sanitizePageHtml,
    parsePage,
    readPage,
    writePage,
    deletePage,
    listPageSlugs,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

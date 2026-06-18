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
/** Subdirectory under the workspace where entity/memory files live. */
const MEMORY_DIR = "memory";
/** Subdirectory for agent persona files (markdown). */
const AGENTS_DIR = "agents";
/** Subdirectory for scheduled job definitions (YAML). */
const JOBS_DIR = "jobs";
/** Subdirectory for conversation transcripts (markdown, written once). */
const CONVERSATIONS_DIR = "conversations";

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

  // --- Area-aware path helpers ---------------------------------------------
  // An "area" is a top-level workspace subtree (pages/, memory/, …). Page-named
  // wrappers below keep their exact signatures so the pages layer is untouched.

  // Reject slugs that would escape their area (path traversal). Slugs may be
  // nested ("a/b/c") but must not contain "..", "." segments, leading "/", or
  // backslashes. This is the single chokepoint for every path the workspace
  // builds (reads, writes, deletes, and git-staging paths).
  function assertSafeSlug(slug: string): void {
    const norm = slug.replace(/\\/g, "/");
    const unsafe =
      !norm ||
      norm.startsWith("/") ||
      norm.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
    if (unsafe) {
      throw new Error(`Unsafe workspace slug: ${JSON.stringify(slug)}`);
    }
  }

  function areaFilePath(area: string, slug: string): string {
    assertSafeSlug(slug);
    return `${area}/${slug}.md`;
  }
  function areaIndexPath(area: string, slug: string): string {
    assertSafeSlug(slug);
    return `${area}/${slug}/index.md`;
  }

  /** The top-level area a repo-relative path belongs to (e.g. "pages", "memory"). */
  function pathArea(relPath: string): string {
    return relPath.replace(/\\/g, "/").split("/")[0] ?? "";
  }

  /** A repo-relative file path back to its slug, within its area (any area). */
  function slugFromPath(relPath: string): string {
    const norm = relPath.replace(/\\/g, "/");
    const withoutArea = norm.slice(norm.indexOf("/") + 1); // strip leading "<area>/"
    return withoutArea.replace(/\/index\.md$/, "").replace(/\.(md|ya?ml)$/, "");
  }

  /** Repo-relative file path for a page slug (slug may be nested, e.g. a/b/c). */
  function pageFilePath(slug: string): string {
    return areaFilePath(PAGES_DIR, slug);
  }
  function dirIndexPath(slug: string): string {
    return areaIndexPath(PAGES_DIR, slug);
  }
  /** Repo-relative file path for an entity (memory-area) slug. */
  function entityFilePath(slug: string): string {
    return areaFilePath(MEMORY_DIR, slug);
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
   * Read a file by slug within an area. Resolves either `<area>/<slug>.md` or
   * `<area>/<slug>/index.md`, backfilling+persisting a stable id if missing.
   */
  async function readFileIn(area: string, slug: string): Promise<StoredPage | null> {
    const candidates = [areaFilePath(area, slug), areaIndexPath(area, slug)];
    for (const rel of candidates) {
      const abs = join(root, rel);
      if (!existsSync(abs)) continue;
      const parsed = matter(await readFile(abs, "utf8"));
      const fm = parsed.data as Partial<PageFrontmatter>;
      const markdown = parsed.content.trim() + "\n";
      if (!fm.id) {
        // Persist a stable id once, so repeated reads/reindexes of a file that
        // lacked one (e.g. hand-created/imported) don't churn a new id each time.
        const id = randomUUID();
        await writeFile(abs, matter.stringify(markdown, { ...fm, id }), "utf8");
        return { frontmatter: { ...fm, id } as PageFrontmatter, markdown };
      }
      return { frontmatter: fm as PageFrontmatter, markdown };
    }
    return null;
  }

  /**
   * Write a file (frontmatter + markdown body) within an area, creating parent
   * dirs. Stamps `updated` and guarantees a stable `id`. Returns the
   * repo-relative path written (for explicit-path git staging).
   */
  async function writeFileIn(
    area: string,
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string,
    options: { exclusive?: boolean } = {}
  ): Promise<{ relPath: string; frontmatter: PageFrontmatter }> {
    const relPath = areaFilePath(area, slug);
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
    // Exclusive creates fail (EEXIST) rather than overwrite, so a concurrent
    // same-slug create can't clobber an already-written canonical file.
    await writeFile(abs, matter.stringify(body, frontmatter), {
      encoding: "utf8",
      flag: options.exclusive ? "wx" : "w",
    });
    return { relPath, frontmatter };
  }

  /** Remove a file within an area (both standalone and directory-index variants). */
  async function deleteFileIn(area: string, slug: string): Promise<string[]> {
    const removed: string[] = [];
    for (const rel of [areaFilePath(area, slug), areaIndexPath(area, slug)]) {
      const abs = join(root, rel);
      if (existsSync(abs)) {
        await rm(abs, { force: true });
        removed.push(rel);
      }
    }
    return removed;
  }

  // Page-area wrappers (unchanged signatures).
  const readPage = (slug: string) => readFileIn(PAGES_DIR, slug);
  const writePage = (
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string,
    options: { exclusive?: boolean } = {}
  ) => writeFileIn(PAGES_DIR, slug, input, now, options);
  const deletePage = (slug: string) => deleteFileIn(PAGES_DIR, slug);

  // Entity (memory-area) wrappers.
  const readEntity = (slug: string) => readFileIn(MEMORY_DIR, slug);
  const writeEntity = (
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string,
    options: { exclusive?: boolean } = {}
  ) => writeFileIn(MEMORY_DIR, slug, input, now, options);
  const deleteEntity = (slug: string) => deleteFileIn(MEMORY_DIR, slug);

  /** All slugs on disk within an area (recursive walk). */
  async function listSlugsIn(area: string): Promise<string[]> {
    const base = join(root, area);
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

  const listPageSlugs = () => listSlugsIn(PAGES_DIR);
  const listEntitySlugs = () => listSlugsIn(MEMORY_DIR);

  // --- Raw (non-markdown) file IO -----------------------------------------
  // Jobs are YAML; transcripts may carry non-frontmatter content. These reuse
  // the path-safety + git-staging contract but skip frontmatter stamping and
  // the markdown `.md` assumption.

  // area and ext are single path segments (no nesting/traversal) — validate them
  // too, since the raw helpers are public and take them as arguments.
  function assertSafeSegment(value: string, label: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(`Unsafe workspace ${label}: ${JSON.stringify(value)}`);
    }
  }

  function rawFilePath(area: string, slug: string, ext: string): string {
    assertSafeSegment(area, "area");
    assertSafeSegment(ext, "extension");
    assertSafeSlug(slug);
    return `${area}/${slug}.${ext}`;
  }

  async function readRawIn(area: string, slug: string, ext: string): Promise<string | null> {
    const abs = join(root, rawFilePath(area, slug, ext));
    if (!existsSync(abs)) return null;
    return readFile(abs, "utf8");
  }

  async function writeRawIn(
    area: string,
    slug: string,
    ext: string,
    content: string,
    options: { exclusive?: boolean } = {}
  ): Promise<string> {
    const relPath = rawFilePath(area, slug, ext);
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, { encoding: "utf8", flag: options.exclusive ? "wx" : "w" });
    return relPath;
  }

  async function deleteRawIn(area: string, slug: string, ext: string): Promise<string[]> {
    const relPath = rawFilePath(area, slug, ext);
    const abs = join(root, relPath);
    if (existsSync(abs)) {
      await rm(abs, { force: true });
      return [relPath];
    }
    return [];
  }

  /** All slugs on disk within an area whose files carry the given extension. */
  async function listRawIn(area: string, ext: string): Promise<string[]> {
    assertSafeSegment(area, "area");
    assertSafeSegment(ext, "extension");
    const base = join(root, area);
    if (!existsSync(base)) return [];
    const suffix = `.${ext}`;
    const slugs: string[] = [];
    const walk = async (absDir: string): Promise<void> => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        const abs = join(absDir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.name.endsWith(suffix)) {
          const rel = relative(base, abs).replace(/\\/g, "/");
          slugs.push(rel.slice(0, -suffix.length));
        }
      }
    };
    await walk(base);
    return slugs;
  }

  // Agent-area wrappers (markdown: frontmatter identity + body = system prompt).
  const agentFilePath = (slug: string) => areaFilePath(AGENTS_DIR, slug);
  const readAgent = (slug: string) => readFileIn(AGENTS_DIR, slug);
  const writeAgent = (
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string,
    options: { exclusive?: boolean } = {}
  ) => writeFileIn(AGENTS_DIR, slug, input, now, options);
  const deleteAgent = (slug: string) => deleteFileIn(AGENTS_DIR, slug);
  const listAgentSlugs = () => listSlugsIn(AGENTS_DIR);

  // Conversation-area wrappers (markdown transcripts, written once).
  const conversationFilePath = (slug: string) => areaFilePath(CONVERSATIONS_DIR, slug);
  const readConversation = (slug: string) => readFileIn(CONVERSATIONS_DIR, slug);
  const writeConversation = (
    slug: string,
    input: { frontmatter: Partial<PageFrontmatter>; markdown: string },
    now: string,
    options: { exclusive?: boolean } = {}
  ) => writeFileIn(CONVERSATIONS_DIR, slug, input, now, options);
  const deleteConversation = (slug: string) => deleteFileIn(CONVERSATIONS_DIR, slug);
  const listConversationSlugs = () => listSlugsIn(CONVERSATIONS_DIR);

  // Job-area wrappers (raw YAML).
  const jobFilePath = (slug: string) => rawFilePath(JOBS_DIR, slug, "yaml");
  const readJob = (slug: string) => readRawIn(JOBS_DIR, slug, "yaml");
  const writeJob = (slug: string, content: string, options: { exclusive?: boolean } = {}) =>
    writeRawIn(JOBS_DIR, slug, "yaml", content, options);
  const deleteJob = (slug: string) => deleteRawIn(JOBS_DIR, slug, "yaml");
  const listJobSlugs = () => listRawIn(JOBS_DIR, "yaml");

  return {
    pathArea,
    slugFromPath,
    htmlToMarkdown,
    markdownToHtml,
    sanitizePageHtml,
    parsePage,
    // pages area
    pageFilePath,
    dirIndexPath,
    readPage,
    writePage,
    deletePage,
    listPageSlugs,
    // memory (entity) area
    entityFilePath,
    readEntity,
    writeEntity,
    deleteEntity,
    listEntitySlugs,
    // raw (non-markdown) IO
    readRawIn,
    writeRawIn,
    deleteRawIn,
    listRawIn,
    // agents area
    agentFilePath,
    readAgent,
    writeAgent,
    deleteAgent,
    listAgentSlugs,
    // conversations area
    conversationFilePath,
    readConversation,
    writeConversation,
    deleteConversation,
    listConversationSlugs,
    // jobs area (raw YAML)
    jobFilePath,
    readJob,
    writeJob,
    deleteJob,
    listJobSlugs,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

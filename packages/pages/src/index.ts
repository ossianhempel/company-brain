import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import sanitizeHtml from "sanitize-html";
import { createDb, type CompanyBrainDb } from "@company-brain/db";
import type { GitWriter } from "@company-brain/git-writer";
import { SANITIZE_OPTIONS, type Workspace } from "@company-brain/workspace";

const scrypt = promisify(scryptCallback);

/** Options enabling file-canonical mode: writes go to markdown files + git. */
export interface PageStoreOptions {
  gitWriter?: GitWriter;
  workspace?: Workspace;
}

export type Page = {
  id: string;
  title: string;
  slug: string;
  html: string;
  plainText: string;
  creator: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  pinnedOrder: number | null;
  parentPageId: string | null;
  visibility: "workspace" | "restricted" | "public";
  owner: string;
  permissionNote: string | null;
};

export type PageLink = {
  sourcePageId: string;
  targetPageId: string | null;
  targetSlug: string;
  targetTitle: string;
};

export type PageWithRelations = Page & {
  outgoingLinks: PageLink[];
  backlinks: Page[];
  relatedPages: Page[];
  comments: PageComment[];
  shareLinks: PageShareLink[];
  activity: PageActivity[];
  sources: PageSourceArtifact[];
};

export type PageSearchResult = {
  pageId: string;
  chunkId: string | null;
  headingPath: string | null;
  slug: string;
  title: string;
  snippet: string;
  matchReason: "title" | "slug" | "body";
  score: number;
  updatedAt: string;
};

export type PageVersion = {
  id: string;
  pageId: string;
  title: string;
  slug: string;
  html: string;
  plainText: string;
  createdBy: string;
  createdAt: string;
};

export type PageComment = {
  id: string;
  pageId: string;
  body: string;
  anchorText: string | null;
  createdBy: string;
  createdAt: string;
  deletedAt: string | null;
};

export type PageShareLink = {
  id: string;
  pageId: string;
  token: string;
  label: string;
  accessLevel: "view" | "comment";
  hasPassword: boolean;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
};

export type PageActivity = {
  id: string;
  pageId: string | null;
  eventType: string;
  summary: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PageSourceArtifact = {
  id: string;
  pageId: string;
  artifactId: string;
  label: string | null;
  sourceType: string;
  title: string;
  rawText: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  attachedBy: string;
  createdAt: string;
  attachedAt: string;
  deletedAt: string | null;
};

type PageRow = {
  id: string;
  title: string;
  slug: string;
  html: string;
  plain_text: string;
  creator: string;
  created_by: string;
  updated_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
  pinned_order: number | null;
  parent_page_id: string | null;
  visibility: "workspace" | "restricted" | "public";
  owner: string;
  permission_note: string | null;
};

type PageVersionRow = {
  id: string;
  page_id: string;
  title: string;
  slug: string;
  html: string;
  plain_text: string;
  created_by: string;
  created_at: string | Date;
};

type PageLinkRow = {
  source_page_id: string;
  target_page_id: string | null;
  target_slug: string;
  target_title: string;
};

type PageChunkRow = {
  id: string;
  page_id: string;
  chunk_index: number;
  heading_path: string;
  text: string;
  html_fragment: string | null;
  token_count: number;
};

type PageCommentRow = {
  id: string;
  page_id: string;
  body: string;
  anchor_text: string | null;
  created_by: string;
  created_at: string | Date;
  deleted_at: string | Date | null;
};

type PageShareLinkRow = {
  id: string;
  page_id: string;
  token: string;
  label: string;
  access_level: "view" | "comment";
  password: string | null;
  password_hash: string | null;
  expires_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
};

type PageActivityRow = {
  id: string;
  page_id: string | null;
  event_type: string;
  summary: string;
  actor: string;
  metadata_json: string;
  created_at: string | Date;
};

type PageSourceArtifactRow = {
  id: string;
  page_id: string;
  artifact_id: string;
  label: string | null;
  source_type: string;
  title: string;
  raw_text: string;
  metadata_json: string;
  artifact_created_by: string;
  attached_by: string;
  artifact_created_at: string | Date;
  attached_at: string | Date;
  deleted_at: string | Date | null;
};

type PageInput = {
  title: string;
  html: string;
  actor?: string;
  pinnedOrder?: number | null;
  parentPageId?: string | null;
  visibility?: Page["visibility"];
  owner?: string;
  permissionNote?: string | null;
};

type PreparedPageInput = {
  title: string;
  html: string;
  titleProvided?: boolean;
};

const homePageTitle = "Home";
const homePageSlug = "home";
const homePageHtml = `
  <h1>Company Brain</h1>
  <p>This is the home page for your self-hosted company brain.</p>
  <h2>Start here</h2>
  <ul>
    <li>Create pages for company knowledge, decisions, processes, and project context.</li>
    <li>Use <code>[[Page Title]]</code> to link related pages.</li>
    <li>Related content appears from pages that link back here.</li>
  </ul>
`;
const paraPages = [
  {
    title: "Projects",
    slug: "projects",
    pinnedOrder: 10,
    html: `
      <h1>Projects</h1>
      <p>Active outcomes with deadlines, clients, deliverables, and next actions.</p>
    `
  },
  {
    title: "Areas",
    slug: "areas",
    pinnedOrder: 20,
    html: `
      <h1>Areas</h1>
      <p>Ongoing responsibilities and standards that need to be maintained over time.</p>
    `
  },
  {
    title: "Resources",
    slug: "resources",
    pinnedOrder: 30,
    html: `
      <h1>Resources</h1>
      <p>Reference material, reusable knowledge, examples, links, and research.</p>
    `
  },
  {
    title: "Archive",
    slug: "archive",
    pinnedOrder: 40,
    html: `
      <h1>Archive</h1>
      <p>Completed, inactive, or deprecated work kept for reference.</p>
    `
  }
];

const projectPageTemplates = [
  {
    suffix: "start",
    title: "Start",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)}</h1>
      <h2>Summary</h2>
      <p>What this project is trying to achieve.</p>
      <h2>Current status</h2>
      <p>Unknown.</p>
      <h2>Next actions</h2>
      <ul><li>Add the next concrete action.</li></ul>
    `
  },
  {
    suffix: "decisions",
    title: "Decisions",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} Decisions</h1>
      <p>Record project decisions, tradeoffs, owners, and source links.</p>
    `
  },
  {
    suffix: "deadlines",
    title: "Deadlines",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} Deadlines</h1>
      <p>Track dates, commitments, dependencies, and delivery expectations.</p>
    `
  },
  {
    suffix: "people",
    title: "People",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} People</h1>
      <p>Stakeholders, client contacts, internal owners, and working preferences.</p>
    `
  },
  {
    suffix: "links",
    title: "Links",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} Links</h1>
      <p>Important URLs, repos, Teams channels, SharePoint folders, Azure DevOps boards, and reference material.</p>
    `
  },
  {
    suffix: "activity-log",
    title: "Activity Log",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} Activity Log</h1>
      <p>Timestamped notes about meaningful progress, meetings, changes, and handoffs.</p>
    `
  },
  {
    suffix: "open-questions",
    title: "Open Questions",
    html: (projectName: string) => `
      <h1>${escapeHtml(projectName)} Open Questions</h1>
      <p>Questions that need decisions, research, client input, or follow-up.</p>
    `
  }
];

const linkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const firstHeadingPattern = /<h1\b[^>]*>(.*?)<\/h1>/is;
const internalAnchorPattern = /<a\b[^>]*>(.*?)<\/a>/gis;
const attributePattern = /\s([a-zA-Z0-9:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const genericTitles = new Set(["", "untitled", "untitled page", "new page"]);

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    html: row.html,
    plainText: row.plain_text,
    creator: row.creator,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    deletedAt: row.deleted_at ? normalizeTimestamp(row.deleted_at) : null,
    pinnedOrder: row.pinned_order,
    parentPageId: row.parent_page_id,
    visibility: row.visibility ?? "workspace",
    owner: row.owner ?? "system",
    permissionNote: row.permission_note
  };
}

function normalizeTimestamp(value: string | Date) {
  return value instanceof Date ? value.toISOString() : value;
}

function toPageLink(row: PageLinkRow): PageLink {
  return {
    sourcePageId: row.source_page_id,
    targetPageId: row.target_page_id,
    targetSlug: row.target_slug,
    targetTitle: row.target_title
  };
}

function toPageVersion(row: PageVersionRow): PageVersion {
  return {
    id: row.id,
    pageId: row.page_id,
    title: row.title,
    slug: row.slug,
    html: row.html,
    plainText: row.plain_text,
    createdBy: row.created_by,
    createdAt: normalizeTimestamp(row.created_at)
  };
}

function toPageComment(row: PageCommentRow): PageComment {
  return {
    id: row.id,
    pageId: row.page_id,
    body: row.body,
    anchorText: row.anchor_text,
    createdBy: row.created_by,
    createdAt: normalizeTimestamp(row.created_at),
    deletedAt: row.deleted_at ? normalizeTimestamp(row.deleted_at) : null
  };
}

function toPageShareLink(row: PageShareLinkRow): PageShareLink {
  return {
    id: row.id,
    pageId: row.page_id,
    token: row.token,
    label: row.label,
    accessLevel: row.access_level,
    hasPassword: Boolean(row.password_hash),
    expiresAt: row.expires_at ? normalizeTimestamp(row.expires_at) : null,
    createdBy: row.created_by,
    createdAt: normalizeTimestamp(row.created_at),
    revokedAt: row.revoked_at ? normalizeTimestamp(row.revoked_at) : null
  };
}

async function hashSharePassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

function toPageActivity(row: PageActivityRow): PageActivity {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    pageId: row.page_id,
    eventType: row.event_type,
    summary: row.summary,
    actor: row.actor,
    metadata,
    createdAt: normalizeTimestamp(row.created_at)
  };
}

function toPageSourceArtifact(row: PageSourceArtifactRow): PageSourceArtifact {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    pageId: row.page_id,
    artifactId: row.artifact_id,
    label: row.label,
    sourceType: row.source_type,
    title: row.title,
    rawText: row.raw_text,
    metadata,
    createdBy: row.artifact_created_by,
    attachedBy: row.attached_by,
    createdAt: normalizeTimestamp(row.artifact_created_at),
    attachedAt: normalizeTimestamp(row.attached_at),
    deletedAt: row.deleted_at ? normalizeTimestamp(row.deleted_at) : null
  };
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled";
}

function slugifyPath(value: string) {
  return value
    .split("/")
    .map((part) => slugify(part))
    .filter(Boolean)
    .join("/");
}

function stripHtml(value: string) {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isGenericTitle(value: string) {
  return genericTitles.has(normalizeSearch(value));
}

function getFirstHeadingText(html: string) {
  const match = html.match(firstHeadingPattern);
  return match ? stripHtml(match[1]) : null;
}

function htmlWithFirstHeading(html: string, title: string) {
  const escapedTitle = escapeHtml(title);

  if (firstHeadingPattern.test(html)) {
    return html.replace(firstHeadingPattern, `<h1>${escapedTitle}</h1>`);
  }

  return `<h1>${escapedTitle}</h1>\n${html}`;
}

function preparePageInput(input: PreparedPageInput, current?: Page) {
  const title = input.title.trim() || current?.title || "Untitled";
  const firstHeading = getFirstHeadingText(input.html);
  const currentFirstHeading = current ? getFirstHeadingText(current.html) : null;
  const shouldInferTitleFromHeading =
    Boolean(firstHeading) &&
    (isGenericTitle(title) ||
      (Boolean(current) &&
        !input.titleProvided &&
        firstHeading !== currentFirstHeading &&
        current?.title === currentFirstHeading));
  const resolvedTitle = shouldInferTitleFromHeading ? firstHeading ?? title : title;
  const shouldSyncHeading =
    !firstHeading ||
    (current && input.titleProvided && input.title !== current.title && firstHeading === current.title) ||
    (!current && isGenericTitle(firstHeading));

  return {
    title: resolvedTitle,
    html: shouldSyncHeading ? htmlWithFirstHeading(input.html, resolvedTitle) : input.html
  };
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function readAttributes(value: string) {
  const attributes = new Map<string, string>();

  for (const match of value.matchAll(attributePattern)) {
    attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ""));
  }

  return attributes;
}

function getInternalLinkSlug(attributes: Map<string, string>) {
  const dataSlug = attributes.get("data-page-slug");
  if (dataSlug) {
    return slugify(dataSlug);
  }

  const href = attributes.get("href");
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, "http://company-brain.local");
    if (url.origin !== "http://company-brain.local" || !url.pathname.startsWith("/pages/")) {
      return null;
    }

    const slug = decodeURIComponent(url.pathname.replace(/^\/pages\//, "").replace(/\/$/, ""));
    return slug ? slugify(slug) : null;
  } catch {
    return null;
  }
}

function extractInternalAnchorLinks(html: string) {
  const links = new Map<string, { slug: string; title: string }>();

  for (const match of html.matchAll(internalAnchorPattern)) {
    const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
    const attributes = readAttributes(openingTag);
    const slug = getInternalLinkSlug(attributes);
    if (!slug) {
      continue;
    }

    const title = stripHtml(match[1]) || slug;
    links.set(slug, { slug, title });
  }

  return links;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function createSnippet(text: string, query: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const index = compact.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return compact.slice(0, 220);
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(compact.length, index + query.length + 140);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function estimateTokenCount(text: string) {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35);
}

function estimateSourceTokenCount(text: string) {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35);
}

function splitSourceText(text: string, maxWords = 180) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  for (const paragraph of paragraphs.length ? paragraphs : [text.replace(/\s+/g, " ").trim()].filter(Boolean)) {
    const words = paragraph.split(/\s+/);
    if (current.length + words.length > maxWords && current.length > 0) {
      chunks.push(current.join(" "));
      current = [];
    }

    if (words.length > maxWords) {
      if (current.length > 0) {
        chunks.push(current.join(" "));
        current = [];
      }

      for (let index = 0; index < words.length; index += maxWords) {
        chunks.push(words.slice(index, index + maxWords).join(" "));
      }
      continue;
    }

    current.push(...words);
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

function extractPageChunks(html: string, fallbackTitle: string) {
  const sectionPattern = /<(h[1-3])[^>]*>(.*?)<\/\1>/gis;
  const matches = [...html.matchAll(sectionPattern)];
  const chunks: Array<{ headingPath: string; text: string; htmlFragment: string; tokenCount: number }> = [];

  if (matches.length === 0) {
    const text = stripHtml(html);
    return [
      {
        headingPath: fallbackTitle,
        text,
        htmlFragment: html,
        tokenCount: estimateTokenCount(text)
      }
    ];
  }

  const headingStack: Array<{ level: number; text: string }> = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const tag = match[1].toLowerCase();
    const level = Number(tag.slice(1));
    const headingText = stripHtml(match[2]);
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? html.length : html.length;
    const htmlFragment = html.slice(start, end).trim();

    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, text: headingText });

    const text = stripHtml(htmlFragment);
    if (!text) {
      continue;
    }

    chunks.push({
      headingPath: headingStack.map((heading) => heading.text).join(" / "),
      text,
      htmlFragment,
      tokenCount: estimateTokenCount(text)
    });
  }

  return chunks.length
    ? chunks
    : [
        {
          headingPath: fallbackTitle,
          text: stripHtml(html),
          htmlFragment: html,
          tokenCount: estimateTokenCount(stripHtml(html))
        }
      ];
}

function prepareHtml(html: string) {
  const links = new Map<string, { slug: string; title: string }>();
  const withInternalLinks = html.replace(linkPattern, (_match, rawTitle: string, rawLabel?: string) => {
    const title = rawTitle.trim();
    const label = (rawLabel ?? rawTitle).trim();
    const slug = slugify(title);
    links.set(slug, { slug, title });
    return `<a href="/pages/${slug}" data-page-slug="${slug}">${label}</a>`;
  });

  // Shared allowlist (single source of truth in @company-brain/workspace) so the
  // editor write path and markdown reindex path sanitize identically.
  const sanitizedHtml = sanitizeHtml(withInternalLinks, SANITIZE_OPTIONS);

  return {
    html: sanitizedHtml,
    plainText: stripHtml(sanitizedHtml),
    links: [...new Map([...extractInternalAnchorLinks(sanitizedHtml), ...links]).values()]
  };
}

async function ensureUniqueSlug(db: CompanyBrainDb, title: string, existingPageId?: string) {
  const baseSlug = slugify(title);
  let candidate = baseSlug;
  let suffix = 2;

  while (true) {
    const result = await db.query<{ id: string }>("select id from pages where slug = $1", [candidate]);
    const existing = result.rows[0];

    if (!existing || existing.id === existingPageId) {
      return candidate;
    }

    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

async function ensureUniqueSlugFromBase(db: CompanyBrainDb, baseSlug: string, existingPageId?: string) {
  const normalizedBaseSlug = slugifyPath(baseSlug);
  let candidate = normalizedBaseSlug;
  let suffix = 2;

  while (true) {
    const result = await db.query<{ id: string }>("select id from pages where slug = $1", [candidate]);
    const existing = result.rows[0];
    if (!existing || existing.id === existingPageId) {
      return candidate;
    }

    candidate = `${normalizedBaseSlug}-${suffix}`;
    suffix += 1;
  }
}

async function writeLinks(
  db: CompanyBrainDb,
  sourcePageId: string,
  links: Array<{ slug: string; title: string }>
) {
  await db.query("delete from page_links where source_page_id = $1", [sourcePageId]);

  for (const link of links) {
    const target = await db.query<{ id: string }>("select id from pages where slug = $1 and deleted_at is null", [
      link.slug
    ]);

    await db.query(
      `
        insert into page_links (source_page_id, target_page_id, target_slug, target_title)
        values ($1, $2, $3, $4)
      `,
      [sourcePageId, target.rows[0]?.id ?? null, link.slug, link.title]
    );
  }
}

async function snapshotPage(db: CompanyBrainDb, page: Page, actor: string) {
  await db.query(
    `
      insert into page_versions (id, page_id, title, slug, html, plain_text, created_by)
      values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [randomUUID(), page.id, page.title, page.slug, page.html, page.plainText, actor]
  );
}

async function recordPageActivity(
  db: CompanyBrainDb,
  pageId: string | null,
  eventType: string,
  summary: string,
  actor: string,
  metadata: Record<string, unknown> = {}
) {
  await db.query(
    `
      insert into page_activity (id, page_id, event_type, summary, actor, metadata_json)
      values ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), pageId, eventType, summary, actor, JSON.stringify(metadata)]
  );
}

async function reindexPageChunks(db: CompanyBrainDb, pageId: string, title: string, html: string) {
  const chunks = extractPageChunks(html, title);
  await db.query("delete from page_chunks where page_id = $1", [pageId]);

  for (const [index, chunk] of chunks.entries()) {
    await db.query(
      `
        insert into page_chunks (id, page_id, chunk_index, heading_path, text, html_fragment, token_count)
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [randomUUID(), pageId, index, chunk.headingPath, chunk.text, chunk.htmlFragment, chunk.tokenCount]
    );
  }
}

/**
 * Rebuild the derived index row(s) for the given page slugs from their markdown
 * files. A missing file becomes a soft-delete (tombstone), so history stays
 * citable while the index reflects the working tree. Incremental: a file whose
 * content_hash is unchanged is skipped.
 */
export async function reindexPages(
  db: CompanyBrainDb,
  workspace: Workspace,
  slugs: string[]
): Promise<void> {
  // Parent assignments are applied in a second pass so a child reindexed before
  // its parent doesn't violate the parent_page_id FK during a full rebuild.
  const parentLinks: Array<{ id: string; parentPageId: string }> = [];
  for (const slug of slugs) {
    const stored = await workspace.readPage(slug);
    if (!stored) {
      await db.query(
        "update pages set deleted_at = now() where slug = $1 and deleted_at is null",
        [slug]
      );
      continue;
    }

    const fm = stored.frontmatter;
    // Hash over frontmatter + body so metadata-only changes (e.g. a move that
    // only updates parentPageId) aren't skipped by the incremental check.
    const hash = createHash("sha256")
      .update(JSON.stringify(fm))
      .update("\n")
      .update(stored.markdown)
      .digest("hex");
    const existing = await db.query<{ content_hash: string | null }>(
      "select content_hash from pages where id = $1 and deleted_at is null",
      [fm.id]
    );
    if (existing.rows[0]?.content_hash === hash) {
      continue; // unchanged
    }

    const prepared = prepareHtml(workspace.markdownToHtml(stored.markdown));
    // Attribution is carried in frontmatter so a rebuild preserves it. creator
    // and created_at are immutable (set on insert, never on conflict-update).
    const creator = fm.creator ?? fm.owner ?? "system";
    const createdBy = fm.createdBy ?? creator;
    const updatedBy = fm.updatedBy ?? createdBy;
    const owner = fm.owner ?? creator;
    await db.query(
      `
        insert into pages (
          id, title, slug, html, plain_text, creator, created_by, updated_by,
          created_at, updated_at, visibility, owner, permission_note,
          parent_page_id, pinned_order, content_hash
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        on conflict (id) do update set
          title = excluded.title,
          slug = excluded.slug,
          html = excluded.html,
          plain_text = excluded.plain_text,
          created_by = excluded.created_by,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at,
          visibility = excluded.visibility,
          owner = excluded.owner,
          permission_note = excluded.permission_note,
          parent_page_id = excluded.parent_page_id,
          pinned_order = excluded.pinned_order,
          content_hash = excluded.content_hash,
          deleted_at = null
      `,
      [
        fm.id,
        fm.title,
        slug,
        prepared.html,
        prepared.plainText,
        creator,
        createdBy,
        updatedBy,
        fm.created ?? new Date().toISOString(),
        fm.updated ?? new Date().toISOString(),
        fm.visibility ?? "workspace",
        owner,
        fm.permissionNote ?? null,
        null, // parent_page_id assigned in the second pass (FK ordering)
        fm.pinnedOrder ?? null,
        hash,
      ]
    );
    await writeLinks(db, fm.id, prepared.links);
    await reindexPageChunks(db, fm.id, fm.title, prepared.html);
    if (fm.parentPageId) {
      parentLinks.push({ id: fm.id, parentPageId: fm.parentPageId });
    }
  }

  // Second pass: now that all rows exist, set parent_page_id where the parent is
  // present (a dangling parent reference is left null rather than failing).
  for (const { id, parentPageId } of parentLinks) {
    await db.query(
      "update pages set parent_page_id = $2 where id = $1 and exists (select 1 from pages where id = $2)",
      [id, parentPageId]
    );
  }
}

/** Rebuild the entire derived index from every page file on disk. */
export async function reindexAllPages(db: CompanyBrainDb, workspace: Workspace): Promise<void> {
  const slugs = await workspace.listPageSlugs();
  await reindexPages(db, workspace, slugs);

  // Tombstone any live index row whose file no longer exists on disk.
  const onDisk = new Set(slugs);
  const live = await db.query<{ slug: string }>(
    "select slug from pages where deleted_at is null"
  );
  for (const { slug } of live.rows) {
    if (!onDisk.has(slug)) {
      await db.query("update pages set deleted_at = now() where slug = $1 and deleted_at is null", [
        slug,
      ]);
    }
  }
}

export async function createPageStore(db?: CompanyBrainDb, opts?: PageStoreOptions) {
  const pageDb = db ?? (await createDb());
  const gitWriter = opts?.gitWriter;
  const workspace = opts?.workspace;
  const fileMode = Boolean(gitWriter && workspace);

  /**
   * In file mode, write+commit the page's markdown file (the canonical record).
   * Frontmatter carries every persisted field so the DB index is fully
   * rebuildable from the file alone. On a rename, the old file is removed in the
   * same commit.
   */
  async function writePageFile(page: Page, actor: string, oldSlug?: string): Promise<void> {
    if (!fileMode) return;
    const ws = workspace!;
    const markdown = ws.htmlToMarkdown(page.html);
    const renamed = oldSlug && oldSlug !== page.slug ? oldSlug : undefined;

    // Preserve (and on rename, extend) the page's slug history so version
    // history can follow renames. Read it from the source file being superseded.
    const sourceStored = await ws.readPage(renamed ?? page.slug);
    const priorSlugs = (sourceStored?.frontmatter.previousSlugs as string[] | undefined) ?? [];
    const previousSlugs = renamed ? [...priorSlugs, renamed] : priorSlugs;

    const frontmatter = {
      id: page.id,
      title: page.title,
      created: page.createdAt,
      updated: page.updatedAt,
      tags: [] as string[],
      visibility: page.visibility,
      owner: page.owner,
      creator: page.creator,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
      parentPageId: page.parentPageId,
      pinnedOrder: page.pinnedOrder,
      permissionNote: page.permissionNote,
      ...(previousSlugs.length ? { previousSlugs } : {}),
    };
    const paths = [ws.pageFilePath(page.slug)];
    if (renamed) paths.push(ws.pageFilePath(renamed));
    await gitWriter!.enqueue({
      paths,
      message: `save ${page.slug}`,
      actor: { name: actor },
      write: async () => {
        await ws.writePage(page.slug, { frontmatter, markdown }, page.updatedAt);
        if (renamed) await ws.deletePage(renamed);
      },
    });
  }

  /**
   * File-first persist: commit the markdown file, then derive the DB index from
   * it via reindex (the single index writer). Returns the reindexed page so the
   * DB never leads the canonical files.
   */
  async function persistPageFileMode(page: Page, actor: string, oldSlug?: string): Promise<Page> {
    await writePageFile(page, actor, oldSlug);
    await reindexPages(pageDb, workspace!, [page.slug]);
    return (await getBySlug(page.slug)) ?? page;
  }

  /** In file mode, remove the page's markdown file and commit the deletion. */
  async function deletePageFile(slug: string, actor: string): Promise<void> {
    if (!fileMode) return;
    const ws = workspace!;
    await gitWriter!.enqueue({
      paths: [ws.pageFilePath(slug)],
      message: `delete ${slug}`,
      actor: { name: actor },
      write: async () => {
        await ws.deletePage(slug);
      },
    });
  }

  async function getBySlug(slug: string) {
    const result = await pageDb.query<PageRow>("select * from pages where slug = $1 and deleted_at is null", [slug]);
    const row = result.rows[0];
    return row ? toPage(row) : null;
  }

  async function ensureHomePage() {
    const existing = await getBySlug(homePageSlug);
    if (existing) {
      return existing;
    }

    const prepared = prepareHtml(homePageHtml);
    const result = await pageDb.query<PageRow>(
      `
          insert into pages (id, title, slug, html, plain_text, creator, created_by, updated_by, pinned_order)
          values ($1, $2, $3, $4, $5, 'system', 'system', 'system', 0)
          returning *
      `,
      [randomUUID(), homePageTitle, homePageSlug, prepared.html, prepared.plainText]
    );

    return toPage(result.rows[0]);
  }

  const homePage = await ensureHomePage();
  const existingHomeChunks = await pageDb.query<{ id: string }>("select id from page_chunks where page_id = $1 limit 1", [
    homePage.id
  ]);
  if (existingHomeChunks.rows.length === 0) {
    await reindexPageChunks(pageDb, homePage.id, homePage.title, homePage.html);
  }
  const existingHomeVersions = await pageDb.query<{ id: string }>(
    "select id from page_versions where page_id = $1 limit 1",
    [homePage.id]
  );
  if (existingHomeVersions.rows.length === 0) {
    await snapshotPage(pageDb, homePage, homePage.updatedBy);
  }
  if (fileMode) {
    await writePageFile(homePage, "system");
  }

  return {
    async list() {
      const result = await pageDb.query<PageRow>(
        `
          select *
          from pages
          where deleted_at is null
          order by
            case when pinned_order is null then 1 else 0 end,
            pinned_order asc,
            updated_at desc
        `
      );
      return result.rows.map(toPage);
    },

    async search(query: string, limit = 20): Promise<PageSearchResult[]> {
      const normalized = normalizeSearch(query);
      if (!normalized) {
        return [];
      }

      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const result = await pageDb.query<
        PageRow & {
          chunk_id: string | null;
          heading_path: string | null;
          chunk_text: string | null;
        }
      >(
        `
          select
            pages.*,
            page_chunks.id as chunk_id,
            page_chunks.heading_path,
            page_chunks.text as chunk_text
          from pages
          left join page_chunks on page_chunks.page_id = pages.id
          where pages.deleted_at is null
            and (
              lower(pages.title) like $1
              or lower(pages.slug) like $1
              or lower(page_chunks.text) like $1
            )
          order by pages.updated_at desc, page_chunks.chunk_index asc
          limit $2
        `,
        [`%${normalized}%`, safeLimit]
      );

      return result.rows
        .map((row) => {
          const page = toPage(row);
          const titleMatch = normalizeSearch(page.title).includes(normalized);
          const slugMatch = normalizeSearch(page.slug).includes(normalized);
          const chunkText = row.chunk_text ?? page.plainText;
          const matchReason: PageSearchResult["matchReason"] = titleMatch ? "title" : slugMatch ? "slug" : "body";
          const score = (titleMatch ? 100 : 0) + (slugMatch ? 50 : 0) + (matchReason === "body" ? 10 : 0);

          return {
            pageId: page.id,
            chunkId: row.chunk_id,
            headingPath: row.heading_path,
            slug: page.slug,
            title: page.title,
            snippet: createSnippet(chunkText, query),
            matchReason,
            score,
            updatedAt: page.updatedAt
          };
        })
        .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    },

    async get(id: string) {
      const result = await pageDb.query<PageRow>("select * from pages where id = $1 and deleted_at is null", [id]);
      const row = result.rows[0];
      return row ? toPage(row) : null;
    },

    async getBySlug(slug: string) {
      return getBySlug(slug);
    },

    async getWithRelations(id: string): Promise<PageWithRelations | null> {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const outgoing = await pageDb.query<PageLinkRow>("select * from page_links where source_page_id = $1", [id]);
      const comments = await pageDb.query<PageCommentRow>(
        `
          select *
          from page_comments
          where page_id = $1 and deleted_at is null
          order by created_at desc
        `,
        [id]
      );
      const shareLinks = await pageDb.query<PageShareLinkRow>(
        `
          select *
          from page_share_links
          where page_id = $1
          order by created_at desc
        `,
        [id]
      );
      const activity = await pageDb.query<PageActivityRow>(
        `
          select *
          from page_activity
          where page_id = $1
          order by created_at desc
          limit 50
        `,
        [id]
      );
      const sources = await pageDb.query<PageSourceArtifactRow>(
        `
          select
            page_source_artifacts.id,
            page_source_artifacts.page_id,
            page_source_artifacts.artifact_id,
            page_source_artifacts.label,
            source_artifacts.source_type,
            source_artifacts.title,
            source_artifacts.raw_text,
            source_artifacts.metadata_json,
            source_artifacts.created_by as artifact_created_by,
            page_source_artifacts.created_by as attached_by,
            source_artifacts.created_at as artifact_created_at,
            page_source_artifacts.created_at as attached_at,
            page_source_artifacts.deleted_at
          from page_source_artifacts
          join source_artifacts on source_artifacts.id = page_source_artifacts.artifact_id
          where page_source_artifacts.page_id = $1
            and page_source_artifacts.deleted_at is null
            and source_artifacts.deleted_at is null
          order by page_source_artifacts.created_at desc
        `,
        [id]
      );
      const backlinkRows = await pageDb.query<PageRow>(
        `
          select distinct pages.*
          from page_links
          join pages on pages.id = page_links.source_page_id
          where page_links.target_page_id = $1
            and pages.deleted_at is null
          order by pages.updated_at desc
        `,
        [id]
      );
      const backlinks = backlinkRows.rows.map(toPage);

      return {
        ...page,
        outgoingLinks: outgoing.rows.map(toPageLink),
        backlinks,
        relatedPages: backlinks,
        comments: comments.rows.map(toPageComment),
        shareLinks: shareLinks.rows.map(toPageShareLink),
        activity: activity.rows.map(toPageActivity),
        sources: sources.rows.map(toPageSourceArtifact)
      };
    },

    async attachSourceArtifact(id: string, input: { artifactId: string; label?: string | null; actor?: string }) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const artifact = await pageDb.query<{ id: string; title: string }>(
        "select id, title from source_artifacts where id = $1 and deleted_at is null",
        [input.artifactId]
      );
      if (!artifact.rows[0]) {
        throw new Error("Source artifact not found.");
      }

      const actor = input.actor ?? "local-user";
      const result = await pageDb.query<PageSourceArtifactRow>(
        `
          insert into page_source_artifacts (id, page_id, artifact_id, label, created_by)
          values ($1, $2, $3, $4, $5)
          on conflict (page_id, artifact_id)
          do update set
            label = excluded.label,
            created_by = excluded.created_by,
            created_at = now(),
            deleted_at = null
          returning
            page_source_artifacts.id,
            page_source_artifacts.page_id,
            page_source_artifacts.artifact_id,
            page_source_artifacts.label,
            (select source_type from source_artifacts where id = page_source_artifacts.artifact_id) as source_type,
            (select title from source_artifacts where id = page_source_artifacts.artifact_id) as title,
            (select raw_text from source_artifacts where id = page_source_artifacts.artifact_id) as raw_text,
            (select metadata_json from source_artifacts where id = page_source_artifacts.artifact_id) as metadata_json,
            (select created_by from source_artifacts where id = page_source_artifacts.artifact_id) as artifact_created_by,
            page_source_artifacts.created_by as attached_by,
            (select created_at from source_artifacts where id = page_source_artifacts.artifact_id) as artifact_created_at,
            page_source_artifacts.created_at as attached_at,
            page_source_artifacts.deleted_at
        `,
        [randomUUID(), id, input.artifactId, input.label?.trim() || null, actor]
      );
      await recordPageActivity(pageDb, id, "source.attached", `Attached ${artifact.rows[0].title}`, actor, {
        artifactId: input.artifactId
      });
      return toPageSourceArtifact(result.rows[0]);
    },

    async createAndAttachSourceArtifact(
      id: string,
      input: {
        sourceType: string;
        title: string;
        rawText: string;
        label?: string | null;
        metadata?: Record<string, unknown>;
        actor?: string;
      }
    ) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const actor = input.actor ?? "local-user";
      const artifactId = randomUUID();
      await pageDb.query(
        `
          insert into source_artifacts (id, source_type, title, raw_text, metadata_json, created_by)
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          artifactId,
          input.sourceType.trim() || "manual",
          input.title.trim(),
          input.rawText,
          JSON.stringify(input.metadata ?? { pageId: id, attachedFrom: "page" }),
          actor
        ]
      );

      for (const [index, text] of splitSourceText(input.rawText).entries()) {
        await pageDb.query(
          `
            insert into source_chunks (id, artifact_id, chunk_index, text, token_count)
            values ($1, $2, $3, $4, $5)
          `,
          [randomUUID(), artifactId, index, text, estimateSourceTokenCount(text)]
        );
      }

      return this.attachSourceArtifact(id, {
        artifactId,
        label: input.label,
        actor
      });
    },

    async detachSourceArtifact(id: string, sourceId: string, actor = "local-user") {
      const result = await pageDb.query<PageSourceArtifactRow>(
        `
          update page_source_artifacts
          set deleted_at = now()
          where id = $1 and page_id = $2 and deleted_at is null
          returning
            page_source_artifacts.id,
            page_source_artifacts.page_id,
            page_source_artifacts.artifact_id,
            page_source_artifacts.label,
            (select source_type from source_artifacts where id = page_source_artifacts.artifact_id) as source_type,
            (select title from source_artifacts where id = page_source_artifacts.artifact_id) as title,
            (select raw_text from source_artifacts where id = page_source_artifacts.artifact_id) as raw_text,
            (select metadata_json from source_artifacts where id = page_source_artifacts.artifact_id) as metadata_json,
            (select created_by from source_artifacts where id = page_source_artifacts.artifact_id) as artifact_created_by,
            page_source_artifacts.created_by as attached_by,
            (select created_at from source_artifacts where id = page_source_artifacts.artifact_id) as artifact_created_at,
            page_source_artifacts.created_at as attached_at,
            page_source_artifacts.deleted_at
        `,
        [sourceId, id]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      await recordPageActivity(pageDb, id, "source.detached", `Detached ${row.title}`, actor, {
        artifactId: row.artifact_id
      });
      return toPageSourceArtifact(row);
    },

    async addComment(id: string, input: { body: string; anchorText?: string | null; actor?: string }) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const actor = input.actor ?? "local-user";
      const body = input.body.trim();
      if (!body) {
        throw new Error("Comment body is required.");
      }

      const result = await pageDb.query<PageCommentRow>(
        `
          insert into page_comments (id, page_id, body, anchor_text, created_by)
          values ($1, $2, $3, $4, $5)
          returning *
        `,
        [randomUUID(), id, body, input.anchorText?.trim() || null, actor]
      );
      await recordPageActivity(pageDb, id, "comment.created", "Comment added", actor);
      return toPageComment(result.rows[0]);
    },

    async deleteComment(id: string, commentId: string, actor = "local-user") {
      const result = await pageDb.query<PageCommentRow>(
        `
          update page_comments
          set deleted_at = now()
          where id = $1 and page_id = $2 and deleted_at is null
          returning *
        `,
        [commentId, id]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      await recordPageActivity(pageDb, id, "comment.deleted", "Comment removed", actor);
      return toPageComment(row);
    },

    async createShareLink(
      id: string,
      input: {
        label?: string;
        accessLevel?: PageShareLink["accessLevel"];
        password?: string | null;
        expiresAt?: string | null;
        actor?: string;
      }
    ) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const actor = input.actor ?? "local-user";
      const passwordHash = input.password?.trim() ? await hashSharePassword(input.password.trim()) : null;
      const result = await pageDb.query<PageShareLinkRow>(
        `
          insert into page_share_links (id, page_id, token, label, access_level, password_hash, expires_at, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          returning *
        `,
        [
          randomUUID(),
          id,
          randomUUID().replaceAll("-", ""),
          input.label?.trim() || "Share link",
          input.accessLevel ?? "view",
          passwordHash,
          input.expiresAt ?? null,
          actor
        ]
      );
      await recordPageActivity(pageDb, id, "share.created", "Share link created", actor);
      return toPageShareLink(result.rows[0]);
    },

    async revokeShareLink(id: string, shareLinkId: string, actor = "local-user") {
      const result = await pageDb.query<PageShareLinkRow>(
        `
          update page_share_links
          set revoked_at = now()
          where id = $1 and page_id = $2 and revoked_at is null
          returning *
        `,
        [shareLinkId, id]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      await recordPageActivity(pageDb, id, "share.revoked", "Share link revoked", actor);
      return toPageShareLink(row);
    },

    async updatePermissions(
      id: string,
      input: { visibility?: Page["visibility"]; owner?: string; permissionNote?: string | null; actor?: string }
    ) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      const actor = input.actor ?? "local-user";
      const visibility = input.visibility ?? page.visibility;
      const owner = input.owner?.trim() || page.owner;
      const permissionNote = input.permissionNote === undefined ? page.permissionNote : input.permissionNote?.trim() || null;
      const result = await pageDb.query<PageRow>(
        `
          update pages
          set visibility = $2,
              owner = $3,
              permission_note = $4,
              updated_by = $5,
              updated_at = now()
          where id = $1
          returning *
        `,
        [id, visibility, owner, permissionNote, actor]
      );
      await recordPageActivity(pageDb, id, "permissions.updated", "Permissions updated", actor, {
        visibility,
        owner
      });
      return toPage(result.rows[0]);
    },

    async listVersions(id: string) {
      const page = await this.get(id);
      if (!page) {
        return null;
      }

      // File mode: history is git. Version id = commit hash. Follow renames by
      // unioning history across the current path and every prior slug.
      if (fileMode) {
        const stored = await workspace!.readPage(page.slug);
        const previousSlugs = (stored?.frontmatter.previousSlugs as string[] | undefined) ?? [];
        const paths = [page.slug, ...previousSlugs].map((s) => workspace!.pageFilePath(s));
        const seen = new Set<string>();
        const commits: { hash: string; author: { name: string }; timestamp: number }[] = [];
        for (const p of paths) {
          for (const c of await gitWriter!.history(p)) {
            if (!seen.has(c.hash)) {
              seen.add(c.hash);
              commits.push(c);
            }
          }
        }
        commits.sort((a, b) => b.timestamp - a.timestamp);
        return commits.map<PageVersion>((c) => ({
          id: c.hash,
          pageId: id,
          title: page.title,
          slug: page.slug,
          html: "",
          plainText: "",
          createdBy: c.author.name,
          createdAt: new Date(c.timestamp * 1000).toISOString(),
        }));
      }

      const result = await pageDb.query<PageVersionRow>(
        `
          select *
          from page_versions
          where page_id = $1
          order by created_at desc
        `,
        [id]
      );
      return result.rows.map(toPageVersion);
    },

    async getVersion(id: string, versionId: string) {
      // File mode: read the page file as of the commit and re-derive HTML.
      if (fileMode) {
        const page = await this.get(id);
        if (!page) return null;
        // The commit may have touched a prior path (pre-rename), so try the
        // current slug first, then any previous slugs.
        const current = await workspace!.readPage(page.slug);
        const previousSlugs = (current?.frontmatter.previousSlugs as string[] | undefined) ?? [];
        let raw: string | null = null;
        for (const s of [page.slug, ...previousSlugs]) {
          try {
            raw = await gitWriter!.restore(versionId, workspace!.pageFilePath(s));
            break;
          } catch {
            // try the next path
          }
        }
        if (raw === null) return null;
        const stored = workspace!.parsePage(raw);
        const html = workspace!.sanitizePageHtml(workspace!.markdownToHtml(stored.markdown));
        const meta = await gitWriter!.commitMeta(versionId);
        return {
          id: versionId,
          pageId: id,
          title: stored.frontmatter.title,
          slug: page.slug,
          html,
          plainText: stripHtml(html),
          // Attribution comes from the commit, matching listVersions.
          createdBy: meta?.author.name ?? "unknown",
          createdAt: meta
            ? new Date(meta.timestamp * 1000).toISOString()
            : (stored.frontmatter.updated ?? new Date().toISOString()),
        } satisfies PageVersion;
      }

      const result = await pageDb.query<PageVersionRow>(
        `
          select *
          from page_versions
          where page_id = $1 and id = $2
        `,
        [id, versionId]
      );
      const row = result.rows[0];
      return row ? toPageVersion(row) : null;
    },

    async restoreVersion(id: string, versionId: string, actor = "local-user") {
      const version = await this.getVersion(id, versionId);
      if (!version) {
        return null;
      }

      return this.update(id, {
        title: version.title,
        html: version.html,
        actor
      });
    },

    async create(input: PageInput) {
      const actor = input.actor ?? "local-user";
      const id = randomUUID();
      const pageInput = preparePageInput(input);
      const slug = await ensureUniqueSlug(pageDb, pageInput.title);
      const prepared = prepareHtml(pageInput.html);

      if (fileMode) {
        const now = new Date().toISOString();
        const page: Page = {
          id,
          title: pageInput.title,
          slug,
          html: prepared.html,
          plainText: prepared.plainText,
          creator: actor,
          createdBy: actor,
          updatedBy: actor,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          pinnedOrder: input.pinnedOrder ?? null,
          parentPageId: input.parentPageId ?? null,
          visibility: input.visibility ?? "workspace",
          owner: input.owner?.trim() || actor,
          permissionNote: input.permissionNote?.trim() || null,
        };
        const saved = await persistPageFileMode(page, actor);
        await recordPageActivity(pageDb, id, "page.created", `Created ${saved.title}`, actor);
        return saved;
      }

      const result = await pageDb.query<PageRow>(
        `
          insert into pages (
            id, title, slug, html, plain_text, creator, created_by, updated_by,
            pinned_order, parent_page_id, visibility, owner, permission_note
          )
          values ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9, $10, $11)
          returning *
        `,
        [
          id,
          pageInput.title,
          slug,
          prepared.html,
          prepared.plainText,
          actor,
          input.pinnedOrder ?? null,
          input.parentPageId ?? null,
          input.visibility ?? "workspace",
          input.owner?.trim() || actor,
          input.permissionNote?.trim() || null
        ]
      );
      const page = toPage(result.rows[0]);
      await writeLinks(pageDb, id, prepared.links);
      await reindexPageChunks(pageDb, id, page.title, page.html);
      await snapshotPage(pageDb, page, actor);
      await recordPageActivity(pageDb, id, "page.created", `Created ${page.title}`, actor);

      return page;
    },

    async createWithSlug(input: PageInput & { slug: string }) {
      const actor = input.actor ?? "local-user";
      const id = randomUUID();
      const pageInput = preparePageInput(input);
      const slug = await ensureUniqueSlugFromBase(pageDb, input.slug);
      const prepared = prepareHtml(pageInput.html);

      if (fileMode) {
        const now = new Date().toISOString();
        const page: Page = {
          id,
          title: pageInput.title,
          slug,
          html: prepared.html,
          plainText: prepared.plainText,
          creator: actor,
          createdBy: actor,
          updatedBy: actor,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          pinnedOrder: input.pinnedOrder ?? null,
          parentPageId: input.parentPageId ?? null,
          visibility: input.visibility ?? "workspace",
          owner: input.owner?.trim() || actor,
          permissionNote: input.permissionNote?.trim() || null,
        };
        const saved = await persistPageFileMode(page, actor);
        await recordPageActivity(pageDb, id, "page.created", `Created ${saved.title}`, actor);
        return saved;
      }

      const result = await pageDb.query<PageRow>(
        `
          insert into pages (
            id, title, slug, html, plain_text, creator, created_by, updated_by,
            pinned_order, parent_page_id, visibility, owner, permission_note
          )
          values ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9, $10, $11)
          returning *
        `,
        [
          id,
          pageInput.title,
          slug,
          prepared.html,
          prepared.plainText,
          actor,
          input.pinnedOrder ?? null,
          input.parentPageId ?? null,
          input.visibility ?? "workspace",
          input.owner?.trim() || actor,
          input.permissionNote?.trim() || null
        ]
      );
      const page = toPage(result.rows[0]);
      await writeLinks(pageDb, id, prepared.links);
      await reindexPageChunks(pageDb, id, page.title, page.html);
      await snapshotPage(pageDb, page, actor);
      await recordPageActivity(pageDb, id, "page.created", `Created ${page.title}`, actor);

      return page;
    },

    async ensureParaWorkspace(actor = "local-user") {
      const pages: Page[] = [];

      for (const template of paraPages) {
        const existing = await getBySlug(template.slug);
        if (existing) {
          if (existing.pinnedOrder !== template.pinnedOrder) {
            const result = await pageDb.query<PageRow>(
              "update pages set pinned_order = $1 where id = $2 returning *",
              [template.pinnedOrder, existing.id]
            );
            pages.push(toPage(result.rows[0]));
          } else {
            pages.push(existing);
          }
          continue;
        }

        pages.push(
          await this.createWithSlug({
            title: template.title,
            slug: template.slug,
            html: template.html,
            actor,
            pinnedOrder: template.pinnedOrder
          })
        );
      }

      return pages;
    },

    async createProject(projectName: string, actor = "local-user") {
      await this.ensureParaWorkspace(actor);
      const projectsRoot = await getBySlug("projects");
      const projectSlug = `projects/${slugify(projectName)}`;
      const pages: Page[] = [];

      for (const template of projectPageTemplates) {
        const slug = `${projectSlug}/${template.suffix}`;
        const existing = await getBySlug(slug);
        if (existing) {
          pages.push(existing);
          continue;
        }

        pages.push(
          await this.createWithSlug({
            title: `${projectName} ${template.title}`,
            slug,
            html: template.html(projectName),
            actor,
            parentPageId: projectsRoot?.id ?? null
          })
        );
      }

      return pages;
    },

    async update(id: string, input: Partial<PageInput>) {
      const current = await this.get(id);
      if (!current) {
        return null;
      }

      const actor = input.actor ?? "local-user";
      const pageInput = preparePageInput(
        {
          title: input.title ?? current.title,
          html: input.html ?? current.html,
          titleProvided: Boolean(input.title)
        },
        current
      );
      const title = pageInput.title;
      const slug = title !== current.title ? await ensureUniqueSlug(pageDb, title, id) : current.slug;
      const prepared = prepareHtml(pageInput.html);

      if (fileMode) {
        const now = new Date().toISOString();
        const page: Page = {
          ...current,
          title,
          slug,
          html: prepared.html,
          plainText: prepared.plainText,
          updatedBy: actor,
          updatedAt: now,
        };
        const saved = await persistPageFileMode(page, actor, current.slug);
        await recordPageActivity(pageDb, id, "page.updated", `Updated ${saved.title}`, actor, {
          previousTitle: current.title,
          title: saved.title,
        });
        return saved;
      }

      const result = await pageDb.query<PageRow>(
        `
          update pages
          set title = $2,
              slug = $3,
              html = $4,
              plain_text = $5,
              updated_by = $6,
              updated_at = now()
          where id = $1
          returning *
        `,
        [id, title, slug, prepared.html, prepared.plainText, actor]
      );
      const page = toPage(result.rows[0]);
      await writeLinks(pageDb, id, prepared.links);
      await reindexPageChunks(pageDb, id, page.title, page.html);
      await snapshotPage(pageDb, page, actor);
      await recordPageActivity(pageDb, id, "page.updated", `Updated ${page.title}`, actor, {
        previousTitle: current.title,
        title: page.title
      });

      return page;
    },

    async move(id: string, input: { parentPageId?: string | null; actor?: string }) {
      const current = await this.get(id);
      if (!current || current.slug === homePageSlug) {
        return null;
      }

      const parentId = input.parentPageId ?? null;
      if (parentId === id) {
        throw new Error("A page cannot be moved under itself.");
      }

      if (parentId) {
        const parent = await this.get(parentId);
        if (!parent) {
          throw new Error("Parent page not found.");
        }

        let nextParentId = parent.parentPageId;
        while (nextParentId) {
          if (nextParentId === id) {
            throw new Error("A page cannot be moved under one of its children.");
          }
          const nextParent = await this.get(nextParentId);
          nextParentId = nextParent?.parentPageId ?? null;
        }
      }

      if (fileMode) {
        const actor = input.actor ?? "local-user";
        const page: Page = {
          ...current,
          parentPageId: parentId,
          updatedBy: actor,
          updatedAt: new Date().toISOString(),
        };
        const saved = await persistPageFileMode(page, actor);
        await recordPageActivity(pageDb, id, "page.moved", `Moved ${saved.title}`, actor, {
          parentPageId: parentId,
        });
        return saved;
      }

      const result = await pageDb.query<PageRow>(
        `
          update pages
          set parent_page_id = $2,
              updated_by = $3,
              updated_at = now()
          where id = $1
          returning *
        `,
        [id, parentId, input.actor ?? "local-user"]
      );

      const page = toPage(result.rows[0]);
      await recordPageActivity(pageDb, id, "page.moved", `Moved ${page.title}`, input.actor ?? "local-user", {
        parentPageId: parentId
      });
      return page;
    },

    async duplicate(id: string, actor = "local-user") {
      const current = await this.get(id);
      if (!current) {
        return null;
      }

      return this.create({
        title: `${current.title} copy`,
        html: current.html,
        actor,
        parentPageId: current.parentPageId,
        visibility: current.visibility,
        owner: current.owner,
        permissionNote: current.permissionNote
      });
    },

    async softDelete(id: string, actor = "local-user") {
      if (fileMode) {
        const current = await this.get(id);
        if (!current || current.slug === homePageSlug) {
          return null;
        }
        await deletePageFile(current.slug, actor);
        await reindexPages(pageDb, workspace!, [current.slug]); // file gone -> tombstone
        await recordPageActivity(pageDb, id, "page.deleted", `Deleted ${current.title}`, actor);
        return { ...current, deletedAt: new Date().toISOString() };
      }

      const result = await pageDb.query<PageRow>(
        `
          update pages
          set deleted_at = now(), updated_by = $2, updated_at = now()
          where id = $1 and slug <> $3
          returning *
        `,
        [id, actor, homePageSlug]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const page = toPage(row);
      await recordPageActivity(pageDb, id, "page.deleted", `Deleted ${page.title}`, actor);
      return page;
    }
  };
}

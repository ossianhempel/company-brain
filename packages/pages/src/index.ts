import { randomUUID } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { createDb, type CompanyBrainDb } from "@company-brain/db";

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

type PageInput = {
  title: string;
  html: string;
  actor?: string;
  pinnedOrder?: number | null;
  parentPageId?: string | null;
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
    parentPageId: row.parent_page_id
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

  const sanitizedHtml = sanitizeHtml(withInternalLinks, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["h1", "h2", "img"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel", "data-page-slug"],
      img: ["src", "alt", "title", "width", "height", "loading"]
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noreferrer" }, true),
      img: sanitizeHtml.simpleTransform("img", { loading: "lazy" }, true)
    }
  });

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

export async function createPageStore(db?: CompanyBrainDb) {
  const pageDb = db ?? (await createDb());

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
        relatedPages: backlinks
      };
    },

    async listVersions(id: string) {
      const page = await this.get(id);
      if (!page) {
        return null;
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
      const result = await pageDb.query<PageRow>(
        `
          insert into pages (id, title, slug, html, plain_text, creator, created_by, updated_by, pinned_order, parent_page_id)
          values ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8)
          returning *
        `,
        [id, pageInput.title, slug, prepared.html, prepared.plainText, actor, input.pinnedOrder ?? null, input.parentPageId ?? null]
      );
      const page = toPage(result.rows[0]);
      await writeLinks(pageDb, id, prepared.links);
      await reindexPageChunks(pageDb, id, page.title, page.html);
      await snapshotPage(pageDb, page, actor);

      return page;
    },

    async createWithSlug(input: PageInput & { slug: string }) {
      const actor = input.actor ?? "local-user";
      const id = randomUUID();
      const pageInput = preparePageInput(input);
      const slug = await ensureUniqueSlugFromBase(pageDb, input.slug);
      const prepared = prepareHtml(pageInput.html);
      const result = await pageDb.query<PageRow>(
        `
          insert into pages (id, title, slug, html, plain_text, creator, created_by, updated_by, pinned_order, parent_page_id)
          values ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8)
          returning *
        `,
        [id, pageInput.title, slug, prepared.html, prepared.plainText, actor, input.pinnedOrder ?? null, input.parentPageId ?? null]
      );
      const page = toPage(result.rows[0]);
      await writeLinks(pageDb, id, prepared.links);
      await reindexPageChunks(pageDb, id, page.title, page.html);
      await snapshotPage(pageDb, page, actor);

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

      return toPage(result.rows[0]);
    },

    async duplicate(id: string, actor = "local-user") {
      const current = await this.get(id);
      if (!current) {
        return null;
      }

      return this.create({
        title: `${current.title} copy`,
        html: current.html,
        actor
      });
    },

    async softDelete(id: string, actor = "local-user") {
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
      return row ? toPage(row) : null;
    }
  };
}

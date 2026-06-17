import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type Page = {
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

type PageDetail = Page & {
  outgoingLinks: Array<{
    sourcePageId: string;
    targetPageId: string | null;
    targetSlug: string;
    targetTitle: string;
  }>;
  backlinks: Page[];
  relatedPages: Page[];
};

type PageSearchResult = {
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

type PageVersion = {
  id: string;
  pageId: string;
  title: string;
  slug: string;
  html: string;
  plainText: string;
  createdBy: string;
  createdAt: string;
};

type RecallResponse = {
  query: string;
  searchMode: "bm25_local_v1" | "lexical_v1";
  results: Array<{
    type: "memory" | "page_chunk" | "source_chunk";
    id: string;
    sourceId: string;
    title: string;
    snippet: string;
    score: number;
    citation: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }>;
};

const memorySourceInput = z.object({
  sourceType: z.enum(["page", "page_chunk", "artifact", "source_chunk", "manual"]),
  pageId: z.string().min(1).nullable().optional(),
  pageChunkId: z.string().min(1).nullable().optional(),
  artifactId: z.string().min(1).nullable().optional(),
  sourceChunkId: z.string().min(1).nullable().optional(),
  quote: z.string().nullable().optional()
});

const apiUrl = process.env.COMPANY_BRAIN_API_URL ?? "http://localhost:3000";

const server = new McpServer({
  name: "company-brain-mcp-server",
  version: "0.1.0"
});

async function requestApi<T>(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers
      }
    });
  } catch {
    throw new Error(`Company Brain API is not reachable at ${apiUrl}. Start the app with pnpm dev first.`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Company Brain API request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

async function listPages() {
  return (await requestApi<{ pages: Page[] }>("/api/pages")).pages;
}

async function searchPages(query: string, limit: number) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return (await requestApi<{ results: PageSearchResult[] }>(`/api/search/pages?${params}`)).results;
}

async function findPage(ref: string) {
  const slug = ref.startsWith("/") ? ref.slice(1) : ref;
  const pages = await listPages();
  return pages.find((page) => page.id === ref || page.slug === slug) ?? null;
}

function toolResult<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

server.registerTool(
  "company_brain_doctor",
  {
    title: "Check Company Brain Health",
    description: "Check whether the Company Brain API is reachable and has a Home page.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => {
    const health = await requestApi<{ ok: boolean }>("/health");
    const pages = await listPages();
    return toolResult({
      ok: health.ok && pages.some((page) => page.slug === "home"),
      api: apiUrl,
      pageCount: pages.length,
      homePage: pages.find((page) => page.slug === "home") ?? null
    });
  }
);

server.registerTool(
  "company_brain_list_pages",
  {
    title: "List Company Brain Pages",
    description: "List active pages with ids, slugs, titles, and metadata. Use before get/update/delete when you need a page reference.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async () => toolResult({ pages: await listPages() })
);

server.registerTool(
  "company_brain_init_workspace",
  {
    title: "Initialize Company Brain Workspace",
    description:
      "Create or repair the default Home/PARA workspace roots. This creates Projects, Areas, Resources, and Archive when missing and preserves existing pages.",
    inputSchema: {
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ actor }) => {
    return toolResult(
      await requestApi<{ pages: Page[] }>("/api/workspace/init", {
        method: "POST",
        body: JSON.stringify({ actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_create_project",
  {
    title: "Create Company Brain Project",
    description:
      "Create a project workspace under Projects with standard start, decisions, deadlines, people, links, activity log, and open questions pages. Existing project pages are reused.",
    inputSchema: {
      name: z.string().min(1).describe("Project name, for example 'Client Portal'."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ name, actor }) => {
    return toolResult(
      await requestApi<{ pages: Page[] }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_get_page",
  {
    title: "Get Company Brain Page",
    description: "Get a page by id or slug, including HTML, outgoing links, backlinks, and related pages.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug, for example 'home' or '/home'.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ ref }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(await requestApi<{ page: PageDetail }>(`/api/pages/${page.id}`));
  }
);

server.registerTool(
  "company_brain_search_pages",
  {
    title: "Search Company Brain Pages",
    description:
      "Search active pages by title, slug, and HTML-derived plain text. Returns ranked candidates with snippets; use company_brain_get_page to hydrate a result.",
    inputSchema: {
      query: z.string().min(1).describe("Search query."),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum results to return.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ query, limit }) => {
    return toolResult({ results: await searchPages(query, limit) });
  }
);

server.registerTool(
  "company_brain_recall",
  {
    title: "Recall Company Brain Context",
    description:
      "Recall mixed context across active memories, page chunks, and source artifact chunks. Default searchMode is explicit bm25_local_v1; this is local keyword ranking, not vector search.",
    inputSchema: {
      query: z.string().min(1).describe("Recall query."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return."),
      mode: z
        .enum(["bm25_local_v1", "lexical_v1"])
        .default("bm25_local_v1")
        .describe("Recall mode. bm25_local_v1 is local keyword ranking. lexical_v1 is the older exact term-overlap mode.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ query, limit, mode }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit), mode });
    return toolResult(await requestApi<RecallResponse>(`/api/recall?${params}`));
  }
);

server.registerTool(
  "company_brain_list_entities",
  {
    title: "List Entities",
    description:
      "List the brain's entities (people, teams, projects, repos, topics) — the subjects memory is organized around. Optionally filter by type.",
    inputSchema: {
      type: z.string().optional().describe("Optional entity type filter (e.g. person, team, project, repo, topic).")
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ type }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    const query = params.toString();
    return toolResult(await requestApi<{ entities: unknown[] }>(`/api/entities${query ? `?${query}` : ""}`));
  }
);

server.registerTool(
  "company_brain_get_profile",
  {
    title: "Get Entity Profile",
    description:
      "Get an entity's profile — its compiled-truth summary plus active memories — by slug. Use company_brain_list_entities to find slugs.",
    inputSchema: {
      slug: z.string().min(1).describe("Entity slug.")
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ slug }) => {
    return toolResult(await requestApi<{ entity: unknown; memories: unknown[] }>(`/api/entities/${encodeURIComponent(slug)}`));
  }
);

server.registerTool(
  "company_brain_ingest_source_artifact",
  {
    title: "Ingest Company Brain Source Artifact",
    description:
      "Store raw non-page source text as a source artifact and chunk it for recall. Use for chats, connector records, notes, or imports that should not become HTML pages.",
    inputSchema: {
      sourceType: z.string().min(1).default("manual").describe("Source type, for example manual, chat, slack, file."),
      title: z.string().min(1).describe("Artifact title."),
      rawText: z.string().min(1).describe("Raw text to store and chunk."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ sourceType, title, rawText, actor }) => {
    return toolResult(
      await requestApi<{ artifact: unknown }>("/api/source-artifacts", {
        method: "POST",
        body: JSON.stringify({ sourceType, title, rawText, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_save_memory",
  {
    title: "Save Company Brain Memory",
    description:
      "Save an explicit source-grounded memory. Sources are optional in this first surface but should be provided whenever possible.",
    inputSchema: {
      kind: z.enum(["fact", "decision", "preference", "status", "contradiction"]).describe("Memory kind."),
      content: z.string().min(1).describe("Memory content."),
      subject: z.string().min(1).optional().describe("Optional subject, such as a project, repo, person, or company."),
      confidence: z.number().min(0).max(1).default(1).describe("Confidence from 0 to 1."),
      sources: z
        .array(memorySourceInput)
        .default([])
        .describe("Optional source citations. Prefer artifact/source_chunk/page references over unsourced memory."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ kind, content, subject, confidence, sources, actor }) => {
    return toolResult(
      await requestApi<{ memory: unknown }>("/api/memories", {
        method: "POST",
        body: JSON.stringify({ kind, content, subject, confidence, sources, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_forget_source_artifact",
  {
    title: "Forget Company Brain Source Artifact",
    description:
      "Soft-delete a source artifact so its chunks stop appearing in recall. Use when an ingested raw source was a test, mistake, or should no longer be active.",
    inputSchema: {
      artifactId: z.string().min(1).describe("Source artifact id."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ artifactId, actor }) => {
    return toolResult(
      await requestApi<{ artifact: unknown }>(`/api/source-artifacts/${artifactId}/forget`, {
        method: "POST",
        body: JSON.stringify({ actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_forget_memory",
  {
    title: "Forget Company Brain Memory",
    description: "Mark an explicit memory as forgotten. This removes it from active recall without deleting the row.",
    inputSchema: {
      memoryId: z.string().min(1).describe("Memory id."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ memoryId, actor }) => {
    return toolResult(
      await requestApi<{ memory: unknown }>(`/api/memories/${memoryId}/forget`, {
        method: "POST",
        body: JSON.stringify({ actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_list_page_versions",
  {
    title: "List Company Brain Page Versions",
    description: "List saved versions for a page by id or slug. Use before restoring a page version.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ ref }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(await requestApi<{ versions: PageVersion[] }>(`/api/pages/${page.id}/versions`));
  }
);

server.registerTool(
  "company_brain_get_page_version",
  {
    title: "Get Company Brain Page Version",
    description: "Get a saved page version including title, slug, HTML, plain text, actor, and timestamp.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug."),
      versionId: z.string().min(1).describe("Page version id.")
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ ref, versionId }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(await requestApi<{ version: PageVersion }>(`/api/pages/${page.id}/versions/${versionId}`));
  }
);

server.registerTool(
  "company_brain_create_page",
  {
    title: "Create Company Brain Page",
    description: "Create a sanitized HTML page. Use [[Page Title]] syntax in HTML to create standardized internal links.",
    inputSchema: {
      title: z.string().min(1).describe("Page title."),
      html: z.string().min(1).describe("HTML content. The server sanitizes unsafe HTML and converts [[Page]] links."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ title, html, actor }) => {
    return toolResult(
      await requestApi<{ page: Page }>("/api/pages", {
        method: "POST",
        body: JSON.stringify({ title, html, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_update_page_html",
  {
    title: "Update Company Brain Page",
    description: "Update a page title and/or HTML by id or slug. HTML is sanitized and [[Page]] links are normalized.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug."),
      title: z.string().min(1).optional().describe("New page title. Omit to keep current title."),
      html: z.string().min(1).optional().describe("New HTML content. Omit to keep current HTML."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ ref, title, html, actor }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(
      await requestApi<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ title, html, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_restore_page_version",
  {
    title: "Restore Company Brain Page Version",
    description:
      "Restore a saved page version by id. This updates the current page and creates a new version snapshot; it does not delete version history.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug."),
      versionId: z.string().min(1).describe("Page version id."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ ref, versionId, actor }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(
      await requestApi<{ page: Page }>(`/api/pages/${page.id}/versions/${versionId}/restore`, {
        method: "POST",
        body: JSON.stringify({ actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_duplicate_page",
  {
    title: "Duplicate Company Brain Page",
    description: "Duplicate an existing page by id or slug.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ ref, actor }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(
      await requestApi<{ page: Page }>(`/api/pages/${page.id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_move_page",
  {
    title: "Move Company Brain Page",
    description: "Move a page under another page, or move it back to the top level. Use to organize pages under Projects, Areas, Resources, or Archive.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug to move."),
      parentRef: z.string().min(1).optional().describe("Parent page id or slug. Omit to move to top level."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ ref, parentRef, actor }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    const parent = parentRef ? await findPage(parentRef) : null;
    if (parentRef && !parent) {
      throw new Error(`Parent page not found: ${parentRef}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(
      await requestApi<{ page: Page }>(`/api/pages/${page.id}/move`, {
        method: "POST",
        body: JSON.stringify({ parentPageId: parent?.id ?? null, actor })
      })
    );
  }
);

server.registerTool(
  "company_brain_delete_page",
  {
    title: "Delete Company Brain Page",
    description: "Soft-delete a page by id or slug. The Home page is protected by the backend.",
    inputSchema: {
      ref: z.string().min(1).describe("Page id or slug."),
      actor: z.string().min(1).default("mcp").describe("Actor name recorded in page metadata.")
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ ref, actor }) => {
    const page = await findPage(ref);
    if (!page) {
      throw new Error(`Page not found: ${ref}. Use company_brain_list_pages to find available pages.`);
    }

    return toolResult(
      await requestApi<{ page: Page }>(`/api/pages/${page.id}`, {
        method: "DELETE",
        body: JSON.stringify({ actor })
      })
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

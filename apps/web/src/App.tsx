import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Link from "@tiptap/extension-link";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import "./styles.css";

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
  visibility: "workspace" | "restricted" | "public";
  owner: string;
  permissionNote: string | null;
};

type PageDetail = Page & {
  version?: string | null;
  backlinks: Page[];
  relatedPages: Page[];
  comments: PageComment[];
  shareLinks: PageShareLink[];
  activity: PageActivity[];
  sources: PageSourceArtifact[];
};

type PageComment = {
  id: string;
  pageId: string;
  body: string;
  anchorText: string | null;
  createdBy: string;
  createdAt: string;
  deletedAt: string | null;
};

type PageShareLink = {
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

type PageActivity = {
  id: string;
  pageId: string | null;
  eventType: string;
  summary: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type PageSourceArtifact = {
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

type MemorySource = {
  id: string;
  memoryId: string;
  sourceType: "page" | "page_chunk" | "artifact" | "source_chunk" | "manual";
  pageId: string | null;
  pageChunkId: string | null;
  artifactId: string | null;
  sourceChunkId: string | null;
  quote: string | null;
};

type MemoryRecord = {
  id: string;
  kind: "fact" | "decision" | "preference" | "status" | "contradiction";
  content: string;
  subject: string | null;
  status: "active" | "superseded" | "forgotten";
  confidence: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  forgottenAt: string | null;
  supersededByMemoryId: string | null;
  sources: MemorySource[];
};

type EntitySummary = {
  id: string;
  slug: string;
  title: string;
  type: string;
  profile: string;
  tags: string[];
};

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
  schedule: string | null;
  tags: string[];
};

type JobSummary = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  schedule: string;
  agent: string;
  provider: string | null;
};

type ConversationSummary = {
  id: string;
  agent: string;
  job: string | null;
  status: "running" | "awaiting_input" | "done" | "failed" | "archived";
  provider: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
};

type ConversationDetail = ConversationSummary & { turns: Array<{ role: string; content: string }> };

type ProviderStatus = {
  id: string;
  detection: { available: boolean; version?: string; path?: string; error?: string };
};

const TASK_LANES: Array<{ key: ConversationSummary["status"]; label: string }> = [
  { key: "awaiting_input", label: "Your turn" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
  { key: "archived", label: "Archived" }
];

type RecallResult = {
  type: "memory" | "page_chunk" | "source_chunk";
  id: string;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  citation: {
    label: string;
    pageId?: string;
    pageSlug?: string;
    pageChunkId?: string;
    artifactId?: string;
    sourceChunkId?: string;
  };
  metadata: Record<string, unknown>;
};

type RecallResponse = {
  query: string;
  searchMode: "bm25_local_v1" | "lexical_v1";
  results: RecallResult[];
};

type DragTarget = { type: "root" } | { type: "page"; pageId: string };
type PagePanelTab = "related" | "sources" | "comments" | "share" | "activity";

function recallSources(result: RecallResult) {
  const sources = result.metadata.sources;
  return Array.isArray(sources) ? (sources as MemorySource[]) : [];
}

const starterHtml = "<h1>New page</h1><p>Write the company context here.</p>";
const firstHeadingPattern = /<h1\b[^>]*>(.*?)<\/h1>/is;
const genericTitles = new Set(["", "untitled", "untitled page", "new page"]);

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled";
}

function stripHtml(value: string) {
  const element = document.createElement("div");
  element.innerHTML = value;
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string) {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function isGenericTitle(value: string) {
  return genericTitles.has(value.trim().toLowerCase());
}

function getFirstHeadingText(value: string) {
  const match = value.match(firstHeadingPattern);
  return match ? stripHtml(match[1]) : null;
}

function htmlWithFirstHeading(value: string, heading: string) {
  const nextHeading = `<h1>${escapeHtml(heading)}</h1>`;
  if (firstHeadingPattern.test(value)) {
    return value.replace(firstHeadingPattern, nextHeading);
  }

  return `${nextHeading}${value}`;
}

function orderPages(pages: Page[]) {
  return [...pages].sort((a, b) => {
    if (a.pinnedOrder !== null || b.pinnedOrder !== null) {
      if (a.pinnedOrder === null) {
        return 1;
      }
      if (b.pinnedOrder === null) {
        return -1;
      }
      return a.pinnedOrder - b.pinnedOrder;
    }

    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function mergePages(current: Page[], incoming: Page[]) {
  const byId = new Map(current.map((page) => [page.id, page]));
  for (const page of incoming) {
    byId.set(page.id, page);
  }

  return orderPages([...byId.values()]);
}

function pageDepth(page: Page, pages: Page[]) {
  let depth = 0;
  let parentId = page.parentPageId;
  const seen = new Set<string>([page.id]);
  while (parentId && !seen.has(parentId)) {
    const parent = pages.find((candidate) => candidate.id === parentId);
    if (!parent) {
      break;
    }
    depth += 1;
    seen.add(parent.id);
    parentId = parent.parentPageId;
  }
  return Math.min(depth, 3);
}

function treeOrderPages(pages: Page[]) {
  const byParent = new Map<string | null, Page[]>();
  const ids = new Set(pages.map((page) => page.id));
  for (const page of pages) {
    const parentId = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : null;
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), page]);
  }

  const result: Page[] = [];
  const visit = (parentId: string | null) => {
    for (const page of orderPages(byParent.get(parentId) ?? [])) {
      result.push(page);
      visit(page.id);
    }
  };
  visit(null);
  return result;
}

function isDescendantPage(candidateParentId: string, pageId: string, pages: Page[]) {
  let parentId: string | null = candidateParentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (parentId === pageId) {
      return true;
    }
    seen.add(parentId);
    parentId = pages.find((page) => page.id === parentId)?.parentPageId ?? null;
  }
  return false;
}

function Icon({
  name,
  size = 16
}: {
  name:
    | "bold"
    | "code"
    | "doc"
    | "dots"
    | "history"
    | "html"
    | "italic"
    | "link"
    | "list"
    | "plus"
    | "save"
    | "search"
    | "spark"
    | "trash";
  size?: number;
}) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {name === "doc" && (
        <>
          <path d="M7.5 3.5h6l3 3v14h-9z" />
          <path d="M13.5 3.5v3h3" />
          <path d="M9.5 11.5h5" />
          <path d="M9.5 15h5" />
        </>
      )}
      {name === "bold" && <path d="M8.5 5.5h4.25a3 3 0 0 1 0 6h-4.25zM8.5 11.5h5a3.5 3.5 0 0 1 0 7h-5z" />}
      {name === "italic" && (
        <>
          <path d="M11 5.5h6" />
          <path d="M7 18.5h6" />
          <path d="M14 5.5l-4 13" />
        </>
      )}
      {name === "code" && (
        <>
          <path d="M9.5 8l-4 4 4 4" />
          <path d="M14.5 8l4 4-4 4" />
        </>
      )}
      {name === "html" && (
        <>
          <path d="M8.5 8l-4 4 4 4" />
          <path d="M15.5 8l4 4-4 4" />
          <path d="M13.5 5.5l-3 13" />
        </>
      )}
      {name === "history" && (
        <>
          <path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" />
          <path d="M5.5 5.5v4h4" />
          <path d="M12 8.5V12l2.5 2" />
        </>
      )}
      {name === "link" && (
        <>
          <path d="M9.5 13.5l5-5" />
          <path d="M10.5 7.5l.9-.9a4 4 0 0 1 5.7 5.7l-.9.9" />
          <path d="M13.5 16.5l-.9.9a4 4 0 0 1-5.7-5.7l.9-.9" />
        </>
      )}
      {name === "list" && (
        <>
          <path d="M8.5 7h10" />
          <path d="M8.5 12h10" />
          <path d="M8.5 17h10" />
          <path d="M5.5 7h.01" />
          <path d="M5.5 12h.01" />
          <path d="M5.5 17h.01" />
        </>
      )}
      {name === "plus" && (
        <>
          <path d="M12 5.5v13" />
          <path d="M5.5 12h13" />
        </>
      )}
      {name === "dots" && (
        <>
          <circle cx="6.5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="17.5" cy="12" r="1" />
        </>
      )}
      {name === "save" && (
        <>
          <path d="M5.5 4.5h11l2 2v13h-13z" />
          <path d="M8 4.5v5h7" />
          <path d="M8.5 19.5v-6h7v6" />
        </>
      )}
      {name === "trash" && (
        <>
          <path d="M6.5 8h11" />
          <path d="M9 8v11h6V8" />
          <path d="M10 5h4l1 3h-6z" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="10.5" cy="10.5" r="5.75" />
          <path d="M15 15l4.5 4.5" />
        </>
      )}
      {name === "spark" && (
        <>
          <path d="M12 4.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" />
          <path d="M18 4.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
        </>
      )}
    </svg>
  );
}

export function App() {
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState(starterHtml);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PageSearchResult[]>([]);
  const [pageDetail, setPageDetail] = useState<PageDetail | null>(null);
  const [openMenuPageId, setOpenMenuPageId] = useState<string | null>(null);
  const [htmlMode, setHtmlMode] = useState(false);
  const [pageLinkPickerOpen, setPageLinkPickerOpen] = useState(false);
  const [pageLinkQuery, setPageLinkQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [memoryViewOpen, setMemoryViewOpen] = useState(false);
  const [teamViewOpen, setTeamViewOpen] = useState(false);
  const [tasksViewOpen, setTasksViewOpen] = useState(false);
  const [teamAgents, setTeamAgents] = useState<AgentSummary[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState<string | null>(null);
  const [teamJobs, setTeamJobs] = useState<JobSummary[]>([]);
  const [agentPersona, setAgentPersona] = useState("");
  const [agentPersonaSaveState, setAgentPersonaSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [agentRuns, setAgentRuns] = useState<ConversationSummary[]>([]);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentRunError, setAgentRunError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<ConversationDetail | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onbStep, setOnbStep] = useState(0);
  const [onbName, setOnbName] = useState("Scribe");
  const [onbProvider, setOnbProvider] = useState("");
  const [onbPersona, setOnbPersona] = useState("You are a helpful company-brain agent. Be concise and cite sources.");
  const [onbBusy, setOnbBusy] = useState(false);
  const [onbError, setOnbError] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [recallQuery, setRecallQuery] = useState("");
  const [recall, setRecall] = useState<RecallResponse | null>(null);
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactSourceType, setArtifactSourceType] = useState("manual");
  const [artifactText, setArtifactText] = useState("");
  const [memoryKind, setMemoryKind] = useState<MemoryRecord["kind"]>("fact");
  const [memorySubject, setMemorySubject] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [selectedEntitySlug, setSelectedEntitySlug] = useState<string | null>(null);
  const [entityMarkdown, setEntityMarkdown] = useState("");
  const [entitySaveState, setEntitySaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [pagePanelTab, setPagePanelTab] = useState<PagePanelTab>("related");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceType, setSourceType] = useState("manual");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [shareLabel, setShareLabel] = useState("");
  const [permissionOwner, setPermissionOwner] = useState("");
  const [permissionVisibility, setPermissionVisibility] = useState<Page["visibility"]>("workspace");
  const [permissionNote, setPermissionNote] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [draggingPageId, setDraggingPageId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const titleRef = useRef(title);
  const htmlRef = useRef(html);
  const lastHeadingRef = useRef<string | null>(null);
  const selectedPageRef = useRef<Page | null>(null);
  const dirtyRef = useRef(false);
  const loadingPageRef = useRef(false);
  const draggingPageIdRef = useRef<string | null>(null);

  // First-run onboarding: show the wizard when there are no agents yet and the
  // user hasn't dismissed it. Detection uses only existing read endpoints.
  useEffect(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem("cb.onboarded")) return;
    void (async () => {
      const agentsRes = await fetch("/api/agents");
      if (!agentsRes.ok) return;
      const { agents: existing } = (await agentsRes.json()) as { agents: AgentSummary[] };
      if (existing.length > 0) return;
      const providersRes = await fetch("/api/providers");
      if (providersRes.ok) {
        const { providers: detected } = (await providersRes.json()) as { providers: ProviderStatus[] };
        setProviders(detected);
        setOnbProvider(detected.find((p) => p.detection.available)?.id ?? detected[0]?.id ?? "");
      }
      setOnboardingOpen(true);
    })();
  }, []);

  function dismissOnboarding() {
    if (typeof localStorage !== "undefined") localStorage.setItem("cb.onboarded", "1");
    setOnboardingOpen(false);
  }

  async function createFirstAgent() {
    const name = onbName.trim();
    if (!name) return;
    setOnbBusy(true);
    setOnbError(null);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
      // The wizard is re-openable via Setup — don't clobber an existing agent.
      const existing = await fetch(`/api/agents/${encodeURIComponent(slug)}`);
      if (existing.ok) {
        setOnbError(`An agent "${slug}" already exists — choose a different name (or edit it in Team).`);
        return;
      }
      const response = await fetch(`/api/agents/${encodeURIComponent(slug)}/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: onbPersona, name, provider: onbProvider || undefined, actor: "web" })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setOnbError(body.error ?? `Create failed (${response.status})`);
        return;
      }
      dismissOnboarding();
      await openTeamView();
    } finally {
      setOnbBusy(false);
    }
  }

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    htmlRef.current = html;
  }, [html]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3]
        }
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: "noreferrer"
        }
      })
    ],
    content: starterHtml,
    editorProps: {
      attributes: {
        class: "editorContent"
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      const nextHtml = currentEditor.getHTML();
      const nextHeading = getFirstHeadingText(nextHtml);
      setHtml(nextHtml);
      if (!loadingPageRef.current) {
        dirtyRef.current = true;
        setSaveState("dirty");
      }

      if (nextHeading && nextHeading !== titleRef.current) {
        const currentTitle = titleRef.current;
        const shouldUseHeadingAsTitle = isGenericTitle(currentTitle) || currentTitle === lastHeadingRef.current;
        if (shouldUseHeadingAsTitle) {
          titleRef.current = nextHeading;
          setTitle(nextHeading);
          setPages((current) =>
            current.map((page) =>
              page.id === selectedPageRef.current?.id ? { ...page, title: nextHeading, html: nextHtml } : page
            )
          );
        }
      }

      lastHeadingRef.current = nextHeading;
    }
  });

  useEffect(() => {
    void refreshPages();
  }, []);

  useEffect(() => {
    if (!openMenuPageId) {
      return;
    }

    function closeOpenMenu() {
      setOpenMenuPageId(null);
    }

    window.addEventListener("click", closeOpenMenu);
    return () => window.removeEventListener("click", closeOpenMenu);
  }, [openMenuPageId]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setSearchResults([]);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void searchPages(normalized, controller.signal);
    }, 150);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  const selectedPage = pages.find((page) => page.id === selectedId);
  const titleSlugPreview = slugify(title);
  const slugWillChange = Boolean(selectedPage && selectedPage.slug !== titleSlugPreview);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;
  const selectedMemory = memories.find((memory) => memory.id === selectedMemoryId) ?? memories[0] ?? null;

  useEffect(() => {
    selectedPageRef.current = selectedPage ?? null;
  }, [selectedPage]);

  useEffect(() => {
    const page = pages.find((candidate) => candidate.id === selectedId);
    if (!page) {
      return;
    }

    setTitle(page.title);
    setHtml(page.html);
    titleRef.current = page.title;
    htmlRef.current = page.html;
    lastHeadingRef.current = getFirstHeadingText(page.html);
    if (editor && editor.getHTML() !== page.html) {
      loadingPageRef.current = true;
      editor.commands.setContent(page.html, { emitUpdate: false });
      window.setTimeout(() => {
        loadingPageRef.current = false;
      }, 0);
    }
    dirtyRef.current = false;
    setSaveState("saved");
    void loadPageDetail(page.id);
    if (historyOpen) {
      void loadPageVersions(page.id);
    }
  }, [editor, selectedId]);

  useEffect(() => {
    if (!selectedPage) {
      return;
    }

    setPermissionOwner(selectedPage.owner);
    setPermissionVisibility(selectedPage.visibility);
    setPermissionNote(selectedPage.permissionNote ?? "");
  }, [selectedPage?.id, selectedPage?.owner, selectedPage?.permissionNote, selectedPage?.visibility]);

  const visiblePages = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const pagesWithDraftTitle = pages.map((page) =>
      page.id === selectedId ? { ...page, title: title || "Untitled", html } : page
    );

    if (!normalized) {
      return treeOrderPages(pagesWithDraftTitle);
    }

    return searchResults.map((result) => {
      const existing = pagesWithDraftTitle.find((page) => page.id === result.pageId);
      return (
        existing ?? {
          id: result.pageId,
          title: result.title,
          slug: result.slug,
          html: "",
          plainText: result.snippet,
          creator: "",
          createdBy: "",
          updatedBy: "",
          createdAt: "",
          updatedAt: result.updatedAt,
          deletedAt: null,
          pinnedOrder: null,
          parentPageId: null,
          visibility: "workspace" as const,
          owner: "",
          permissionNote: null
        }
      );
    });
  }, [html, pages, query, searchResults, selectedId, title]);

  const linkablePages = useMemo(() => {
    const normalized = pageLinkQuery.trim().toLowerCase();
    return pages.filter((page) => {
      if (page.id === selectedId) {
        return false;
      }

      if (!normalized) {
        return true;
      }

      return page.title.toLowerCase().includes(normalized) || page.slug.toLowerCase().includes(normalized);
    });
  }, [pageLinkQuery, pages, selectedId]);

  async function refreshPages() {
    const response = await fetch("/api/pages");
    const data = (await response.json()) as { pages: Page[] };
    setPages(data.pages);
    const homePage = data.pages.find((page) => page.slug === "home");
    setSelectedId((current) => {
      if (current && data.pages.some((page) => page.id === current)) {
        return current;
      }

      return homePage?.id ?? data.pages[0]?.id ?? null;
    });
  }

  async function loadMemories() {
    const response = await fetch("/api/memories?status=active&limit=100");
    const data = (await response.json()) as { memories: MemoryRecord[] };
    setMemories(data.memories);
    setSelectedMemoryId((current) =>
      current && data.memories.some((memory) => memory.id === current) ? current : data.memories[0]?.id ?? null
    );
  }

  // The DATA section (pages editor + memory). Leaving TEAM/TASKS returns here.
  function backToData() {
    setMemoryViewOpen(false);
    setTeamViewOpen(false);
    setTasksViewOpen(false);
  }

  async function openMemoryView() {
    setMemoryViewOpen(true);
    setTeamViewOpen(false);
    setTasksViewOpen(false);
    setHistoryOpen(false);
    await loadMemories();
    await loadEntities();
  }

  async function loadTeam() {
    const [agentsRes, providersRes, jobsRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/providers"),
      fetch("/api/jobs")
    ]);
    const agentsData = (await agentsRes.json()) as { agents: AgentSummary[] };
    const providersData = (await providersRes.json()) as { providers: ProviderStatus[] };
    const jobsData = (await jobsRes.json()) as { jobs: JobSummary[] };
    setTeamAgents(agentsData.agents);
    setProviders(providersData.providers);
    setTeamJobs(jobsData.jobs);
    const next =
      selectedAgentSlug && agentsData.agents.some((a) => a.slug === selectedAgentSlug)
        ? selectedAgentSlug
        : agentsData.agents[0]?.slug ?? null;
    if (next) await selectAgent(next);
    else setSelectedAgentSlug(null);
  }

  async function selectAgent(slug: string) {
    setSelectedAgentSlug(slug);
    setAgentRunError(null);
    const fileRes = await fetch(`/api/agents/${encodeURIComponent(slug)}/file`);
    setAgentPersona(fileRes.ok ? ((await fileRes.json()) as { markdown: string }).markdown : "");
    setAgentPersonaSaveState("saved");
    const runsRes = await fetch(`/api/conversations?agent=${encodeURIComponent(slug)}&limit=20`);
    setAgentRuns(runsRes.ok ? ((await runsRes.json()) as { conversations: ConversationSummary[] }).conversations : []);
  }

  async function saveAgentPersona() {
    if (!selectedAgentSlug) return;
    setAgentPersonaSaveState("saving");
    setAgentRunError(null);
    const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgentSlug)}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: agentPersona, actor: "web" })
    });
    if (!response.ok) {
      // Keep the user's edits + dirty state; surface the error rather than
      // reloading (which would clobber the unsaved persona).
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setAgentRunError(body.error ?? `Save failed (${response.status})`);
      setAgentPersonaSaveState("dirty");
      return;
    }
    setAgentPersonaSaveState("saved");
    await loadTeam();
  }

  async function openTeamView() {
    setTeamViewOpen(true);
    setMemoryViewOpen(false);
    setTasksViewOpen(false);
    setHistoryOpen(false);
    await loadTeam();
  }

  async function runSelectedAgent() {
    if (!selectedAgentSlug || !agentPrompt.trim()) return;
    setAgentRunning(true);
    setAgentRunError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedAgentSlug)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: agentPrompt, actor: "web" })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setAgentRunError(body.error ?? `Run failed (${response.status})`);
        return;
      }
      setAgentPrompt("");
    } catch {
      setAgentRunError("Run request failed — is the server reachable?");
    } finally {
      setAgentRunning(false);
    }
  }

  async function loadConversations() {
    const response = await fetch("/api/conversations?limit=200");
    const data = (await response.json()) as { conversations: ConversationSummary[] };
    setConversations(data.conversations);
  }

  async function openTasksView() {
    setTasksViewOpen(true);
    setMemoryViewOpen(false);
    setTeamViewOpen(false);
    setHistoryOpen(false);
    setSelectedConversation(null);
    await loadConversations();
  }

  async function openConversation(id: string) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: ConversationDetail };
    setSelectedConversation(data.conversation);
  }

  async function archiveConversationUi(id: string) {
    setBoardError(null);
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setBoardError(body.error ?? `Archive failed (${response.status})`);
      return;
    }
    if (selectedConversation?.id === id) setSelectedConversation(null);
    await loadConversations();
  }

  async function rerunConversation(conv: ConversationSummary) {
    setBoardError(null);
    // Re-run with the original prompt (the first user turn of the transcript).
    const detailRes = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`);
    if (!detailRes.ok) {
      setBoardError("Could not load the original prompt.");
      return;
    }
    const detail = (await detailRes.json()) as { conversation: ConversationDetail };
    const prompt = detail.conversation.turns.find((t) => t.role === "user")?.content ?? "";
    if (!prompt) {
      setBoardError("No prompt found to re-run.");
      return;
    }
    const runRes = await fetch(`/api/agents/${encodeURIComponent(conv.agent)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, actor: "web" })
    });
    if (!runRes.ok) {
      const body = (await runRes.json().catch(() => ({}))) as { error?: string };
      setBoardError(body.error ?? `Re-run failed (${runRes.status})`);
      return;
    }
    await loadConversations();
  }

  async function loadEntities() {
    const response = await fetch("/api/entities");
    const data = (await response.json()) as { entities: EntitySummary[] };
    setEntities(data.entities);
  }

  async function openEntity(slug: string) {
    setSelectedEntitySlug(slug);
    const response = await fetch(`/api/entities/${encodeURIComponent(slug)}/file`);
    if (!response.ok) {
      setEntityMarkdown("");
      return;
    }
    const data = (await response.json()) as { markdown: string };
    setEntityMarkdown(data.markdown);
    setEntitySaveState("saved");
  }

  async function saveEntityFile() {
    if (!selectedEntitySlug) return;
    setEntitySaveState("saving");
    await fetch(`/api/entities/${encodeURIComponent(selectedEntitySlug)}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: entityMarkdown, actor: "web" })
    });
    setEntitySaveState("saved");
    await loadEntities();
  }

  async function runRecall(searchQuery = recallQuery) {
    const normalized = searchQuery.trim();
    if (!normalized) {
      setRecall(null);
      return;
    }

    const params = new URLSearchParams({ q: normalized, limit: "12" });
    const response = await fetch(`/api/recall?${params}`);
    setRecall((await response.json()) as RecallResponse);
  }

  async function forgetMemory(memory: MemoryRecord) {
    await fetch(`/api/memories/${memory.id}/forget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    await loadMemories();
    if (recallQuery.trim()) {
      await runRecall();
    }
  }

  async function ingestSourceArtifact() {
    const title = artifactTitle.trim();
    const rawText = artifactText.trim();
    if (!title || !rawText) {
      return;
    }

    await fetch("/api/source-artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceType: artifactSourceType.trim() || "manual",
        title,
        rawText,
        actor: "web"
      })
    });
    setArtifactTitle("");
    setArtifactText("");
    if (recallQuery.trim()) {
      await runRecall();
    }
  }

  async function saveExplicitMemory() {
    const content = memoryContent.trim();
    if (!content) {
      return;
    }

    await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: memoryKind,
        content,
        subject: memorySubject.trim() || undefined,
        actor: "web",
        sources: []
      })
    });
    setMemoryContent("");
    setMemorySubject("");
    await loadMemories();
    if (recallQuery.trim()) {
      await runRecall();
    }
  }

  async function loadPageDetail(id: string) {
    const response = await fetch(`/api/pages/${id}`);
    const data = (await response.json()) as { page: PageDetail };
    setPageDetail(data.page);
  }

  async function addPageSource() {
    if (!selectedId || !sourceTitle.trim() || !sourceText.trim()) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/source-artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceType: sourceType.trim() || "manual",
        title: sourceTitle.trim(),
        label: sourceLabel.trim() || null,
        rawText: sourceText.trim(),
        actor: "web"
      })
    });
    setSourceTitle("");
    setSourceLabel("");
    setSourceText("");
    await loadPageDetail(selectedId);
  }

  async function detachPageSource(source: PageSourceArtifact) {
    if (!selectedId) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/source-artifacts/${source.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    await loadPageDetail(selectedId);
  }

  async function addPageComment() {
    if (!selectedId || !commentBody.trim()) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: commentBody.trim(), actor: "web" })
    });
    setCommentBody("");
    await loadPageDetail(selectedId);
  }

  async function deletePageComment(comment: PageComment) {
    if (!selectedId) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/comments/${comment.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    await loadPageDetail(selectedId);
  }

  async function createPageShareLink() {
    if (!selectedId) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/share-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: shareLabel.trim() || "Share link", accessLevel: "view", actor: "web" })
    });
    setShareLabel("");
    await loadPageDetail(selectedId);
  }

  async function revokePageShareLink(shareLink: PageShareLink) {
    if (!selectedId) {
      return;
    }

    await fetch(`/api/pages/${selectedId}/share-links/${shareLink.id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    await loadPageDetail(selectedId);
  }

  async function savePagePermissions() {
    if (!selectedId) {
      return;
    }

    const response = await fetch(`/api/pages/${selectedId}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visibility: permissionVisibility,
        owner: permissionOwner.trim() || "web",
        permissionNote: permissionNote.trim() || null,
        actor: "web"
      })
    });
    const data = (await response.json()) as { page: Page };
    setPages((current) => current.map((page) => (page.id === data.page.id ? data.page : page)));
    await loadPageDetail(selectedId);
  }

  async function loadPageVersions(id: string) {
    const response = await fetch(`/api/pages/${id}/versions`);
    const data = (await response.json()) as { versions: PageVersion[] };
    setVersions(data.versions);
    setSelectedVersionId((current) =>
      current && data.versions.some((version) => version.id === current) ? current : data.versions[0]?.id ?? null
    );
  }

  async function openHistory(page: Page) {
    setOpenMenuPageId(null);
    setHistoryOpen(true);
    await loadPageVersions(page.id);
  }

  async function searchPages(searchQuery: string, signal: AbortSignal) {
    const params = new URLSearchParams({ q: searchQuery, limit: "30" });
    const response = await fetch(`/api/search/pages?${params}`, { signal });
    const data = (await response.json()) as { results: PageSearchResult[] };
    setSearchResults(data.results);
  }

  async function createPage() {
    await saveBeforeLeavingPage();
    const response = await fetch("/api/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled page", html: starterHtml })
    });
    const data = (await response.json()) as { page: Page };
    setPages((current) => orderPages([data.page, ...current]));
    setSelectedId(data.page.id);
    backToData(); // land in DATA so the new page is visible in the editor/tree
  }

  async function createProject() {
    const name = projectName.trim();
    if (!name) {
      return;
    }

    await saveBeforeLeavingPage();
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, actor: "web" })
    });
    const data = (await response.json()) as { pages: Page[] };
    const startPage = data.pages.find((page) => page.slug.endsWith("/start")) ?? data.pages[0] ?? null;
    setPages((current) => mergePages(current, data.pages));
    if (startPage) {
      setSelectedId(startPage.id);
      backToData(); // land in DATA so the new project page is visible
    }
    setProjectName("");
    setProjectFormOpen(false);
  }

  useEffect(() => {
    if (!selectedId || !dirtyRef.current || memoryViewOpen) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void savePage();
    }, 1000);

    return () => window.clearTimeout(timeout);
  }, [html, memoryViewOpen, selectedId, title]);

  function updateTitle(value: string) {
    const previousTitle = titleRef.current;
    const currentHeading = getFirstHeadingText(html);
    const shouldSyncHeading =
      editor && (!currentHeading || currentHeading === previousTitle || currentHeading === lastHeadingRef.current);
    const nextHtml = shouldSyncHeading ? htmlWithFirstHeading(html, value || "Untitled") : html;

    if (shouldSyncHeading) {
      lastHeadingRef.current = value || "Untitled";
      setHtml(nextHtml);
      editor.commands.setContent(nextHtml, { emitUpdate: false });
    }

    titleRef.current = value;
    htmlRef.current = nextHtml;
    dirtyRef.current = true;
    setSaveState("dirty");
    setTitle(value);
    setPages((current) =>
      current.map((page) => (page.id === selectedId ? { ...page, title: value || "Untitled", html: nextHtml } : page))
    );
  }

  async function persistPage(id: string, nextTitle: string, nextHtml: string) {
    setSaveState("saving");

    // Send the per-file version we last saw so a concurrent edit conflicts (409)
    // instead of silently overwriting.
    const baseVersion = pageDetail?.id === id ? pageDetail.version ?? undefined : undefined;
    const response = await fetch(`/api/pages/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: nextTitle, html: nextHtml, actor: "web", baseVersion })
    });
    if (!response.ok) {
      // 409 = someone else changed this page. Reload the latest + flag the conflict
      // (a full merge UI is deferred); the user re-applies their edit on fresh content.
      setSaveState("error");
      if (response.status === 409) await loadPageDetail(id);
      return null;
    }
    const data = (await response.json()) as { page: Page };
    setPages((current) => orderPages(current.map((page) => (page.id === data.page.id ? data.page : page))));
    await loadPageDetail(data.page.id);
    if (historyOpen) {
      await loadPageVersions(data.page.id);
    }
    dirtyRef.current = false;
    setSaveState("saved");
    return data.page;
  }

  async function savePage() {
    if (!selectedId) {
      return;
    }

    try {
      await persistPage(selectedId, titleRef.current, htmlRef.current);
    } catch {
      setSaveState("error");
    }
  }

  async function saveBeforeLeavingPage() {
    const page = selectedPageRef.current;
    if (!page || !dirtyRef.current) {
      return;
    }

    await persistPage(page.id, titleRef.current || "Untitled", htmlRef.current);
  }

  async function selectPage(page: Page) {
    try {
      await saveBeforeLeavingPage();
      setSelectedId(page.id);
      setMemoryViewOpen(false);
    } catch {
      setSaveState("error");
    }
  }

  function setLink() {
    if (!editor) {
      return;
    }

    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previousUrl ?? "");
    if (url === null) {
      return;
    }

    if (!url.trim()) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  function insertPageLink(page: Page) {
    if (!editor) {
      return;
    }

    editor
      .chain()
      .focus()
      .insertContent(`<a href="/pages/${page.slug}" data-page-slug="${page.slug}">${page.title}</a>`)
      .run();
    setPageLinkPickerOpen(false);
    setPageLinkQuery("");
  }

  async function duplicatePage(page: Page) {
    setOpenMenuPageId(null);
    await saveBeforeLeavingPage();
    const response = await fetch(`/api/pages/${page.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const data = (await response.json()) as { page: Page };
    setPages((current) => orderPages([data.page, ...current]));
    setSelectedId(data.page.id);
    backToData(); // land in DATA so the new page is visible in the editor/tree
  }

  async function movePage(page: Page, parentPage: Page | null) {
    if (
      parentPage?.id === page.id ||
      parentPage?.id === page.parentPageId ||
      (!parentPage && !page.parentPageId) ||
      page.slug === "home" ||
      (parentPage && isDescendantPage(parentPage.id, page.id, pages))
    ) {
      setDraggingPageId(null);
      setDragTarget(null);
      return;
    }

    const response = await fetch(`/api/pages/${page.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentPageId: parentPage?.id ?? null, actor: "web" })
    });
    if (!response.ok) {
      setDraggingPageId(null);
      setDragTarget(null);
      return;
    }

    const data = (await response.json()) as { page: Page };
    setPages((current) => orderPages(current.map((candidate) => (candidate.id === data.page.id ? data.page : candidate))));
    setDraggingPageId(null);
    setDragTarget(null);
    draggingPageIdRef.current = null;
  }

  async function deletePage(page: Page) {
    if (page.slug === "home") {
      setOpenMenuPageId(null);
      return;
    }

    setOpenMenuPageId(null);
    await fetch(`/api/pages/${page.id}`, { method: "DELETE" });
    const remainingPages = pages.filter((candidate) => candidate.id !== page.id);
    setPages(remainingPages);

    if (selectedId === page.id) {
      const homePage = remainingPages.find((candidate) => candidate.slug === "home");
      setSelectedId(homePage?.id ?? remainingPages[0]?.id ?? null);
      setPageDetail(null);
    }
  }

  async function restoreVersion(version: PageVersion) {
    if (!selectedId) {
      return;
    }

    const response = await fetch(`/api/pages/${selectedId}/versions/${version.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "web" })
    });
    const data = (await response.json()) as { page: Page };
    setPages((current) => current.map((page) => (page.id === data.page.id ? data.page : page)));
    setTitle(data.page.title);
    setHtml(data.page.html);
    titleRef.current = data.page.title;
    lastHeadingRef.current = getFirstHeadingText(data.page.html);
    editor?.commands.setContent(data.page.html, { emitUpdate: false });
    await loadPageDetail(data.page.id);
    await loadPageVersions(data.page.id);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Icon name="doc" size={17} />
          <span>Company Brain</span>
        </div>

        <label className="search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages" />
        </label>

        <button className="primaryButton" type="button" onClick={createPage}>
          <Icon name="plus" size={14} />
          New page
        </button>

        <div className="sidebarActionGroup">
          <button className="primaryButton" type="button" onClick={() => setProjectFormOpen((current) => !current)}>
            <Icon name="doc" size={14} />
            New project
          </button>
          {projectFormOpen && (
            <form
              className="projectForm"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Project name"
                autoFocus
              />
              <button type="submit" disabled={!projectName.trim()}>
                Create
              </button>
            </form>
          )}
        </div>

        <nav className="sectionNav" aria-label="Sections">
          <button
            className={!teamViewOpen && !tasksViewOpen ? "sectionNavButton active" : "sectionNavButton"}
            type="button"
            onClick={backToData}
          >
            <Icon name="doc" size={14} />
            Data
          </button>
          <button
            className={teamViewOpen ? "sectionNavButton active" : "sectionNavButton"}
            type="button"
            onClick={openTeamView}
          >
            <Icon name="spark" size={14} />
            Team
          </button>
          <button
            className={tasksViewOpen ? "sectionNavButton active" : "sectionNavButton"}
            type="button"
            onClick={openTasksView}
          >
            <Icon name="spark" size={14} />
            Tasks
          </button>
        </nav>

        {!teamViewOpen && !tasksViewOpen && (
          <button
            className={memoryViewOpen ? "primaryButton active" : "primaryButton"}
            type="button"
            onClick={memoryViewOpen ? backToData : openMemoryView}
          >
            <Icon name="spark" size={14} />
            {memoryViewOpen ? "Back to pages" : "Memory"}
          </button>
        )}

        {!teamViewOpen && !tasksViewOpen && (
        <nav className="pageList" aria-label="Pages">
          <div
            className={[
              "rootDropTarget",
              draggingPageId ? "visible" : "",
              dragTarget?.type === "root" ? "active" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            onDragOver={(event) => {
              const draggedId =
                event.dataTransfer.getData("text/plain") || draggingPageIdRef.current || draggingPageId;
              const draggedPage = pages.find((candidate) => candidate.id === draggedId);
              if (draggedPage?.parentPageId) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragTarget({ type: "root" });
              }
            }}
            onDragLeave={() => {
              setDragTarget((current) => (current?.type === "root" ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const draggedId =
                event.dataTransfer.getData("text/plain") || draggingPageIdRef.current || draggingPageId;
              const draggedPage = pages.find((candidate) => candidate.id === draggedId);
              if (draggedPage) {
                void movePage(draggedPage, null);
              }
            }}
          >
            Drop here to move to top level
          </div>
          {visiblePages.map((page) => (
            <div
              className={[
                page.id === selectedId ? "pageRow active" : "pageRow",
                draggingPageId === page.id ? "dragging" : "",
                dragTarget?.type === "page" && dragTarget.pageId === page.id ? "dropTarget" : "",
                page.parentPageId ? "child" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={page.id}
              onClick={() => setOpenMenuPageId(null)}
              draggable={page.slug !== "home"}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", page.id);
                event.dataTransfer.effectAllowed = "move";
                draggingPageIdRef.current = page.id;
                setDraggingPageId(page.id);
              }}
              onDragEnd={() => {
                draggingPageIdRef.current = null;
                setDraggingPageId(null);
                setDragTarget(null);
              }}
              onDragOver={(event) => {
                const draggedId =
                  event.dataTransfer.getData("text/plain") || draggingPageIdRef.current || draggingPageId;
                if (
                  draggedId &&
                  draggedId !== page.id &&
                  page.parentPageId !== draggedId &&
                  !isDescendantPage(page.id, draggedId, pages)
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragTarget({ type: "page", pageId: page.id });
                }
              }}
              onDragLeave={() => {
                setDragTarget((current) =>
                  current?.type === "page" && current.pageId === page.id ? null : current
                );
              }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId =
                  event.dataTransfer.getData("text/plain") || draggingPageIdRef.current || draggingPageId;
                const draggedPage = pages.find((candidate) => candidate.id === draggedId);
                if (draggedPage) {
                  void movePage(draggedPage, page);
                }
              }}
              style={{ "--page-depth": pageDepth(page, pages) } as CSSProperties}
            >
              <button
                className="pageButton"
                type="button"
                onClick={() => {
                  void selectPage(page);
                }}
              >
                {page.title}
              </button>
              <button
                className="pageActionButton"
                type="button"
                aria-label={`Actions for ${page.title}`}
                title="Page actions"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuPageId((current) => (current === page.id ? null : page.id));
                }}
              >
                <Icon name="dots" size={14} />
              </button>
              {openMenuPageId === page.id && (
                <div className="pageMenu" onClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => openHistory(page)}>
                    History
                  </button>
                  <button type="button" onClick={() => duplicatePage(page)}>
                    Duplicate
                  </button>
                  <button type="button" disabled={!page.parentPageId} onClick={() => movePage(page, null)}>
                    Move to top
                  </button>
                  <button type="button" disabled={page.slug === "home"} onClick={() => deletePage(page)}>
                    Delete
                  </button>
                </div>
              )}
              {dragTarget?.type === "page" && dragTarget.pageId === page.id && (
                <div className="pageDropHint">Nest under {page.title}</div>
              )}
            </div>
          ))}
        </nav>
        )}

        <button
          className="sidebarSetupButton"
          type="button"
          onClick={() => {
            setOnbStep(0);
            setOnbError(null);
            setOnboardingOpen(true);
          }}
        >
          Setup
        </button>
      </aside>

      <section className="workspace">
        {teamViewOpen ? (
          <div className="memoryWorkspace">
            <header className="toolbar">
              <div className="titleStack">
                <input className="titleInput" value="Team" readOnly />
                <div className="pageMeta">
                  <span>{teamAgents.length} agents</span>
                  <span>
                    providers: {providers.filter((p) => p.detection.available).map((p) => p.id).join(", ") || "none detected"}
                  </span>
                </div>
              </div>
              <button className="iconButton" type="button" onClick={() => setTeamViewOpen(false)} title="Close team">
                <Icon name="doc" size={15} />
              </button>
            </header>
            <div className="memoryGrid">
              <aside className="memoryPanel">
                <div className="panelHeader">
                  <h2>Agents</h2>
                  <button type="button" onClick={loadTeam}>
                    Refresh
                  </button>
                </div>
                <div className="memoryList">
                  {teamAgents.length ? (
                    teamAgents.map((agent) => (
                      <button
                        className={agent.slug === selectedAgentSlug ? "memoryItem active" : "memoryItem"}
                        key={agent.id}
                        type="button"
                        onClick={() => selectAgent(agent.slug)}
                      >
                        <span>{agent.name}</span>
                        <small>
                          {agent.provider ?? "no provider"}
                          {agent.enabled ? "" : " · disabled"}
                          {agent.schedule ? ` · ${agent.schedule}` : ""}
                        </small>
                      </button>
                    ))
                  ) : (
                    <p className="laneEmpty">
                      No agents yet — use <strong>Setup</strong> to create your first one.
                    </p>
                  )}
                </div>
                <div className="panelHeader">
                  <h2>Providers</h2>
                </div>
                <div className="memoryList">
                  {providers.map((p) => (
                    <div className="sourceItem" key={p.id}>
                      <span>
                        {p.id} {p.detection.available ? "✓" : "✗"}
                      </span>
                      <small>{p.detection.available ? p.detection.version ?? p.detection.path : p.detection.error}</small>
                    </div>
                  ))}
                </div>
              </aside>
              {selectedAgentSlug && (
                <aside className="memoryPanel">
                  <div className="memoryDetail">
                    <div className="memoryDetailHeader">
                      <div>
                        <strong>{selectedAgentSlug}</strong>
                        <small>persona · jobs · run history</small>
                      </div>
                    </div>

                    <h3>Persona</h3>
                    <textarea
                      className="entityEditor"
                      value={agentPersona}
                      rows={8}
                      placeholder="System prompt (persona) for this agent…"
                      onChange={(event) => {
                        setAgentPersona(event.target.value);
                        setAgentPersonaSaveState("dirty");
                      }}
                    />
                    <button type="button" onClick={saveAgentPersona} disabled={agentPersonaSaveState !== "dirty"}>
                      {agentPersonaSaveState === "saving" ? "Saving…" : "Save persona"}
                    </button>

                    <h3>Run a prompt</h3>
                    <textarea
                      className="entityEditor"
                      value={agentPrompt}
                      rows={4}
                      placeholder="Prompt for the agent…"
                      onChange={(event) => setAgentPrompt(event.target.value)}
                    />
                    <button type="button" onClick={runSelectedAgent} disabled={agentRunning || !agentPrompt.trim()}>
                      {agentRunning ? "Running…" : "Run agent"}
                    </button>
                    {agentRunError && <p className="runError">{agentRunError}</p>}

                    <h3>Jobs</h3>
                    {teamJobs.filter((j) => j.agent === selectedAgentSlug).length ? (
                      teamJobs
                        .filter((j) => j.agent === selectedAgentSlug)
                        .map((job) => (
                          <div className="sourceItem" key={job.id}>
                            <span>{job.name}</span>
                            <small>
                              {job.schedule}
                              {job.enabled ? "" : " · disabled"}
                            </small>
                          </div>
                        ))
                    ) : (
                      <p className="laneEmpty">No jobs target this agent.</p>
                    )}

                    <h3>Run history</h3>
                    {agentRuns.length ? (
                      agentRuns.map((run) => (
                        <button
                          className="memoryItem"
                          key={run.id}
                          type="button"
                          onClick={async () => {
                            await openTasksView();
                            await openConversation(run.id);
                          }}
                        >
                          <span>{run.status}</span>
                          <small>{run.startedAt ?? ""}</small>
                        </button>
                      ))
                    ) : (
                      <p className="laneEmpty">No runs yet.</p>
                    )}
                  </div>
                </aside>
              )}
            </div>
          </div>
        ) : tasksViewOpen ? (
          <div className="memoryWorkspace">
            <header className="toolbar">
              <div className="titleStack">
                <input className="titleInput" value="Tasks" readOnly />
                <div className="pageMeta">
                  <span>{conversations.length} conversations</span>
                </div>
              </div>
              <button className="iconButton" type="button" onClick={() => setTasksViewOpen(false)} title="Close tasks">
                <Icon name="doc" size={15} />
              </button>
            </header>
            {boardError && <p className="runError">{boardError}</p>}
            <div className="taskBoardGrid">
              <div className="taskBoard" role="list">
                {conversations.length === 0 ? (
                  <p className="laneEmpty">No conversations yet. Run an agent from Team.</p>
                ) : (
                  <div className="laneContainer">
                    {TASK_LANES.map((lane) => {
                      const laneConversations = conversations.filter((c) => c.status === lane.key);
                      return (
                        <div className="lane" key={lane.key}>
                          <h3 className="laneHeader">
                            {lane.label} <span className="laneCount">{laneConversations.length}</span>
                          </h3>
                          {laneConversations.map((conv) => (
                            <div
                              className={conv.id === selectedConversation?.id ? "laneCard active" : "laneCard"}
                              key={conv.id}
                            >
                              <button className="laneCardOpen" type="button" onClick={() => openConversation(conv.id)}>
                                <strong>{conv.agent}</strong>
                                <small>
                                  {conv.provider ?? "none"}
                                  {conv.job ? ` · ${conv.job}` : ""}
                                </small>
                              </button>
                              <div className="laneCardActions">
                                <button type="button" onClick={() => rerunConversation(conv)}>
                                  Re-run
                                </button>
                                {conv.status !== "archived" && (
                                  <button type="button" onClick={() => archiveConversationUi(conv.id)}>
                                    Archive
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                          {laneConversations.length === 0 && <p className="laneEmpty">—</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {selectedConversation && (
                <aside className="memoryPanel">
                  <div className="memoryDetail">
                    <div className="memoryDetailHeader">
                      <div>
                        <strong>
                          {selectedConversation.agent} · {selectedConversation.status}
                        </strong>
                        <small>{selectedConversation.startedAt ?? ""}</small>
                      </div>
                      <button type="button" onClick={() => setSelectedConversation(null)}>
                        Close
                      </button>
                    </div>
                    {selectedConversation.error && <p>Error: {selectedConversation.error}</p>}
                    {selectedConversation.turns.map((turn, index) => (
                      <div className="sourceItem" key={index}>
                        <span>{turn.role}</span>
                        <p>{turn.content}</p>
                      </div>
                    ))}
                  </div>
                </aside>
              )}
            </div>
          </div>
        ) : memoryViewOpen ? (
          <div className="memoryWorkspace">
            <header className="toolbar">
              <div className="titleStack">
                <input className="titleInput" value="Memory" readOnly />
                <div className="pageMeta">
                  <span>recall search mode: {recall?.searchMode ?? "bm25_local_v1"}</span>
                  <span>{memories.length} active memories</span>
                </div>
              </div>
              <button className="iconButton" type="button" onClick={() => setMemoryViewOpen(false)} title="Close memory">
                <Icon name="doc" size={15} />
              </button>
            </header>

            <div className="memoryGrid">
              <section className="memoryMain">
                <div className="captureGrid">
                  <form
                    className="captureBox"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void ingestSourceArtifact();
                    }}
                  >
                    <div className="captureHeader">
                      <strong>Source artifact</strong>
                      <button type="submit" disabled={!artifactTitle.trim() || !artifactText.trim()}>
                        Ingest
                      </button>
                    </div>
                    <div className="captureFields twoColumn">
                      <input
                        value={artifactTitle}
                        onChange={(event) => setArtifactTitle(event.target.value)}
                        placeholder="Title"
                      />
                      <input
                        value={artifactSourceType}
                        onChange={(event) => setArtifactSourceType(event.target.value)}
                        placeholder="Source type"
                      />
                    </div>
                    <textarea
                      value={artifactText}
                      onChange={(event) => setArtifactText(event.target.value)}
                      placeholder="Paste chat, meeting notes, connector text, or raw context"
                    />
                  </form>

                  <form
                    className="captureBox"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveExplicitMemory();
                    }}
                  >
                    <div className="captureHeader">
                      <strong>Explicit memory</strong>
                      <button type="submit" disabled={!memoryContent.trim()}>
                        Save
                      </button>
                    </div>
                    <div className="captureFields twoColumn">
                      <select
                        value={memoryKind}
                        onChange={(event) => setMemoryKind(event.target.value as MemoryRecord["kind"])}
                      >
                        <option value="fact">Fact</option>
                        <option value="decision">Decision</option>
                        <option value="preference">Preference</option>
                        <option value="status">Status</option>
                        <option value="contradiction">Contradiction</option>
                      </select>
                      <input
                        value={memorySubject}
                        onChange={(event) => setMemorySubject(event.target.value)}
                        placeholder="Subject"
                      />
                    </div>
                    <textarea
                      value={memoryContent}
                      onChange={(event) => setMemoryContent(event.target.value)}
                      placeholder="A durable fact, decision, preference, or status"
                    />
                  </form>
                </div>

                <div className="memorySearch">
                  <label className="search">
                    <Icon name="search" size={14} />
                    <input
                      value={recallQuery}
                      onChange={(event) => setRecallQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void runRecall();
                        }
                      }}
                      placeholder="Recall across memories, pages, and source artifacts"
                    />
                  </label>
                  <button type="button" onClick={() => runRecall()}>
                    Recall
                  </button>
                  <span className="modeBadge">{recall?.searchMode ?? "bm25_local_v1"}</span>
                </div>

                <div className="recallResults">
                  {recall?.results.length ? (
                    recall.results.map((result) => {
                      const sources = recallSources(result);
                      return (
                        <button className="recallItem" key={`${result.type}-${result.id}`} type="button">
                          <div>
                            <span>{result.title}</span>
                            <small>
                              {result.type} · score {result.score} · {result.citation.label}
                              {sources.length ? ` · ${sources.length} source${sources.length === 1 ? "" : "s"}` : ""}
                            </small>
                          </div>
                          <p>{result.snippet}</p>
                        </button>
                      );
                    })
                  ) : (
                    <p>Search recall to inspect mixed memory, page, and source-artifact results.</p>
                  )}
                </div>
              </section>

              <aside className="memoryPanel">
                <div className="panelHeader">
                  <h2>Active memories</h2>
                  <button type="button" onClick={loadMemories}>
                    Refresh
                  </button>
                </div>
                <div className="memoryList">
                  {memories.length ? (
                    memories.map((memory) => (
                      <button
                        className={memory.id === selectedMemory?.id ? "memoryItem active" : "memoryItem"}
                        key={memory.id}
                        type="button"
                        onClick={() => setSelectedMemoryId(memory.id)}
                      >
                        <span>{memory.subject ? `${memory.kind}: ${memory.subject}` : memory.kind}</span>
                        <small>{memory.content}</small>
                      </button>
                    ))
                  ) : (
                    <p>No active memories yet.</p>
                  )}
                </div>

                {selectedMemory && (
                  <div className="memoryDetail">
                    <div className="memoryDetailHeader">
                      <div>
                        <strong>{selectedMemory.subject ?? selectedMemory.kind}</strong>
                        <small>
                          {selectedMemory.kind} · confidence {selectedMemory.confidence} · by {selectedMemory.createdBy}
                        </small>
                      </div>
                      <button type="button" onClick={() => forgetMemory(selectedMemory)}>
                        Forget
                      </button>
                    </div>
                    <p>{selectedMemory.content}</p>
                    <h3>Sources</h3>
                    {selectedMemory.sources.length ? (
                      selectedMemory.sources.map((source) => (
                        <div
                          className="sourceItem"
                          key={source.id}
                        >
                          <span>{source.sourceType}</span>
                          <small>
                            {source.pageId ?? source.pageChunkId ?? source.artifactId ?? source.sourceChunkId ?? "manual"}
                          </small>
                          {source.quote && <p>{source.quote}</p>}
                        </div>
                      ))
                    ) : (
                      <p>No sources attached yet.</p>
                    )}
                  </div>
                )}
              </aside>

              <aside className="memoryPanel">
                <div className="panelHeader">
                  <h2>Entities</h2>
                  <button type="button" onClick={loadEntities}>
                    Refresh
                  </button>
                </div>
                <div className="memoryList">
                  {entities.length ? (
                    entities.map((entity) => (
                      <button
                        className={entity.slug === selectedEntitySlug ? "memoryItem active" : "memoryItem"}
                        key={entity.id}
                        type="button"
                        onClick={() => openEntity(entity.slug)}
                      >
                        <span>{entity.title}</span>
                        <small>{entity.type}{entity.profile ? ` · ${entity.profile}` : ""}</small>
                      </button>
                    ))
                  ) : (
                    <p>No entities yet. Save a memory with a subject to create one.</p>
                  )}
                </div>

                {selectedEntitySlug && (
                  <div className="memoryDetail">
                    <div className="memoryDetailHeader">
                      <div>
                        <strong>{selectedEntitySlug}</strong>
                        <small>editing the entity file · {entitySaveState}</small>
                      </div>
                      <button type="button" onClick={saveEntityFile} disabled={entitySaveState !== "dirty"}>
                        Save
                      </button>
                    </div>
                    <textarea
                      className="entityEditor"
                      value={entityMarkdown}
                      rows={16}
                      onChange={(event) => {
                        setEntityMarkdown(event.target.value);
                        setEntitySaveState("dirty");
                      }}
                    />
                  </div>
                )}
              </aside>
            </div>
          </div>
        ) : (
          <>
        <header className="toolbar">
          <div className="titleStack">
            <input className="titleInput" value={title} onChange={(event) => updateTitle(event.target.value)} />
            {selectedPage && (
              <div className="pageMeta">
                <span>{slugWillChange ? `/${titleSlugPreview} after save` : `/${selectedPage.slug}`}</span>
                <span>Created by {selectedPage.createdBy}</span>
                <span>Modified by {selectedPage.updatedBy}</span>
                <span>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving..." : saveState === "dirty" ? "Unsaved" : "Save failed"}</span>
              </div>
            )}
          </div>
          <button className="iconButton" type="button" onClick={savePage} aria-label="Save page" title="Save page">
            <Icon name="save" size={15} />
          </button>
          {selectedPage && (
            <button
              className={historyOpen ? "iconButton active" : "iconButton"}
              type="button"
              onClick={() => {
                setHistoryOpen((current) => !current);
                if (!historyOpen) {
                  void loadPageVersions(selectedPage.id);
                }
              }}
              aria-label="Page history"
              title="Page history"
            >
              <Icon name="history" size={15} />
            </button>
          )}
          <button
            className={htmlMode ? "iconButton active" : "iconButton"}
            type="button"
            onClick={() => setHtmlMode((current) => !current)}
            aria-label="Toggle HTML mode"
            title="Toggle HTML mode"
          >
            <Icon name="html" size={15} />
          </button>
        </header>

        <div className={htmlMode ? "editorGrid htmlMode" : "editorGrid"}>
          {htmlMode ? (
            <>
              <textarea
                className="htmlEditor"
                value={html}
                onChange={(event) => {
                  setHtml(event.target.value);
                  editor?.commands.setContent(event.target.value, { emitUpdate: false });
                }}
                spellCheck={false}
              />
              <div className="previewPane">
                <article className="preview" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </>
          ) : (
            <div className="editorPane">
              <div className="editorToolbar" aria-label="Editor tools">
                <button
                  className={editor?.isActive("heading", { level: 1 }) ? "toolButton active" : "toolButton"}
                  type="button"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
                >
                  H1
                </button>
                <button
                  className={editor?.isActive("heading", { level: 2 }) ? "toolButton active" : "toolButton"}
                  type="button"
                  onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                >
                  H2
                </button>
                <button
                  className={editor?.isActive("bold") ? "toolButton active" : "toolButton"}
                  type="button"
                  aria-label="Bold"
                  title="Bold"
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                >
                  <Icon name="bold" size={14} />
                </button>
                <button
                  className={editor?.isActive("italic") ? "toolButton active" : "toolButton"}
                  type="button"
                  aria-label="Italic"
                  title="Italic"
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                >
                  <Icon name="italic" size={14} />
                </button>
                <button
                  className={editor?.isActive("bulletList") ? "toolButton active" : "toolButton"}
                  type="button"
                  aria-label="Bullet list"
                  title="Bullet list"
                  onClick={() => editor?.chain().focus().toggleBulletList().run()}
                >
                  <Icon name="list" size={14} />
                </button>
                <button
                  className={editor?.isActive("code") ? "toolButton active" : "toolButton"}
                  type="button"
                  aria-label="Code"
                  title="Code"
                  onClick={() => editor?.chain().focus().toggleCode().run()}
                >
                  <Icon name="code" size={14} />
                </button>
                <button
                  className={editor?.isActive("link") ? "toolButton active" : "toolButton"}
                  type="button"
                  aria-label="Link"
                  title="Link"
                  onClick={setLink}
                >
                  <Icon name="link" size={14} />
                </button>
                <div className="pageLinkTool">
                  <button
                    className={pageLinkPickerOpen ? "toolButton active" : "toolButton"}
                    type="button"
                    onClick={() => setPageLinkPickerOpen((current) => !current)}
                  >
                    [[ ]]
                  </button>
                  {pageLinkPickerOpen && (
                    <div className="pageLinkPicker">
                      <input
                        value={pageLinkQuery}
                        onChange={(event) => setPageLinkQuery(event.target.value)}
                        placeholder="Find page"
                        autoFocus
                      />
                      <div className="pageLinkOptions">
                        {linkablePages.length ? (
                          linkablePages.map((page) => (
                            <button key={page.id} type="button" onClick={() => insertPageLink(page)}>
                              <span>{page.title}</span>
                              <small>/{page.slug}</small>
                            </button>
                          ))
                        ) : (
                          <p>No pages found</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <EditorContent editor={editor} />
            </div>
          )}
          {!htmlMode && historyOpen && (
            <aside className="historyPanel">
              <div className="panelHeader">
                <h2>History</h2>
                <button type="button" onClick={() => setHistoryOpen(false)}>
                  Close
                </button>
              </div>
              {versions.length ? (
                <>
                  <div className="versionList">
                    {versions.map((version) => (
                      <button
                        className={version.id === selectedVersion?.id ? "versionItem active" : "versionItem"}
                        key={version.id}
                        type="button"
                        onClick={() => setSelectedVersionId(version.id)}
                      >
                        <span>{version.title}</span>
                        <small>
                          {new Date(version.createdAt).toLocaleString()} by {version.createdBy}
                        </small>
                      </button>
                    ))}
                  </div>
                  {selectedVersion && (
                    <div className="versionPreview">
                      <div className="versionPreviewHeader">
                        <div>
                          <strong>{selectedVersion.title}</strong>
                          <small>/{selectedVersion.slug}</small>
                        </div>
                        <button type="button" onClick={() => restoreVersion(selectedVersion)}>
                          Restore
                        </button>
                      </div>
                      <article dangerouslySetInnerHTML={{ __html: selectedVersion.html }} />
                    </div>
                  )}
                </>
              ) : (
                <p>No saved versions yet.</p>
              )}
            </aside>
          )}
          {!htmlMode && !historyOpen && (
            <aside className="relatedPanel pageWorkspacePanel">
              <div className="panelTabs" role="tablist" aria-label="Page tools">
                {(["related", "sources", "comments", "share", "activity"] as PagePanelTab[]).map((tab) => (
                  <button
                    className={pagePanelTab === tab ? "active" : ""}
                    key={tab}
                    type="button"
                    onClick={() => setPagePanelTab(tab)}
                  >
                    {tab === "related"
                      ? "Links"
                      : tab === "sources"
                        ? "Sources"
                        : tab === "comments"
                          ? "Comments"
                          : tab === "share"
                            ? "Share"
                            : "Activity"}
                  </button>
                ))}
              </div>

              {pagePanelTab === "related" && (
                <section className="pagePanelSection">
                  <h2>Related content</h2>
                  {pageDetail?.relatedPages.length ? (
                    <div className="relatedList">
                      {pageDetail.relatedPages.map((page) => (
                        <button
                          className="relatedItem"
                          key={page.id}
                          type="button"
                          onClick={() => void selectPage(page)}
                        >
                          <span>{page.title}</span>
                          <small>/{page.slug}</small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>No pages link here yet.</p>
                  )}
                </section>
              )}

              {pagePanelTab === "sources" && (
                <section className="pagePanelSection">
                  <h2>Sources</h2>
                  <div className="sourceComposer">
                    <div className="sourceFields">
                      <input
                        value={sourceTitle}
                        onChange={(event) => setSourceTitle(event.target.value)}
                        placeholder="Source title"
                      />
                      <input
                        value={sourceType}
                        onChange={(event) => setSourceType(event.target.value)}
                        placeholder="Type"
                      />
                    </div>
                    <input
                      value={sourceLabel}
                      onChange={(event) => setSourceLabel(event.target.value)}
                      placeholder="Optional label"
                    />
                    <textarea
                      value={sourceText}
                      onChange={(event) => setSourceText(event.target.value)}
                      placeholder="Paste meeting notes, document excerpts, or imported context"
                    />
                    <button type="button" onClick={addPageSource} disabled={!sourceTitle.trim() || !sourceText.trim()}>
                      Attach source
                    </button>
                  </div>
                  {pageDetail?.sources.length ? (
                    <div className="sourceList">
                      {pageDetail.sources.map((source) => (
                        <article className="sourceItem" key={source.id}>
                          <div>
                            <strong>{source.label || source.title}</strong>
                            <small>
                              {source.sourceType} · {source.attachedBy}
                            </small>
                          </div>
                          <p>{source.rawText.replace(/\s+/g, " ").slice(0, 180)}</p>
                          <button type="button" onClick={() => detachPageSource(source)}>
                            Detach
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>No sources attached yet.</p>
                  )}
                </section>
              )}

              {pagePanelTab === "comments" && (
                <section className="pagePanelSection">
                  <h2>Comments</h2>
                  <div className="commentComposer">
                    <textarea
                      value={commentBody}
                      onChange={(event) => setCommentBody(event.target.value)}
                      placeholder="Add a comment"
                    />
                    <button type="button" onClick={addPageComment} disabled={!commentBody.trim()}>
                      Add
                    </button>
                  </div>
                  {pageDetail?.comments.length ? (
                    <div className="commentList">
                      {pageDetail.comments.map((comment) => (
                        <article className="commentItem" key={comment.id}>
                          <p>{comment.body}</p>
                          <div>
                            <small>
                              {comment.createdBy} · {new Date(comment.createdAt).toLocaleString()}
                            </small>
                            <button type="button" onClick={() => deletePageComment(comment)}>
                              Remove
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>No comments yet.</p>
                  )}
                </section>
              )}

              {pagePanelTab === "share" && (
                <section className="pagePanelSection">
                  <h2>Sharing</h2>
                  <div className="permissionBox">
                    <label>
                      <span>Audience label</span>
                      <select
                        value={permissionVisibility}
                        onChange={(event) => setPermissionVisibility(event.target.value as Page["visibility"])}
                      >
                        <option value="workspace">Workspace</option>
                        <option value="restricted">Restricted note</option>
                        <option value="public">Public note</option>
                      </select>
                    </label>
                    <label>
                      <span>Owner</span>
                      <input value={permissionOwner} onChange={(event) => setPermissionOwner(event.target.value)} />
                    </label>
                    <label>
                      <span>Note</span>
                      <textarea
                        value={permissionNote}
                        onChange={(event) => setPermissionNote(event.target.value)}
                        placeholder="Permission context"
                      />
                    </label>
                    <button type="button" onClick={savePagePermissions}>
                      Save permissions
                    </button>
                  </div>
                  <div className="shareComposer">
                    <input
                      value={shareLabel}
                      onChange={(event) => setShareLabel(event.target.value)}
                      placeholder="Share label"
                    />
                    <button type="button" onClick={createPageShareLink}>
                      New link
                    </button>
                  </div>
                  {pageDetail?.shareLinks.length ? (
                    <div className="shareList">
                      {pageDetail.shareLinks.map((shareLink) => (
                        <article className={shareLink.revokedAt ? "shareItem revoked" : "shareItem"} key={shareLink.id}>
                          <strong>{shareLink.label}</strong>
                          <code>/share/{shareLink.token}</code>
                          <small>
                            {shareLink.revokedAt ? "Revoked" : shareLink.accessLevel} · {shareLink.createdBy}
                          </small>
                          {!shareLink.revokedAt && (
                            <button type="button" onClick={() => revokePageShareLink(shareLink)}>
                              Revoke
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>No share links yet.</p>
                  )}
                </section>
              )}

              {pagePanelTab === "activity" && (
                <section className="pagePanelSection">
                  <h2>Activity</h2>
                  {pageDetail?.activity.length ? (
                    <div className="activityList">
                      {pageDetail.activity.map((event) => (
                        <article className="activityItem" key={event.id}>
                          <span>{event.summary}</span>
                          <small>
                            {event.actor} · {new Date(event.createdAt).toLocaleString()}
                          </small>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>No page activity yet.</p>
                  )}
                </section>
              )}
            </aside>
          )}
        </div>
          </>
        )}
      </section>

      {onboardingOpen && (
        <div className="onboardingOverlay" role="dialog" aria-modal="true">
          <div className="onboardingCard">
            <div className="onboardingHeader">
              <strong>Welcome to Company Brain</strong>
              <button type="button" onClick={dismissOnboarding} title="Skip setup">
                Skip
              </button>
            </div>

            {onbStep === 0 && (
              <div className="onboardingStep">
                <h3>1 · Agent providers</h3>
                <p>Company Brain runs agents through the agent CLIs installed on this host.</p>
                <div className="memoryList">
                  {providers.map((p) => (
                    <div className="sourceItem" key={p.id}>
                      <span>
                        {p.id} {p.detection.available ? "✓ available" : "✗ not found"}
                      </span>
                      <small>{p.detection.available ? p.detection.version ?? p.detection.path : p.detection.error}</small>
                    </div>
                  ))}
                  {providers.length === 0 && <p className="laneEmpty">No providers detected.</p>}
                </div>
                <button type="button" onClick={() => setOnbStep(1)}>
                  Next
                </button>
              </div>
            )}

            {onbStep === 1 && (
              <div className="onboardingStep">
                <h3>2 · Create your first agent</h3>
                <label>
                  Name
                  <input value={onbName} onChange={(event) => setOnbName(event.target.value)} placeholder="Scribe" />
                </label>
                <label>
                  Provider
                  <select value={onbProvider} onChange={(event) => setOnbProvider(event.target.value)}>
                    <option value="">(none)</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.detection.available}>
                        {p.id}
                        {p.detection.available ? "" : " (not found)"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Persona (system prompt)
                  <textarea
                    className="entityEditor"
                    rows={5}
                    value={onbPersona}
                    onChange={(event) => setOnbPersona(event.target.value)}
                  />
                </label>
                {onbError && <p className="runError">{onbError}</p>}
                <div className="onboardingActions">
                  <button type="button" onClick={() => setOnbStep(0)}>
                    Back
                  </button>
                  <button type="button" onClick={createFirstAgent} disabled={onbBusy || !onbName.trim()}>
                    {onbBusy ? "Creating…" : "Create agent"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

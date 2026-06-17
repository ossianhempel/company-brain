# Cabinet — Deep Dive & Comparison to Company Brain

> Research date: 2026-06-16. Source: `github.com/hilash/cabinet` @ v0.4.4 (commit `9ba42f6`, MIT).
> Purpose: extract Cabinet's logic, storage, data model, agent runtime, and UX so we can decide
> how much of it to adopt in a markdown-first refactor of Company Brain.

---

## 1. What Cabinet is

Cabinet (by Hila Shmuel, ex-Apple EM; built in public) markets itself as **"the AI-first startup OS
where everything lives as markdown files on disk. No database. No vendor lock-in. Self-hosted."**

It is a **single-operator tool**: one person runs a folder of markdown files, hires a team of AI
agents (each a `persona.md`), and watches them work via a Kanban board. The pitch is "if it feels
like enterprise workflow software it's wrong; if it feels like watching a team work it's right."

Tech: **Next.js 16 app + Electron desktop wrapper + a long-lived Node daemon**, plus a `cabinetai`
npm CLI installer and two first-party MCP servers (Discord, Telegram).

---

## 2. Process & runtime model

Two processes:

- **Next.js app** (port 4000) — UI + API routes; all page/agent/file CRUD.
- **`server/cabinet-daemon.ts`** (port 4100, ~2,180 lines) — the engine:
  - **cron scheduler** (node-cron) for agent heartbeats + jobs
  - **provider adapters** that spawn agent CLIs as child processes
  - in-memory **search index** (FlexSearch + chokidar file watcher)
  - **two WebSocket servers**: one for PTY/terminal streaming, one event-bus (`task.updated`, `search`)
  - a small **HTTP API** the Next app calls over a bearer token

The app drives the daemon via `daemon-client.ts`, polling `/session/:id/output` every 700ms for live
transcript streaming. Inter-process auth is a 32-byte token at `.agents/.runtime/daemon-token`.

---

## 3. Storage model — "files on disk + git" (with an asterisk)

This is the most relevant part for Company Brain.

### 3.1 On-disk layout (a "cabinet" = a folder)

```
<cabinet>/
  .cabinet              # YAML identity manifest (schemaVersion, id, name, kind, entry: index.md)
  index.md              # entry page (markdown + YAML frontmatter)
  .agents/              # agents + runtime state
    <slug>/persona.md   # an AGENT = ONE markdown file (frontmatter + body = system prompt)
    <slug>/tasks/<uuid>.json     # agent->agent task handoffs
    .conversations/<id>/         # per-run transcripts (meta.json, prompt.md, transcript.txt, turns/)
    .messages/, .history/, skills/
  .jobs/<id>.yaml       # scheduled jobs, one YAML file each
  .chat/                # channels.json + per-channel dirs (messages.md, pins.json)
  .cabinet-state/       # runtime state + file-history.jsonl journal (gitignored)
  <pages...>/           # user content: nested dirs / .md files
  .cabinet.db           # better-sqlite3 sidecar (see 3.4)
  .git/                 # auto-initialized, "cabinet.managed=true" marker
```

Data root resolution order: `CABINET_DATA_DIR` → `.cabinet-install.json` `dataDir` → Electron default
(`~/Documents/Cabinet`) → source default (`<repo>/data`). Nested cabinets ("rooms") are any subdir
with its own `.cabinet` manifest; each room is an **isolated sibling cabinet** with its own agents,
pages, tasks, jobs, chat.

### 3.2 Pages = Markdown + YAML frontmatter

- Parsed/written with `gray-matter`. Frontmatter is **minimal**: `title, created, modified, tags,
  order, icon, dir` (+ optional `google` embed metadata). **No `id` or `slug` field.**
- **Identity IS the file path.** A page is either `foo/index.md` (directory page) or `foo.md`
  (standalone); both resolve to virtual path `foo`. Slug = slugified last path segment.
- Wiki-links `[[Page Name]]` resolve by slugifying the text and matching a page's last path segment.
- WYSIWYG roundtrip: Tiptap editor → HTML → markdown via Turndown+GFM on save; markdown → HTML on
  load. **The editor is rich; the storage is plain markdown.** (Key lesson: WYSIWYG ≠ HTML storage.)
- Sibling ordering: frontmatter `order` + optional `.cabinet-order.yaml` sidecar per directory.

### 3.3 Git auto-commit (`src/lib/history/engine.ts`)

Every save auto-commits, with two hard rules:
1. **Stage explicit paths only — never `git add .`** (so an agent's edits never get swept into a
   user's commit; attribution stays clean).
2. **Never auto-commit a repo Cabinet didn't create** (gated by a `cabinet.managed=true` git config marker).

- Commits are **per-room** (walks up to the enclosing `.cabinet`).
- Author attribution: users commit as themselves; agents commit as `DisplayName (room)
  <agent@cabinet.local>` with `Cabinet-Agent:` and `Cabinet-Run:` trailers.
- History/diff/restore = plain `git log --file`, `git diff hash~1 hash`, `git checkout hash -- file`.
- A regenerable JSONL journal at `.cabinet-state/file-history.jsonl` (capped 5MB) backs the UI history
  view; **git stays the source of truth**.
- `manualCommit()` is the only path that uses `git add .`.

### 3.4 The "no database" claim is marketing

There **is** a `better-sqlite3` DB at `.cabinet.db` (WAL mode, FK on) with a real migration defining
`sessions, messages, activity, job_runs, mission_tasks`. **In practice only `messages` (chat) is
used**; the rest are defined but unwired. **No PGlite, no Postgres, no vector store anywhere.**

### 3.5 Search = in-memory FlexSearch

Rebuilt at daemon boot by walking the data dir; kept live by a chokidar watcher (150ms debounce).
Hand-rolled field weighting (title 100 / headings 50 / tags 30 / body 10 / path 5) + recency boost
from frontmatter `modified`. Scopes: pages / agents / tasks; **room-scoped and fail-closed**.
**No embeddings, no BM25 library, no hybrid retrieval, no memory-extraction layer.** It is full-text
search over files — nothing more.

**Storage takeaway:** Cabinet = "markdown files + git as source of truth, tiny SQLite sidecar,
ephemeral in-memory search index." There is no memory/retrieval layer to speak of.

---

## 4. Agents, cron, and CLI auto-detection

### 4.1 An agent = a markdown file

`persona.md` frontmatter: `name, slug, emoji, type (lead|specialist), department, role,
provider (claude-code), heartbeat (cron expr), budget, active, goals[] (metric/target/current),
focus[], tags[], skills[], recommendedSkills[], channels[], workdir, workspace, canDispatch`.
The **markdown body is the system prompt**, with `{{company_name}}` / `{{goals}}` templating. Ships
**~42 library templates** (CEO/CTO/CFO/Researcher/QA/DevOps/SEO/…) materialized into `.agents/<slug>/`.

### 4.2 Provider adapter layer + CLI auto-detection (the part we want)

- **8 supported CLIs**: claude-code, codex-cli, gemini-cli, cursor-cli, opencode, pi, grok-cli,
  copilot-cli. Two adapters each:
  - structured `*_local` (the default) — spawns e.g. `claude -p --output-format stream-json
    --include-partial-messages --verbose [--resume <id>] [--model <m>] [--effort <e>]`, parses
    streamed JSON for session id / usage / model / errors; resumable via a session codec.
  - legacy `*_legacy` (PTY) — for the terminal view only.
- **Per-run overrides** (provider/model/effort/runtime-mode) flow through one
  `normalizeRuntimeOverride()` chokepoint; personas/jobs supply fallbacks.
- **Auto-detection** (`provider-cli.ts`), three tiers:
  1. resolve via `commandCandidates` (absolute paths checked with `accessSync(X_OK)`, then `which`/`where.exe`)
  2. `<cmd> --version` with 5s timeout → availability
  3. per-provider `healthCheck()` (`claude auth status`, `codex login status`, `opencode auth list`, env checks)
  - PATH enriched with `~/.local/bin`, homebrew, **and nvm** (reads `$NVM_DIR/alias/default`, falls
    back to newest `versions/node/*`). This is exactly the "detect what's installed on the machine" behavior.

### 4.3 Cron — two concepts, both node-cron in the daemon

- **Heartbeats** — recurring agent check-ins, stored in persona frontmatter (`heartbeat: "0 9 * * 1-5"`,
  gated by `active` + `heartbeatEnabled`).
- **Jobs/routines** — discrete prompts as `.jobs/<id>.yaml`: `schedule (cron), provider, prompt,
  ownerAgent, on_complete[], on_failure[], oneShot`, plus iCal-style `runAfter/exceptions/since/until`.
  ~40 pre-built job templates (`weekly-strategy-digest`, `daily-priority-check`, `bug-triage-digest`, …).
- A chokidar watcher on `persona.md` + `.jobs/*.yaml` triggers `reloadSchedules()`. On fire, the
  daemon PUTs `/api/agents/.../run`. `oneShot` jobs self-disable after firing.

### 4.4 Tasks = a UI projection of conversations

There is **no separate task store**. A conversation's `meta.json` status
(`idle/running/awaiting-input/done/failed/archived`) maps to Kanban lanes via `lane-rules.ts`:

| Lane | Rule |
|---|---|
| **Inbox** | idle, no prior activity (drafts) |
| **Your Turn** | `awaiting-input` OR `failed` |
| **Running** | running |
| **Just Finished** | done within last 60 min |
| **Archive** | archived / done >1h / idle-with-history (heartbeats collapsed by agent) |

Conversations are stored as a directory per run: `meta.json`, `prompt.md`, `transcript.txt`,
`turns/NNN-{user,agent}.md`, `session.json`, `events.log`. The agent emits a fenced ` ```cabinet `
block (`SUMMARY:`/`CONTEXT:`/`ARTIFACT:`) that `finalizeConversation()` parses into the card.
"Awaiting input" is detected via `<ask_user>…</ask_user>` markers.

---

## 5. Onboarding

README says "5 questions"; reality is an **11-step wizard** (`onboarding-wizard.tsx`, 3,567 lines).
Real inputs: name, email, cabinet name, goal/description, **provider** (live install/verify guide per
CLI), **one agent** (name + instructions + heartbeat toggle: Hourly/Daily 9AM/Weekly), **first task**,
then GitHub-star / Discord / Cloud-waitlist / launch screens. On launch it scaffolds the room, installs
a forced `editor` agent + the user's one agent, and creates a `#general` channel. The 20-template /
keyword→team mapping machinery exists in code but is **legacy/unused** on the current path. The UX is
the strong part: warm "watch a team work" framing, typewriter animations, a live mock sidebar that
fills in DATA/TEAM/TASKS as you answer.

---

## 6. UI / navigation

Left sidebar is a **three-drawer tab interface**:

- **DATA** (⌘1) — hierarchical file/folder tree of the markdown files, scoped to the active room.
  Rich viewers: PDF, CSV (editable), DOCX/XLSX/PPTX, Mermaid, Jupyter, images, Google-linked pages,
  symlinked external repos. Context menu: add page/folder, import, connect knowledge (symlink), create cabinet, rename, move, delete.
- **TEAM** (⌘2) — list of agents in the active cabinet (editor first), green dot if running.
- **TASKS** (⌘3) — recent conversations/tasks with status dots; also the Kanban/List/Schedule board.

Editor: Tiptap WYSIWYG, ~19 slash commands, `[[wiki-links]]`, `@`-mentions, callouts, math, tables.
**Embedded HTML apps** are the headline differentiator: drop `index.html` in a folder → renders as a
sandboxed iframe with a full-screen "App" mode. Cmd+K search palette with a command mode (`/theme`, `/open`).

---

## 7. Multiplayer — the critical reality check

**Cabinet is single-user-local. There is essentially NO multiplayer.**

- Auth = a single optional shared password gate (`KB_PASSWORD`, PBKDF2-HMAC-SHA256 over a per-install
  salt, rate-limited). **No per-user accounts, no roles, no RBAC, no SSO, no CSRF.**
- "Internal Chat" has a complete backend (`chat-io.ts`, channels + SQLite messages + pins + mentions)
  but **zero UI wired to it**, and agents don't use it (they post to Slack or local JSONL). The one
  chat/Slack panel lives in `MissionControl`, which **isn't mounted anywhere** in the live app.
- **No comments on pages, no suggest-changes, no presence, no live cursors, no co-editing** (no Yjs/CRDT).
  "Sharing" copies the runcabinet.com marketing URL. "Cabinet Cloud" is a waitlist email form.
- Files-on-disk + git auto-commit actively **fights** concurrent multi-user editing (locks, merge
  conflicts) — fine for a solo operator, a problem for a multi-user "company" brain.

---

## 8. Cabinet vs Company Brain (today)

| Dimension | **Cabinet** | **Company Brain (today)** |
|---|---|---|
| Thesis | Solo-founder "AI startup OS" | Multi-user **company** brain + SSO/RBAC |
| Page format | Markdown + frontmatter | Sanitized **HTML** (DB columns) |
| Source of truth | **Files on disk + git** | **PGlite/Postgres** (DB canonical) |
| Page identity | File path (no id/slug) | UUID + unique slug rows |
| Memory layer | None — full-text only | **source_artifacts + memories + citations** (real) |
| Retrieval | In-memory FlexSearch | BM25 + lexical recall (real); hybrid/vectors = vision |
| Entities/profiles/events | None | Vision-only |
| Agent runtime | **Rich** (8 CLI adapters, auto-detect, daemon) | **None** |
| Cron/jobs | **Heartbeats + jobs** (node-cron, YAML) | **None** |
| Tasks/Kanban | **Yes** (conversation-projected) | **None** |
| Onboarding | **11-step wizard** | None |
| Nav | **DATA / TEAM / TASKS** | Single page-tree SPA |
| Editor | Tiptap over **markdown** | Tiptap over **HTML** |
| Collaboration | Single-user, password gate | comments/versions/share-links/permissions built; SSO/RBAC = vision |
| Deploy | npx / Electron | one container + one volume (vision; no Dockerfile yet) |
| Stack | Next.js + daemon + SQLite | Hono + React/Vite + CLI + MCP + PGlite |

**The two projects are nearly complementary.** Cabinet is strong exactly where Company Brain is empty
(agent runtime, cron, tasks, onboarding, DATA/TEAM/TASKS UX, files+git portability). Company Brain is
strong exactly where Cabinet is empty (memory primitives, citations, BM25 recall, comments/versions/
permissions, multi-user ambitions, the hybrid-retrieval thesis).

---

## 9. Broader lessons for the AI-memory space (not just Company Brain)

1. **WYSIWYG editing does not require HTML storage.** Cabinet keeps a rich Tiptap editor while
   persisting plain markdown (Turndown on save). You get clean git diffs *and* a nice editor.
2. **"No database" is rarely literally true and shouldn't be.** Even a files-first system needs a
   queryable index. The honest framing is *which store is canonical* — files for human-editable,
   portable content; a derived/rebuildable DB for retrieval and structured memory.
3. **Agents-as-markdown-files is a powerful, inspectable primitive.** A persona is just a prompt with
   frontmatter; a job is just YAML + cron. The whole "AI team" is `git diff`-able and portable.
4. **Tasks need not be a first-class entity.** Cabinet derives the entire Kanban from conversation
   transcripts on disk. Status is computed, not stored.
5. **Provider-adapter + CLI auto-detection is the right abstraction** for "bring your own AI" — detect
   what's installed (PATH + nvm + auth health), normalize provider/model/effort at one chokepoint.
6. **Git is an underrated memory substrate**: history, diff, revert, attribution, and portability for
   free — *if* writes are serialized (Cabinet gets away with this only because it's single-writer).
7. **The gap Cabinet leaves wide open is exactly the interesting AI-memory problem**: extraction of
   durable memories from artifacts/conversations, citations/provenance, entities/profiles, and hybrid
   retrieval. That's the layer worth building on top of a files+git substrate.

### The complementary reference: GBrain (Garry Tan, MIT)

GBrain is the mirror image of Cabinet on the memory axis and the model worth stealing for retrieval:

- A git **"brain repo"** of markdown files = human-readable source of truth (same as Cabinet).
- **Synced into Postgres/pgvector** for retrieval — files canonical, DB derived. PGlite locally,
  Postgres/Supabase for shared/multi-machine. **Git deletes become soft-deletes in the DB.**
- **Hybrid retrieval done right**: vector (HNSW on pgvector) + BM25 + **Reciprocal Rank Fusion**,
  optional multi-query expansion (Haiku) + reranker (ZeroEntropy).
- "GStack" is Garry's separate Claude Code agent setup (CEO/designer/eng-manager/QA personas) that
  runs *alongside* GBrain — i.e. GBrain = memory, GStack = the agents.

**The synthesis for Company Brain:** GBrain's git+pgvector storage/retrieval model + Cabinet's
company-grade UI/runtime (DATA/TEAM/TASKS, adapters, cron, onboarding) + Company Brain's own
multi-user/SSO/RBAC and structured memory (memories/citations/entities/profiles). Git lineage is the
shared substrate all three respect; the DB is always derived from it.

> Sources: [garrytan/gbrain](https://github.com/garrytan/gbrain) ·
> [What Is GBrain? (Vectorize)](https://vectorize.io/articles/what-is-gbrain) ·
> [GBrain self-wiring knowledge graph (L. Berton)](https://lucaberton.com/blog/garry-tan-gbrain-ai-agent-knowledge-graph-2026/)

---

## 10. Key file references (in the cloned repo)

- Storage: `src/lib/storage/{cabinet-scaffold,page-io,path-utils,order-store}.ts`
- Git/history: `src/lib/git/git-service.ts`, `src/lib/history/engine.ts`
- Agents: `src/lib/agents/{persona-manager,conversation-store,conversation-runner,task-inbox}.ts`,
  `src/lib/agents/library/<slug>/persona.md`
- Adapters/detection: `src/lib/agents/adapters/{registry,claude-local,codex-local}.ts`,
  `src/lib/agents/{provider-cli,provider-registry,runtime-overrides,nvm-path}.ts`
- Jobs/cron: `src/lib/jobs/{job-manager,job-library}.ts`, `src/types/jobs.ts`,
  `server/cabinet-daemon.ts` (scheduleJob/scheduleHeartbeat/reloadSchedules)
- Tasks/Kanban: `src/components/tasks/board/lane-rules.ts`, `src/lib/agents/conversation-to-task-view.ts`
- Search: `server/search/{index-builder,search-service,watcher}.ts`
- DB: `server/migrations/001_initial.sql`, `src/lib/db.ts`, `server/db.ts`
- Onboarding: `src/components/onboarding/onboarding-wizard.tsx`, `src/lib/onboarding/rooms.ts`
- Auth: `docs/AUTH.md`

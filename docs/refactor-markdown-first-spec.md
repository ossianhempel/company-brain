# Refactor Spec — Markdown-First, Files+Git Canonical

> Status: proposed (2026-06-16). Supersedes the HTML/DB-canonical direction in earlier docs.
> Companion: `docs/cabinet-deep-dive.md` (research this is based on).

## Decision summary (locked)

| Decision | Choice |
|---|---|
| **Page format** | **Markdown + YAML frontmatter** (was: sanitized HTML). Tiptap WYSIWYG stays — it round-trips to markdown via Turndown, like Cabinet. |
| **Source of truth** | **Files on disk + git are canonical.** PGlite becomes a **rebuildable derived index** + home for non-page memory primitives. |
| **Audience** | **Multi-user company brain** — keep SSO/RBAC, comments, suggest-changes. (This is the hard part Cabinet doesn't have.) |
| **Cabinet adoption** | **Port the model, write fresh code** in our Hono + React/Vite + CLI + MCP stack. MIT lets us borrow patterns freely. |

The non-negotiable: **do not delete Company Brain's memory/retrieval layer** (source_artifacts,
memories, citations, BM25 recall) during the refactor. That layer — plus multi-user — is the entire
reason Company Brain exists and is exactly what Cabinet lacks.

### Positioning: a three-way synthesis (Cabinet + GBrain + Company Brain)

This refactor is best understood as combining three reference points:

- **Cabinet** → the *company-grade UI + agent runtime* (DATA/TEAM/TASKS, pretty pages, Kanban,
  provider adapters, cron, onboarding). Practical functionality for a *team*, not a solo brain.
- **GBrain** (Garry Tan, MIT) → the *storage + retrieval model*: a git "brain repo" of markdown as the
  human-readable source of truth, **synced into Postgres/pgvector for retrieval**, with **hybrid search
  = vector (HNSW pgvector) + BM25 + Reciprocal Rank Fusion + optional rerank**. PGlite locally,
  Postgres/Supabase for shared/multi-machine. *(Note: GBrain is the memory; "GStack" is Garry's
  separate Claude Code agent setup that runs alongside it.)* This is exactly the "files canonical,
  DB derived" model — and it validates pgvector-in-PGlite and RRF fusion as the retrieval path.
- **Company Brain** → what neither has: **multi-user, SSO/RBAC, comments, suggest-changes**, and a
  structured memory layer (memories/citations/entities/profiles) beyond raw chunk retrieval.

**The git lineage is a first-class feature, not just a backup.** Every change — by a human or an
agent — is a tracked, attributed, reconstructible commit. This lineage is precisely what makes the
substrate valuable for agents (audit, revert, "how did this knowledge evolve", blame-as-provenance).
The DB never replaces git history; it *derives* from it. Git deletes become **soft-deletes** in the
DB (GBrain's pattern), so retrieval can still cite history while the working tree stays clean.

---

## 1. Target architecture

```
Single app process / container (unchanged default):
  Hono server  ── the ONLY writer to the git working tree (serializes commits)
  React/Vite web UI (DATA / TEAM / TASKS)
  PGlite  ── DERIVED index + memory + users/permissions/presence (rebuildable from files)
  in-process job scheduler (node-cron)         [NEW — ported from Cabinet]
  provider-adapter layer + CLI auto-detection  [NEW — ported from Cabinet]
  MCP stdio/HTTP server
  SSE/WebSocket realtime
```

Two layers, clear contract:

- **Canonical layer — `/data/workspace/` (a git repo).** Everything human-editable and portable:
  pages (`.md`), agents (`persona.md`), jobs (`.yaml`), conversation transcripts. Git history is the
  audit log and the future "git-backed brain mirror."
- **Derived layer — `/data/index/` (PGlite).** Fully rebuildable from the workspace by a single
  `reindex` pass. Holds: search/recall index (chunks, links, plain-text, BM25/embeddings), the
  **memory primitives** (memories, citations, entities, profiles), and **operational state that does
  NOT belong in git** (users, sessions, RBAC grants, presence, share-link tokens, activity feed).

Rule of thumb for "file vs DB": *if a human or agent should edit it and a teammate should diff it →
file. If it's an index, a secret/credential, identity/permission state, or high-churn operational data
→ DB.*

### Why this beats both predecessors
- Keeps Cabinet's portability/inspectability/git-history wins.
- Keeps Company Brain's hybrid retrieval + structured memory (impossible on files alone).
- Fixes the current PGlite lock-contention pain: a corrupted index is just `rm -rf /data/index && cb reindex` — files stay safe.

---

## 2. On-disk data model (`/data/workspace/`)

```
workspace/
  .brain                       # YAML manifest: schemaVersion, id, name, created
  config.yml                   # workspace settings (non-secret)
  pages/                       # human docs — markdown, path = identity
    engineering/
      onboarding.md            #   standalone page
      runbooks/
        index.md               #   directory page -> virtual path "engineering/runbooks"
        deploy.md
  .agents/
    <slug>/persona.md          # agent = frontmatter + body(system prompt)
    .conversations/<id>/       # transcripts: meta.json, prompt.md, transcript.txt, turns/, events.log
  .jobs/<id>.yaml              # scheduled jobs (cron + prompt + owner + on_complete/on_failure)
  attachments/                 # binary blobs referenced by pages/artifacts (large files)
```

Secrets and identity are **not** in the workspace:

```
/data/index/              # PGlite cluster (derived)
/data/secrets.env         # API keys, auth salt (chmod 0600, never in git)
/data/config.local.json   # per-install (dataDir, ports)
```

### 2.1 Pages
- Markdown + frontmatter. Frontmatter: `title, created, updated, tags, order, icon,
  visibility (workspace|restricted|public), owner`. **Identity = path** (Cabinet model), but we ADD a
  stable `id` (UUID) in frontmatter so renames/moves don't break memory citations or share links
  (Cabinet skips this and pays for it). Path is the human-facing slug; `id` is the durable key.
- Sanitization still applies at the **render/edit boundary** (DOMPurify in the editor + server-side
  sanitize when converting Tiptap HTML → markdown and back), but storage is markdown.
- `[[wiki-links]]` and `@mentions` preserved; links extracted into the DB `page_links` index.

### 2.2 Agents (ported from Cabinet)
`persona.md`: frontmatter (`name, slug, role, provider, model, effort, heartbeat (cron), active,
goals[], skills[], channels[], department, workspace, canDispatch`) + body = system prompt with
templating. Library of starter templates shipped in-repo, materialized on onboarding.

### 2.3 Jobs (ported from Cabinet)
`.jobs/<id>.yaml`: `id, name, enabled, schedule (cron), provider, prompt, ownerAgent, timeout,
on_complete[], on_failure[], oneShot, since/until/exceptions`.

### 2.4 Conversations / tasks (ported from Cabinet)
Per-run directory; status lives in `meta.json`. Tasks are a **projection** (no separate task store) —
the Kanban lanes are computed (Inbox / Your Turn / Running / Just Finished / Archive).

---

## 3. Derived DB schema (`/data/index/`, PGlite)

Three groups. All of group A is rebuildable from files; groups B and C are operational and the only
parts that are *authoritative* in the DB.

**A. Search/recall index (rebuildable — GBrain-style git→DB sync):**
- `pages_index(id, path, title, plain_text, updated_at, content_hash, deleted_at)` — mirror of file frontmatter+derived text; `content_hash` drives incremental reindex
- `page_chunks(page_id, chunk_index, heading_path, text, token_count, embedding vector)` — pgvector column (HNSW index)
- `page_links(source_page_id, target_path, target_page_id)` — backlinks
- `source_chunks(...)` for artifacts

Retrieval = **hybrid (GBrain pattern): pgvector HNSW (semantic) + BM25 (lexical) fused via Reciprocal
Rank Fusion**, optional rerank. Embeddings are optional (graceful degradation to BM25-only when no API
key — already the current default). Sync: on each commit, reindex touched paths by `content_hash`;
**a git delete → `deleted_at` soft-delete in the index** (history stays citable, working tree stays clean).

**B. Memory primitives (mostly rebuildable, but the canonical *facts* live here — see open Q3):**
- `source_artifacts`, `memories` (fact/decision/preference/status/contradiction, confidence,
  superseded_by), `memory_sources` (citations → page_id/chunk/artifact/manual + quote)
- `entities` + `entity_links`, `profiles` (person/team/project/repo) — **new, vision → real**

**C. Operational / multi-user (authoritative in DB, NOT in git):**
- `users, sessions, identities (SSO)`, `role_grants` (RBAC: workspace/page-scoped),
  `page_permissions`, `share_links` (hashed tokens), `presence`, `activity`, `comments`,
  `suggestions` (suggest-changes diffs awaiting approval)

> Note: `comments`/`activity` are operational and live in DB (high churn, multi-user). Pages and their
> versions are git. This splits Company Brain's current single-DB model along the canonical/derived line.

---

## 4. The hard problem: serialized git writes for multi-user

Cabinet is single-writer, so it auto-commits freely. We are multi-user, so **the Hono server must be
the sole writer to the working tree** and serialize all mutations. Design:

1. All page/agent/job writes go through one **write queue** in the server (per-workspace mutex). No
   direct file writes from the UI, CLI `--direct`, or MCP — they all call the API.
2. Each mutation: validate permission → sanitize → write file → `git add <explicit paths>` →
   `git commit --author="<user>"` (attribution like Cabinet's trailers, but real user identity from
   RBAC) → enqueue reindex of touched paths.
3. **Concurrent edits** to the same page resolve via optimistic concurrency: client sends the
   `base_version` (last commit hash it saw); server rejects on mismatch and offers a merge/diff. (No
   CRDT in Level 1 — that's Collaboration Level 3, deferred, per the plan.)
4. **suggest-changes** = write to a `suggestions` row (a proposed markdown diff) instead of committing;
   on approval the server applies + commits with co-attribution.
5. CLI `--direct` mode is **demoted**: allowed only when the server is down, and it takes the same git
   lock. This kills the current PGlite-lock race (CLI vs server both writing) because the *DB* is no
   longer canonical and the *files* have one writer.

This is the one piece **neither codebase has** and must be designed before ripping out the
HTML/DB-canonical code.

---

## 5. Agent runtime, adapters, cron (port from Cabinet)

- **Provider adapter layer**: structured `*_local` adapters (claude_local, codex_local first; gemini/
  opencode next) that spawn the CLI, stream JSON, parse session/usage/errors; per-run override
  chokepoint for provider/model/effort.
- **CLI auto-detection**: PATH (+ homebrew + nvm) resolution, `--version` probe, `auth status` health
  check. Surface install/auth status in onboarding + settings.
- **Scheduler**: in-process node-cron (no separate daemon process — keep the one-container default).
  Heartbeats from persona frontmatter; jobs from `.jobs/*.yaml`; chokidar watcher → reload schedules.
- **Conversations**: transcript dirs on disk; SSE/WS for live streaming; finalize parses a fenced
  result block for summary/artifacts.
- **Agent writes obey RBAC and the git serializer** like any user (agents commit with their own
  attributed identity — Company Brain's multi-user twist on Cabinet's agent commits).

---

## 6. UI / nav (port DATA / TEAM / TASKS)

- **DATA** — file tree of `pages/` + viewers; Tiptap editor over markdown; comments/versions/share
  panels (already built — keep). Memory/recall panel (already built — keep).
- **TEAM** — agents list + detail (new); per-agent jobs/heartbeats.
- **TASKS** — Kanban / List / Schedule, conversation-projected (new).
- **Onboarding wizard** (new) — adapt Cabinet's flow: name → workspace → goal → **provider detect/verify**
  → first agent (+ heartbeat) → first task. Plus our multi-user step: SSO/admin setup.

---

## 7. MCP + CLI surface

Extend the existing surfaces (already strong: 18 MCP tools, dual-mode CLI) rather than replace:
- Pages/memory tools keep working but now write through the git serializer.
- Add agent/job/conversation tools: `list_agents, run_agent, create_job, list_tasks, get_conversation`.
- Add `cb reindex` (rebuild `/data/index` from workspace), `cb export` / `cb import` (round-trip the
  file tree), `cb doctor` (now checks git working tree + CLI providers + index freshness).
- Keep `cb migrate to postgres|supabase` for the scale path; the derived index moves, files stay.

---

## 8. Migration plan (phased, low-risk)

**Phase 0 — design & guardrails.** Write the git-serializer + permission-check contract. Update
`CLAUDE.md` (it currently says "keep PGlite as operational source of truth" — invert that) and the
Obsidian plan. ✅ this spec.

**Phase 1 — storage inversion (pages).** Introduce `/data/workspace/` git repo. Change the pages
store: write markdown files (Tiptap→Turndown), commit via serializer, keep PGlite as a derived
`pages_index`/`page_chunks`/`page_links`. Migrate existing HTML pages → markdown files once. Existing
comments/versions/share-links/permissions move to the operational DB tables. Add `cb reindex`.

**Phase 2 — memory on the new substrate.** Re-key memories/citations to page `id` (now in frontmatter).
Keep BM25 recall. Add `entities`/`profiles` tables (vision → real). Rebuildable index proven.

**Phase 3 — agent runtime + cron.** Port adapter layer + CLI detection + scheduler + conversation
transcripts. `.agents/`, `.jobs/` land in the workspace.

**Phase 4 — TEAM/TASKS UI + onboarding wizard.** Conversation→Kanban projection; agent detail; wizard.

**Phase 5 — multi-user hardening.** SSO identities, RBAC grants, suggest-changes approval flow,
presence, optimistic-concurrency merge UI. (Collaboration Levels 1–2 from the plan; CRDT = Level 3, later.)

Each phase ships independently and keeps `cb doctor` green.

---

## 9. What to port / keep / build

| | |
|---|---|
| **Port from Cabinet (patterns, fresh code)** | persona.md model, `.jobs` YAML + node-cron, git auto-commit engine (explicit-paths, `managed` marker, attribution, JSONL journal), provider adapters + CLI auto-detection, conversation transcript dirs, conversation→Kanban projection, DATA/TEAM/TASKS nav, onboarding wizard, embedded `index.html` apps |
| **Keep from Company Brain (defend!)** | memory/source-artifact/citation model, BM25 recall, comments/versions/share-links/permissions/activity, Hono+React/Vite+CLI+MCP stack, 18-tool MCP, one-container default |
| **Build new (neither has)** | server-as-single-git-writer + write queue, SSO/RBAC, suggest-changes approval, entities/profiles as real tables, optimistic-concurrency merge, agent writes under RBAC |

---

## 10. Risks & open questions

1. **Multi-user + files-first is unproven territory.** The git-write-serializer is the linchpin; design
   and load-test it before Phase 1. (Risk: write throughput under many users/agents.)
2. **Markdown fidelity loss.** Tiptap↔markdown round-trips lose some rich HTML (complex tables, inline
   styles). Decide the allowed block set up front (plan already lists it); store unsupported richness
   as fenced HTML blocks if needed.
3. **(Open) Are memories canonical in DB or also mirrored to files?** Leaning: memories live in the
   DB (they're derived/operational and high-churn), but emit an optional `.md`/`.json` mirror for the
   git-brain-export. Decide in Phase 2.
4. **(Open) One workspace = one git repo, or per-team rooms (Cabinet's room model)?** Rooms add
   isolation but complicate RBAC. Leaning: single workspace repo with path-scoped RBAC first.
5. **(Open) Binary/large files** — `attachments/` in git (LFS?) vs object storage. Defer to scale mode.
6. **CLI `--direct` deprecation** may annoy existing flows; gate it behind the git lock.

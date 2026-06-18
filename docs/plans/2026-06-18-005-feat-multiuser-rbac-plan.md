---
title: "feat: Multi-user hardening — auth, RBAC, concurrency, suggest-changes (Phase 5)"
type: feat
date: 2026-06-18
status: planned
origin: docs/refactor-markdown-first-spec.md
depth: deep
---

# feat: Multi-user hardening (Phase 5)

The final phase of the markdown-first refactor. Closes the multi-user gap the whole
build deferred: an **optional auth boundary** (server-derived identity, not a client
string), **RBAC** on mutating + host-execution routes, **real per-file optimistic
concurrency** (fixing the documented repo-global false-conflict caveat), and
**suggest-changes** (propose → approve, landing through the single writer). Auth is
optional/configurable so the local single-user dev flow is unchanged.

---

## Problem Frame

Phases 0–4 deliberately shipped unauthenticated, with host-execution paths off by
default and the boundary documented inline ("must not be exposed to untrusted networks
until Phase 5"). Today every mutating route trusts a client-supplied `actor` string,
there is no permission check, concurrent edits to the same page silently overwrite
(the `baseVersion` guard exists but compares repo-global HEAD, so it can't be wired
without false conflicts), and there's no way for a non-writer to contribute. Phase 5
makes Company Brain safe for a team: real identity, role-gated writes, conflict-safe
editing, and a propose/approve flow — all on the existing files-canonical + single-writer
substrate, without breaking the one-container single-user default.

---

## Requirements

Traced to `docs/refactor-markdown-first-spec.md` §3.C, §4 (serialized writes, permission
pre-step, optimistic concurrency, suggest-changes, `--direct` demotion), §Phase 5.

- **R1 — Optional auth boundary.** A pluggable auth layer, **off by default** (the
  install boots unauthenticated as a single `local-user`/admin, preserving today's dev
  flow). When enabled, requests carry identity via a signed session cookie (web) or a
  bearer token (CLI/MCP); the server resolves a **principal** `{id, name, email, roles}`.
- **R2 — Server-derived actor.** When auth is on, the committed identity comes from the
  authenticated principal (reaching `toAuthor`), **not** the client `actor` string.
- **R3 — RBAC.** Roles viewer / editor / admin. Reads open by default (config-gated);
  writes require editor+; host-execution (agent run API, scheduler, admin reindex) and
  user/role administration require admin. Denials return 401 (unauthenticated) / 403
  (forbidden).
- **R4 — Per-file optimistic concurrency.** A client editing a page sends the version it
  last saw (the page's **last-commit oid**); a save conflicts (409) only if **that page's
  file** changed since — never because an unrelated page was committed. Renames are
  handled (the token legitimately changes; `previousSlugs` already tracks history).
- **R5 — Suggest-changes.** An editor without direct write (or anyone choosing to propose)
  creates a suggestion (proposed page body); an approver applies it to the target page
  **through the single writer** under their identity (co-attributed), or rejects it.
- **R6 — Invariants preserved.** Single writer for all writes (including suggestion
  approval and CLI `--direct`); per-file check **inside** the writer mutex; file-first
  ordering (never roll back a durable commit); DB stays rebuildable for file-derived rows;
  `--direct` stays server-down-only (no auth/RBAC bypass).

---

## Key Technical Decisions

- **KTD1 — Auth off by default; opt-in via `COMPANY_BRAIN_ENABLE_AUTH`.** Disabled →
  middleware injects a synthetic `local-user` admin principal so all downstream code is
  uniform and the single-user install is unchanged. Enabled → identity required.
- **KTD2 — Credentials live server-side, never in the workspace git.** `users` (id, name,
  email, role, hashed secret) + `sessions` + `role_grants` are **DB-canonical** in
  migration 14 (the one place the DB is authoritative beyond the derived index — they are
  not rebuildable from files, and committing credentials to the git workspace is
  unacceptable). Bootstrap admin via env/config on first run.
- **KTD3 — SSO is a seam, not a build.** An `AuthProvider` interface (`authenticate(req) →
  principal | null`) with two built-ins: `token` (bearer) and `session` (signed cookie +
  local password). OIDC/Entra is a documented adapter shape, deferred.
- **KTD4 — Per-file version = last-commit oid, checked in the mutex.** Add
  `lastCommitOid(path)` (`git.log({filepath, depth:1})[0].oid`) and a **new**
  `WorkspaceMutation.expectedPathVersion {path, oid}` verified inside `runMutation`
  before `write()`. Do **not** repurpose the repo-global `baseVersion` (that's the
  documented false-conflict trap). A rename changes the token legitimately → 409 → the
  client reloads (acceptable; conservative).
- **KTD5 — Actor becomes an `Actor` object threaded from the principal.** Stores already
  funnel through `toAuthor`; widen the `actor?: string` store params to accept the
  principal's `{name, email}`. When auth is off, it's `local-user`. The client `actor`
  string is ignored once auth is on.
- **KTD6 — Suggestions are files-canonical + derived index.** Proposal = a
  `suggestions/<id>.md` workspace file (frontmatter: target page id, base oid, author,
  status; body: proposed page markdown) reindexed into a `suggestions` table. Approval
  applies the body to the target page via the **same** `persistPageFileMode` writer path
  (file-first, co-attributed), then marks the suggestion approved.
- **KTD7 — `--direct` stays server-down-only.** A `--direct` write bypasses auth/RBAC by
  construction, so it remains refused while the server is up (already enforced); documented
  as an offline-admin escape hatch.

---

## High-Level Technical Design

```mermaid
flowchart TB
  REQ["request (web cookie · CLI/MCP bearer)"] --> CORS["CORS (existing)"]
  CORS --> AUTH["auth middleware (opt-in)<br/>resolve principal {id,name,email,role}<br/>off → synthetic local-user/admin"]
  AUTH --> RBAC["RBAC middleware<br/>GET: open(config) · write: editor+ · run/scheduler/admin: admin"]
  RBAC -->|allowed| ROUTE["route handler"]
  RBAC -->|401/403| DENY["deny"]
  ROUTE -->|actor = principal| WRITER["single git writer.enqueue<br/>expectedPathVersion check IN mutex → 409 on stale<br/>commit (toAuthor=principal) → reindex"]
  ROUTE -->|propose| SUG["suggestions/&lt;id&gt;.md (files-canonical)"]
  SUG -->|approve (admin/editor)| WRITER

  subgraph db["DB-canonical (migration 14, not git)"]
    USERS["users · sessions · role_grants"]
    SIDX["suggestions index (derived, rebuildable)"]
  end
  AUTH -.reads.-> USERS
  WRITER -.reindex.-> SIDX
```

Auth + RBAC are two `app.use("*")` middlewares after CORS; the writer gains a per-file
version check inside its existing mutex; suggestions reuse the area + reindex-hook pattern.

---

## Implementation Units

> **Testing posture:** auth/RBAC/concurrency/suggest-changes are security-critical and
> server-side — **test-first** with explicit permission-denial, conflict, and bypass
> scenarios. Web login/suggest UI has no harness (typecheck + manual QA, as in Phases 2–4).

### U1. Migration 14 — users / sessions / role_grants + suggestions index

**Goal:** Operational tables for auth/RBAC (DB-canonical) and a derived suggestions index.

**Requirements:** R1, R3, R5. **Dependencies:** none.

**Files:** `packages/db/src/index.ts`, `apps/cli/src/index.ts` (migrationTables),
`packages/db/src/index.test.ts` (or a package smoke).

**Approach:** `applyMigration(db, 14, …)`: `users (id, name, email, role, secret_hash,
created_at, deleted_at)`; `sessions (id, user_id, expires_at, created_at)`; `role_grants
(id, user_id, scope, page_slug?, role)` for path-scoped RBAC (single-workspace, per spec
Open-Q4); `suggestions (id, slug, target_page_id, base_oid, author, status, title,
content_hash, created_at, updated_at, deleted_at)` with the live-only unique slug index
(mirror migrations 12–13). Extend the CLI `migrationTables`: add `suggestions`
(file-derived, travels); **exclude** `users/sessions/role_grants` from the file-rebuild
copy or copy explicitly — decide and comment (default: copy them too in `migrate to
postgres`, since they're operational state the operator wants moved).

**Patterns to follow:** migrations 12–13 (entities/agents) live-only unique index + the
content_hash convention.

**Test scenarios:**
- after migrate, insert+read a user, session, role_grant, and suggestion row.
- live-only unique slug index allows a tombstoned + live suggestion with the same slug.
- suggestions status/target indexes usable.

**Verification:** migration applies idempotently; tables usable; migrationTables updated.

### U2. Auth boundary — principal middleware + providers + actor threading

**Goal:** Resolve a principal per request (opt-in); derive the committed actor from it.

**Requirements:** R1, R2. **Dependencies:** U1.

**Files:** `packages/auth/` (new package: `src/index.ts`, `src/index.test.ts`) or
`apps/server/src/auth.ts`; `apps/server/src/index.ts`; `packages/git-writer/src/index.ts`
(Actor already supports name+email — no change expected); store `actor` params in
`packages/{pages,memory,agents}/src/index.ts` widened to accept an `Actor`.

**Approach:** An `AuthProvider` interface `authenticate(headers, cookies) → Principal | null`
and a `createAuth({ enabled, users, sessionSecret })`. Built-ins: **token** (match a
bearer token to a user's `secret_hash`) and **session** (verify a signed cookie → session
row → user; plus a `POST /api/auth/login` that checks a password and sets an HttpOnly,
signed, expiring cookie, and `POST /api/auth/logout`). When `COMPANY_BRAIN_ENABLE_AUTH` is
unset, the middleware injects a synthetic `local-user` admin principal (boot unchanged).
Middleware sets `c.set("principal", …)`; 401 when enabled and no valid principal (except
`/health` + the login route). Thread the principal's `{name, email}` as the `Actor` into
store writes instead of the body `actor` (ignore the client string when auth is on). Users
config loaded from a server-side source (env JSON or a gitignored `data/auth/users.json`),
never the workspace. Document the OIDC adapter seam.

**Execution note:** test-first — write the principal-resolution + cookie-signing + no-bypass
tests before wiring.

**Patterns to follow:** the existing `COMPANY_BRAIN_AGENT_RUN_TOKEN` bearer check (server
~214–226) as the token precedent; `toAuthor` as the identity chokepoint.

**Test scenarios:**
- auth disabled → synthetic local-user admin principal; all current behavior works.
- valid bearer token → principal with that user's id/role; invalid/missing → 401.
- session: login sets a signed cookie; a tampered/expired cookie → 401; logout clears it.
- a committed write under auth attributes the commit to the principal (toAuthor), not the
  client `actor` body string (which is ignored).
- `/health` and `/api/auth/login` are reachable without a principal.

**Verification:** principal resolves from token/session; disabled mode unchanged; commits
attributed to the authenticated identity; no unauthenticated access when enabled.

### U3. RBAC enforcement

**Goal:** Gate mutating + host-execution routes by role.

**Requirements:** R3, R6. **Dependencies:** U2.

**Files:** `apps/server/src/index.ts` (rbac middleware + route policy), auth package
(role helpers), `apps/server/src/*.test.ts` or an integration test harness.

**Approach:** A second `app.use("*", rbac)` after auth. Policy by method/path: GETs open
when `COMPANY_BRAIN_READS_PUBLIC` (default open; configurable to require viewer+); all
POST/PUT/DELETE require editor+; `POST /api/agents/:slug/run`, the scheduler control,
`POST /api/admin/reindex`, and any user/role admin require admin. Generalize the existing
run-API gate into the policy. Page-scoped checks may consult `pages.visibility`/`owner`
(deferred to follow-up if it expands scope — keep workspace-role RBAC for this phase, note
page-scoped as a hook). Denials → 403 with a clear message.

**Execution note:** test-first — permission-denial tests before wiring.

**Patterns to follow:** the run-API 403/401 gate; the onError status mapping.

**Test scenarios:**
- viewer: GET allowed; any write → 403; agent run → 403.
- editor: page/memory writes allowed; agent run / admin reindex → 403.
- admin: all allowed.
- unauthenticated (auth on) → 401 before RBAC.
- auth off → everything allowed (local admin).
- the host-execution routes require admin even when the run API env-gate is enabled.

**Verification:** each role's allowed/denied matrix holds; host-exec admin-only; reads
configurable.

### U4. Per-file optimistic concurrency

**Goal:** Conflicting concurrent edits to the same page 409 without false cross-page conflicts.

**Requirements:** R4, R6. **Dependencies:** none (independent of auth).

**Files:** `packages/git-writer/src/index.ts`, `packages/git-writer/src/index.test.ts`,
`packages/pages/src/index.ts`, `packages/pages/src/index.test.ts`, `apps/server/src/index.ts`,
`apps/web/src/App.tsx`.

**Approach:** Add `lastCommitOid(relPath)` to the git writer (`git.log({filepath, depth:1})`)
and a new optional `WorkspaceMutation.expectedPathVersion { path, oid }` checked **inside
`runMutation`, before `write()`** (in the mutex): if the path's current last-commit oid ≠
expected, throw `WorkspaceConflictError`. Leave the repo-global `baseVersion` untouched
(back-compat / unused). Surface each page's last-commit oid on `getWithRelations` + on
create/update/move returns (a `version` field). `update`/`move` thread the client's
`expectedPathVersion` through `persistPageFileMode` → `enqueue`. Server `pageInput`/move
input accept an optional `baseVersion`/`version` token; the existing onError maps the
conflict to 409. Web `persistPage` sends the last-seen version and handles 409 (reload +
notify; full merge UI deferred). Renames: the token is path-keyed, so a moved file's token
changes — a stale save 409s (conservative, correct).

**Execution note:** test-first for the writer conflict check.

**Patterns to follow:** `history()` (filepath log), `WorkspaceConflictError`, the
`runMutation` mutex ordering (the single-writer learning: check inside the mutex).

**Test scenarios:**
- two saves to the same page: second with a stale `expectedPathVersion` → 409; with the
  current token → succeeds.
- editing page A does **not** conflict with a concurrent commit to page B (no false
  conflict — the core fix).
- a save with no `expectedPathVersion` still works (back-compat / opt-in concurrency).
- the conflict check runs before the write (a racing commit between read and enqueue is
  caught in the mutex).
- after a rename/move, a save with the pre-move token 409s (path-keyed).

**Verification:** same-file conflicts 409; cross-file edits never false-conflict; check is
in-mutex; web surfaces the conflict.

### U5. Suggestions area + format + derived index

**Goal:** A files-canonical `suggestions/` area + codec + reindex.

**Requirements:** R5. **Dependencies:** U1.

**Files:** `packages/workspace/src/index.ts` (+ test), a suggestions codec + reindex (new
`packages/suggestions/` or fold into `pages`), `packages/*/src/*.test.ts`.

**Approach:** Add a `suggestions/` markdown area (wrappers mirroring conversations).
Suggestion file: frontmatter `{id, target_page_id, base_oid, author, status, title}` + body
= proposed page markdown. `parseSuggestion`/`buildSuggestionFile` (mirror entity/agent
codecs). `reindexSuggestions` + `reindexAllSuggestions` + a commit-hook routing `suggestions/*`
→ reindex (mirror reindexEntities; content_hash skip; tombstone-missing). Register the hook
on the shared gitWriter.

**Patterns to follow:** `entity-file.ts` codec; `reindexEntities` + the area commit-hook;
the `agents` area wrappers.

**Test scenarios:**
- build→parse round-trips target/base_oid/author/status/title + body.
- reindex indexes a suggestion row; edit → updates; delete → tombstones; status filter works.
- hook routes a `suggestions/*` commit to reindexSuggestions only.

**Verification:** suggestions are files-canonical, rebuildable, reindexed by the hook.

### U6. Suggest-changes store + flow + API

**Goal:** Propose → approve/reject, with approval applying through the single writer.

**Requirements:** R5, R6. **Dependencies:** U3, U4, U5.

**Files:** suggestions store (`packages/suggestions/src/index.ts` or pages), `apps/server/src/index.ts`,
`apps/cli/src/index.ts`, `apps/mcp/src/index.ts`, store test.

**Approach:** `createSuggestion({ targetPageId, proposedMarkdown, baseOid, author })` writes
the proposal file (status `open`) via the writer → reindex. `listSuggestions({status,target})`,
`getSuggestion(id)`. `approveSuggestion(id, approver)`: load the proposal, apply its body to
the target page via the **same** `persistPageFileMode` path (file-first, co-attributed:
author + approver), then set the suggestion `approved` (a status edit to its file →
reindex). `rejectSuggestion(id, approver)` → status `rejected`. RBAC: create = editor+
(or viewer if "anyone can propose" configured); approve/reject = editor+ with write to the
target (admin in this phase). Server routes: `POST /api/pages/:id/suggestions`,
`GET /api/suggestions[?status&target]`, `GET /api/suggestions/:id`,
`POST /api/suggestions/:id/approve`, `POST /api/suggestions/:id/reject`. CLI + MCP parity.

**Execution note:** test the approval-applies-through-the-writer path with real objects (no
mocks) — it crosses the suggestion store → page store → writer → reindex chain.

**Patterns to follow:** `archiveConversation` (status lifecycle edit through the writer);
`saveEntityFile`; the parity route/CLI/MCP patterns.

**Test scenarios:**
- create a suggestion → proposal file + open row; appears in listSuggestions(open).
- approve → target page's content becomes the proposed body (via the writer, one commit,
  co-attributed), suggestion → approved, leaves the open list.
- reject → suggestion rejected, target page unchanged.
- approve uses the single writer (the page's reindex + version reflect the applied edit).
- a non-writer (viewer) cannot approve (403 at the route).
- approving a stale suggestion (target changed since base_oid) — surface a conflict rather
  than silently clobbering (reuse the U4 per-file check with the suggestion's base_oid).

**Verification:** propose/approve/reject flow; approval lands via the single writer with
co-attribution; stale approval conflicts; RBAC-gated.

### U7. Surfaces — client auth + suggest-changes UI + `--direct` demotion

**Goal:** Wire identity through the clients and expose suggest-changes; keep `--direct` safe.

**Requirements:** R1, R5, R6. **Dependencies:** U2, U3, U6.

**Files:** `apps/cli/src/index.ts` (requestApi token header), `apps/mcp/src/index.ts`
(requestApi token header), `apps/web/src/App.tsx` (login + apiFetch wrapper + suggest UI),
`apps/web/src/styles.css`.

**Approach:** **CLI/MCP:** generalize the existing per-call bearer pattern — `requestApi`
attaches `Authorization: Bearer ${COMPANY_BRAIN_API_TOKEN}` from env when set (covers all
commands/tools). Confirm `--direct` write-guard refuses while the server is up (already
present) — extend the comment to note it bypasses auth and is server-down-only. **Web:**
introduce a single `apiFetch` wrapper (`credentials:"include"`); when auth is enabled and
unauthenticated, render a login screen (`POST /api/auth/login`); after login, identity comes
from the session (drop the `actor:"web"` bodies' authority). **Suggest-changes UI:** in the
page editor, a "Suggest edit" action (when the user lacks direct write or chooses to
propose) → `POST /api/pages/:id/suggestions`; a review queue (list open suggestions, view
proposed body, approve/reject) for approvers.

**Approach (auth-off path):** with auth disabled, `apiFetch` behaves exactly as today (no
login screen) so the dev flow is untouched.

**Test scenarios:** `Test expectation: none for the web UI — no harness (typecheck +
manual QA).` CLI/MCP token attachment is covered by the U2/U3 server tests + a CLI
direct/dual-path smoke. Manual: login gates the app when auth on; Suggest edit creates a
suggestion; approve applies it.

**Verification:** clients send identity; web login works when auth on and is absent when
off; suggest/approve usable; `--direct` still refused while server up; typecheck + build clean.

---

## Scope Boundaries

**In scope:** optional auth (token + session, off by default), workspace-role RBAC on
mutating + host-exec routes, per-file optimistic concurrency, suggest-changes
(propose/approve/reject through the single writer), and client wiring.

### Deferred to Follow-Up Work
- **Full OIDC/SSO providers** (Entra, Google) — only the `AuthProvider` seam ships now.
- **Page-scoped / team-scoped RBAC** beyond workspace roles (the `role_grants.page_slug`
  column is created but enforcement stays workspace-level this phase).
- **Three-way merge UI** for edit conflicts — Phase 5 ships 409 + reload, not CRDT/merge.
- **Presence / live cursors** — out of scope (a separate realtime concern).
- **Suggestion diff/merge UI** beyond view-proposed-body + approve/reject.
- **Per-user rate limiting / audit log surfacing.**

### Out of scope
- Replacing the single-writer model or the files-canonical substrate.
- A visual-regression harness for `apps/web`.

---

## Risks & Mitigations

- **Auth is security-critical and the app shipped open.** Mitigate: test-first on
  principal resolution, RBAC matrix, and no-bypass; auth off-by-default keeps the change
  inert until an operator opts in; credentials never touch the workspace git; sessions are
  signed + expiring; `/health` is the only unauthenticated route besides login.
- **Concurrency check must be race-free.** Per the single-writer learning, the per-file
  oid check runs **inside the writer mutex** before `write()` — never after enqueue —
  so a racing commit can't slip between check and commit.
- **Suggestion approval must not bypass the writer or clobber a changed target.** Approval
  applies via `persistPageFileMode` (single writer, file-first) and reuses the per-file
  version check against the suggestion's `base_oid` to conflict on a stale target.
- **`--direct` is an auth bypass by construction.** Kept server-down-only (already enforced
  by the write-guard); documented as an offline-admin escape hatch.
- **DB-canonical auth tables break the "rebuildable from files" rule — intentionally.**
  `users/sessions/role_grants` are operational state, not file-derived; documented as the
  explicit exception (the `suggestions` index remains file-derived + rebuildable).
- **Don't regress the single-user dev flow.** Auth-off path is exercised by tests and is
  the default; the web `apiFetch`/login is inert when auth is disabled.

---

## Sources & Research

- `docs/refactor-markdown-first-spec.md` §3.C (users/sessions/identities/role_grants/
  suggestions in DB), §4 (one write queue; validate-permission→sanitize→write→commit-with-
  RBAC-identity→reindex; optimistic concurrency via base_version; suggest-changes;
  `--direct` server-down-only), §Phase 5, Open-Q4 (single workspace + path-scoped RBAC).
- `docs/cabinet-deep-dive.md` §7/§9 (Cabinet has no multiplayer; git fights concurrent
  multi-user editing unless writes are serialized — why this phase is mandatory).
- `docs/solutions/architecture-patterns/files-git-canonical-storage-with-single-writer.md`
  — the deferred per-resource concurrency note (don't repurpose repo-global `baseVersion`),
  in-mutex check (#3), file-first/no-rollback (#4), all-writes-through-one-writer incl.
  `--direct` (#7), reindexable persisted fields (#1), rename caveat (`previousSlugs`).
- Current code (mapped): `apps/server/src/index.ts` (CORS-only middleware seam ~144,
  onError 409 ~147, client-`actor` parsing, run-API gate 214–226, full route list),
  `packages/git-writer/src/index.ts` (`baseVersion` repo-HEAD check 322–329,
  `WorkspaceConflictError`, `history()`/`commitMeta()`, `toAuthor` 173–179),
  `packages/pages/src/index.ts` (`update`/`move`→`persistPageFileMode`→`writePageFile.enqueue`;
  `getWithRelations` hydration; `content_hash` internal-only),
  `packages/workspace/src/index.ts` (area model + wrappers; `assertSafeSlug`),
  `packages/db/src/index.ts` (migration 13 latest; live-only unique index convention),
  `apps/cli/src/index.ts` (`requestApi` + `--direct` write-guards + `migrationTables`),
  `apps/mcp/src/index.ts` (`requestApi` bearer precedent), `apps/web/src/App.tsx`
  (relative `fetch`, ~24 `actor:"web"` sites — a shared `apiFetch` wrapper is the first refactor).

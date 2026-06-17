---
title: Files+git canonical storage with a single serialized writer
date: 2026-06-17
category: docs/solutions/architecture-patterns
module: storage (packages/git-writer, packages/workspace, packages/pages)
problem_type: architecture_pattern
component: database
severity: high
related_components:
  - service_object
  - tooling
applies_when:
  - Storing human/agent-editable content as files in git with a database as a derived index
  - Building a markdown-first store where git history is the source of truth
  - Wiring a server/CLI that must be the single writer to a shared working tree
tags:
  - files-canonical
  - git-storage
  - derived-index
  - reindex
  - single-writer
  - isomorphic-git
  - markdown-first
  - optimistic-concurrency
---

# Files+git canonical storage with a single serialized writer

## Context

Company Brain inverted page storage from "sanitized HTML in PGlite columns" to
"Markdown files in a git repo as the source of truth, with PGlite as a
rebuildable derived index" (Phase 0+1 of the markdown-first refactor; PR #1).
The model is shared with GBrain (git brain repo synced to Postgres) and Cabinet
(markdown files + git). The pattern is simple to state — *files canonical, DB
derived* — but a Codex review surfaced four rounds of non-obvious failure modes
that any implementer of this pattern will hit. This captures them so the next
one doesn't re-derive them.

## Guidance

The invariant: **a corrupted or deleted index must be fully reconstructible from
the files alone** (`reindex`). Everything below follows from defending that
invariant.

1. **Frontmatter must round-trip every persisted field.** If the DB row has a
   field the file doesn't (parent id, pin order, permission note, creator,
   created/updated-by), a rebuild silently drops it. Put all of them in
   frontmatter; `reindex` reads them back. Treat `creator`/`created_at` as
   immutable on conflict-update.

2. **The content hash must cover frontmatter, not just the body.** An
   incremental-reindex skip keyed on the body hash will skip a metadata-only
   change (e.g. a `move` that only edits `parentPageId`), so the change never
   reaches the index. Hash `frontmatter + body`.

3. **Run the derived-index update inside the writer's serialized commit hook**,
   not after the enqueue resolves. If reindex runs after the commit, a second
   concurrent mutation can commit between commit-N and reindex-N, and reindex-N
   reads the newer file. Make the queue cover *commit + index update* as one
   serialized unit (`onCommit` hook inside the mutex).

4. **File-first ordering, and never roll back a durable commit on hook failure.**
   Commit the file, *then* derive the DB — the DB must never lead the canonical
   files. And split failure handling: a pre-commit failure rolls back the
   worktree (nothing committed); a *post-commit* hook (reindex) failure must
   leave the commit intact (git history is canonical and correct; the index is
   recoverable via `reindex`) and only surface the error. Rolling back the
   worktree against the pre-commit HEAD after a successful commit corrupts the
   tree.

5. **Two-pass reindex for self-referential FKs.** On a full rebuild a child can
   be inserted before its parent, violating a `parent_id` FK. Insert all rows
   with the FK null, then assign parents in a second pass once every row exists
   (skip dangling references rather than failing).

6. **Reindex tombstoning is correct, not data loss — for greenfield.** A DB row
   whose file is gone *should* be tombstoned (files are canonical). The only
   "data loss" scenario is reindexing an un-migrated legacy DB against an empty
   workspace; resolve that by deciding up front to **wipe, not migrate** rather
   than by weakening the tombstone.

7. **Every write path goes through the single writer — including offline/CLI.**
   A CLI `--direct` (DB-only) write while the server is down writes no file, so
   the next `reindex` tombstones it. Offline writes must construct the same
   file-backed writer; refuse `--direct` while the server is up (it owns the git
   lock).

8. **Exclusive create prevents slug-collision overwrite.** Two concurrent
   same-title creates can both allocate the same slug before either is indexed
   and both write the same file. Write new files with an exclusive flag (`wx`)
   so the loser fails inside the mutex instead of silently overwriting.

## Why This Matters

Each of these is a *silent* failure — no crash, no error — that destroys the
one guarantee that makes the architecture worth its complexity: that files are
canonical and the DB is disposable. A dropped frontmatter field or a skipped
reindex means a `reindex` (the advertised recovery command) quietly *loses* or
*staling* data. Because the symptoms only appear on rebuild, after a rename, or
under concurrency, they pass every single-threaded happy-path test and surface
in production. The fixes are cheap once known and ruinous to debug cold.

## When to Apply

- Any "files/git canonical + DB derived" store (markdown brains, doc systems).
- Whenever you add a new persisted field: ask "does this survive `reindex` from
  files alone?" before merging.
- Whenever you add a write path (new API route, CLI command, agent action):
  ask "does this go through the single writer and commit a file?"

## Examples

**isomorphic-git gotchas (the chosen pure-JS git lib):**

- No `diff` command — compute diffs from blob reads (`readBlob` at `hash` and its
  parent).
- `git.log({ filepath })` does **not** follow renames. Track prior slugs in
  frontmatter (`previousSlugs`) and union history across the current + prior
  paths so version history survives a rename.
- `git.init` creates the dir recursively (verified) — but `mkdir -p` first
  anyway; don't depend on it.
- `git.remove` on an untracked path throws — wrap in try/catch when staging a
  delete-variant that may not exist.

**Single-writer queue shape (the load-bearing piece neither prior art had):**

```
enqueue(mutation):                      // one at a time (per-workspace mutex)
  priorHead = HEAD
  try { write files; commit }           // pre-commit failure -> rollback worktree
  catch { rollbackPaths(priorHead); throw }
  if (committed && onCommit)
    await onCommit({paths, hash})        // reindex INSIDE the mutex; do NOT roll back the commit if this throws
```

**Stable identity:** pages carry a stable frontmatter `id` (not the path), so
memory citations and links survive renames/moves. WYSIWYG editing does not
require HTML storage — Tiptap round-trips to markdown via Turndown, giving clean
git diffs *and* a rich editor.

**Deferred (don't half-build it):** per-page optimistic concurrency. The
writer's `baseVersion` guard compares against *repo* HEAD (workspace-global), so
wiring it per-page naively fires false conflicts on edits to unrelated pages.
Correct per-page tokens + a merge UI are multi-user-hardening work; leave the
hook unwired and documented rather than shipping fake protection.

## Related

- `docs/refactor-markdown-first-spec.md` — the spec this implements
- `docs/cabinet-deep-dive.md` — Cabinet + GBrain prior art the model draws on
- PR #1 (`refactor: files+git-canonical markdown storage (Phase 0+1)`)

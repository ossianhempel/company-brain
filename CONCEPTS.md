# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Storage

### Page
A unit of human-editable documentation content. Its canonical form is a Markdown file with YAML frontmatter; the file — not the database — is the source of truth.

A Page has a stable id that survives renames and moves, so links and memory citations stay valid; its slug doubles as its path within the Workspace. WYSIWYG editing operates on the Page without changing its on-disk Markdown form.

### Workspace
The git repository of Markdown files that holds the canonical state of Pages (and, in later phases, agents and jobs). Git history is the audit log — every change is an attributed commit, and the state can be inspected, diffed, and reverted through git.

### Derived Index
The database projection of the Workspace, used for search, recall, and relationship queries. It is disposable and fully rebuildable from the Workspace via Reindex, and is never the source of truth for Page content.

### Reindex
The process that rebuilds the Derived Index from the Workspace files — full (every file) or incremental (only files whose content changed). A file that no longer exists becomes a tombstone (soft-delete) in the index rather than a deletion of history.

### Single Writer
The server-owned, serialized write path that is the only actor permitted to write and commit the Workspace working tree. It serializes each mutation together with its index update, so concurrent edits cannot interleave or leave the Derived Index ahead of the canonical files.

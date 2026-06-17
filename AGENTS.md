# Agents Working On Company Brain

Read VISION.md to understand what we're trying to build and where we're headed.

## Planning Memory

The living project plan and scratchpad lives in Obsidian:

```txt
/Users/ossianhempel/ossians-second-brain-sync/1. Projects/Company Brain/Company Brain Plan.md
```

Before making architecture, product, or roadmap decisions, read that note. When the plan changes, update the note in the same pass.

Use the Obsidian CLI when possible:

```bash
obsidian read path="1. Projects/Company Brain/Company Brain Plan.md"
obsidian append path="1. Projects/Company Brain/Company Brain Plan.md" content="..."
```

## Current Direction

> **2026-06-16 pivot:** Markdown-first, files+git canonical. See `docs/refactor-markdown-first-spec.md`, `docs/cabinet-deep-dive.md`, and the MAJOR PIVOT banner in the Obsidian plan. This section reflects the post-pivot direction.

Company Brain is an open-source, self-hostable, AI-native company knowledge system:

- **Markdown-first pages** (Markdown + YAML frontmatter with a stable `id`) as the human workspace layer. Tiptap WYSIWYG stays — it round-trips to markdown via Turndown (WYSIWYG ≠ HTML storage).
- **Files on disk + git are the canonical source of truth.** Git lineage (attributed, reconstructible commits by humans and agents) is a first-class feature.
- A **derived database (PGlite)** rebuilt from the workspace, holding the search/recall index + non-page memory primitives + operational/identity state.
- First-class non-page memory primitives: source artifacts, conversations, extracted memories, entities, events, profiles, and citations.
- Web UI for docs, search, sharing, comments, and administration (DATA / TEAM / TASKS nav, ported from Cabinet).
- Agent runtime ported from Cabinet patterns: `persona.md` agents, `.jobs` YAML + node-cron, provider adapters + CLI auto-detection.
- Multi-user from the start: SSO/RBAC, comments, suggest-changes. The Hono server is the **single writer to the git working tree** (serialized commits).
- GBrain-inspired storage/retrieval (git brain repo synced to Postgres/pgvector; hybrid = vector + BM25 + Reciprocal Rank Fusion), Supermemory-inspired memory layer, agent-operable install flow.
- MCP as a first-class interface.
- Monolithic, container-friendly default deployment.
- Optional Postgres, object storage, external search, and vector services for scale.

## Defaults To Preserve

- Prefer one-container / one-volume operation for the baseline install.
- Do not introduce required hosted services for core functionality without updating the Obsidian plan and explaining the tradeoff.
- Keep the repo oriented around self-hosting, inspectable data, backups, and portability.
- Treat external services as optional upgrades unless the plan explicitly changes.
- Do not reduce memory to vector search. Use hybrid retrieval: full-text/BM25, vectors, graph/entity links, structured filters, profiles, reranking, and source citations.
- Do not force every memory into a page. Pages are the docs UX; memories and source artifacts need their own storage and lifecycle.
- Keep future agents aligned by updating this file only for stable operating guidance, and the Obsidian note for evolving planning details.
- **Files on disk + git are canonical; the database is a derived, rebuildable index.** Never make the DB the source of truth for human-editable content. A corrupted index must be recoverable via `reindex` from the workspace alone.
- **All writes to the git working tree go through the server's single-writer queue** (serialized commits, permission-checked, attributed). No direct file writes from UI, CLI `--direct`, or MCP that bypass it.
- Preserve a stable frontmatter `id` on pages so renames/moves don't break memory citations or share links.

## Repo Skills

The repo vendors implementation skills under `.agents/skills/`:

- `.agents/skills/create-cli`: use before changing CLI command structure, output contracts, flags, help text, or destructive command behavior.
- `.agents/skills/mcp-builder`: use before building or changing MCP servers/tools/resources/prompts.
- `.agents/skills/ce-agent-native-architecture`: use before designing or refactoring agent-native architecture, action parity, context injection, shared workspaces, prompt-native features, or agent-operable product flows.
- `.agents/skills/ce-agent-native-audit`: use when reviewing the codebase against agent-native architecture principles or scoring gaps across parity, primitive tools, context injection, shared workspace behavior, CRUD completeness, UI integration, capability discovery, and prompt-native features.

Every web UI action should map to a backend action that can also be exposed through CLI and MCP.

# Agents Working On Company Brain

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

Company Brain is an open-source, self-hostable, AI-native company knowledge system:

- HTML-first documentation/pages as the human workspace UX layer.
- First-class non-page memory primitives: source artifacts, conversations, extracted memories, entities, events, profiles, and citations.
- Web UI for docs, search, sharing, comments, and administration.
- Supermemory-inspired memory/context layer, GBrain-inspired retrieval/portability, and an agent-operable install flow.
- MCP as a first-class interface.
- Monolithic, container-friendly default deployment.
- PGlite and local files by default.
- Optional Postgres, object storage, external search, and vector services for scale.
- Future Git-compatible HTML export/mirror for portability and agent-readable sharing.

## Defaults To Preserve

- Prefer one-container / one-volume operation for the baseline install.
- Do not introduce required hosted services for core functionality without updating the Obsidian plan and explaining the tradeoff.
- Keep the repo oriented around self-hosting, inspectable data, backups, and portability.
- Treat external services as optional upgrades unless the plan explicitly changes.
- Do not reduce memory to vector search. Use hybrid retrieval: full-text/BM25, vectors, graph/entity links, structured filters, profiles, reranking, and source citations.
- Do not force every memory into an HTML page. Pages are the docs UX; memories and source artifacts need their own storage and lifecycle.
- Keep future agents aligned by updating this file only for stable operating guidance, and the Obsidian note for evolving planning details.
- Keep PGlite/Postgres as the operational source of truth for now, but preserve stable page slugs/paths and HTML export boundaries so a Git-backed brain mirror can be added later.

## Repo Skills

The repo vendors implementation skills under `.agents/skills/`:

- `.agents/skills/create-cli`: use before changing CLI command structure, output contracts, flags, help text, or destructive command behavior.
- `.agents/skills/mcp-builder`: use before building or changing MCP servers/tools/resources/prompts.

Every web UI action should map to a backend action that can also be exposed through CLI and MCP.

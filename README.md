# Company Brain

Open-source, self-hostable, AI-native company knowledge system.

The current architecture target is a single deployable app with:

- HTML-first pages for the human docs/workspace UX
- First-class memory objects for conversations, source artifacts, extracted facts, entities, events, and profiles
- React/Vite web UI
- Hono API server
- PGlite embedded Postgres database
- Local files by default
- MCP-first agent interface
- Hybrid retrieval: full-text/BM25, vector candidates, graph/entity links, structured filters, profiles, reranking, and source citations

## Development

```bash
pnpm install
pnpm dev
```

The web app runs on `http://localhost:5173` and proxies API calls to the server on `http://localhost:3000`.

For agent-operated setup, see [INSTALL_FOR_AGENTS.md](./INSTALL_FOR_AGENTS.md).

## CLI And MCP

Run page actions from the CLI:

```bash
pnpm cb doctor
pnpm cb migrate to postgres --database-url <postgres-url>
pnpm cb migrate to supabase --database-url <supabase-postgres-url>
pnpm cb workspace init
pnpm cb projects create "Client Project"
pnpm cb import files ./notes-or-export
pnpm cb pages list
pnpm cb pages get home
pnpm cb memory recall "client preferences"
pnpm cb memory recall "client preferences" --mode lexical_v1
pnpm cb memory ingest --title "Support Thread" --text-file ./thread.txt --source-type chat
pnpm cb memory save --kind preference --subject "Acme" --content "Acme prefers weekly status updates." --source-artifact <artifact-id> --quote "Please send us a weekly update."
```

`import files` stores supported local files (`.md`, `.markdown`, `.html`, `.htm`, `.txt`) as source artifacts with `mode: source_artifact_v1`. It does not silently convert them into pages. Use this for raw notes, exports, meeting notes, and agent-collected context that should become searchable memory input.

`memory save` accepts one source pointer at a time: `--source-artifact`, `--source-chunk`, `--source-page`, or `--source-page-chunk`.
Use `--quote` without a source pointer for a manual citation.

Recall defaults to `bm25_local_v1`, a local no-API keyword ranking mode over memories, page chunks, and source artifact chunks. It is not vector or hybrid retrieval yet. `lexical_v1` remains available for comparison.

## Memory Creation Model

Memory creation is not meant to be a purely silent agent habit. The intended paths are:

- Explicit user instruction: "remember this", "save this as a decision", or "add this to Company Brain".
- Workflow checkpoints: after tasks, meetings, project discoveries, durable decisions, corrected assumptions, or client preference discoveries.
- Candidate review: the agent proposes source-grounded memories for user approval when the content is sensitive, ambiguous, or interpretive.

Company Brain should own memory schema, citations, lifecycle, recall modes, and future candidate-memory inboxes. Agents should own workflow timing and call the Brain through MCP/API at the right checkpoints.

Run the local stdio MCP server:

```bash
pnpm mcp
```

The MCP server expects the Company Brain API to be running at `http://localhost:3000`.
Override with `COMPANY_BRAIN_API_URL` if needed.

For personal use, PGlite is the default local runtime. For shared team/company use, migrate to any Postgres-compatible database:

```bash
pnpm cb migrate to postgres --database-url "$DATABASE_URL"
pnpm cb migrate to supabase --database-url "$SUPABASE_POSTGRES_URL"
```

The Supabase target is just a Postgres connection string. The migration refuses to run while the local API is reachable unless `--allow-running-api` is passed, because PGlite migration should normally be an offline copy.

Useful MCP tools in the current slice:

- `company_brain_init_workspace`
- `company_brain_create_project`
- `company_brain_list_pages`
- `company_brain_get_page`
- `company_brain_search_pages`
- `company_brain_recall`
- `company_brain_ingest_source_artifact`
- `company_brain_forget_source_artifact`
- `company_brain_save_memory`
- `company_brain_forget_memory`

## First Slice

The scaffold includes a minimal page API:

- `GET /health`
- `GET /api/pages`
- `GET /api/pages/:id`
- `POST /api/pages`
- `PUT /api/pages/:id`

Pages are stored as sanitized HTML-oriented records in PGlite under `./data/pgdata`.

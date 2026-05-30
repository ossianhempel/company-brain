# Install Company Brain For Agents

This repo is designed to be installed and operated by a coding agent.

## Prerequisites

- Node 20+
- pnpm
- A local checkout of this repository

## Start The App

```bash
pnpm install
pnpm dev
```

Expected local services:

```txt
Web UI: http://localhost:5173
API:    http://localhost:3000
```

Verify:

```bash
pnpm cb doctor
```

## Initialize The Workspace

```bash
pnpm cb workspace init
```

This creates or repairs:

```txt
Home
Projects
Areas
Resources
Archive
```

Create a project template:

```bash
pnpm cb projects create "Client Project"
```

## Connect Claude Code Over MCP

Keep the API running, then add the stdio MCP server:

```bash
claude mcp add company-brain -- pnpm --dir /Users/ossianhempel/Developer/company-brain mcp
```

The MCP server expects the API at `http://localhost:3000`.
Override it if needed:

```bash
COMPANY_BRAIN_API_URL=http://localhost:3000 pnpm mcp
```

## Useful MCP Tools

```txt
company_brain_doctor
company_brain_init_workspace
company_brain_create_project
company_brain_list_pages
company_brain_get_page
company_brain_search_pages
company_brain_recall
company_brain_ingest_source_artifact
company_brain_forget_source_artifact
company_brain_save_memory
company_brain_forget_memory
```

## Dogfooding Workflow

For early personal use, prefer agent-mediated ingestion:

```txt
Claude Code <-> Microsoft 365 / Azure DevOps / local files
Claude Code <-> Company Brain MCP
```

For local files or exports, import them as source artifacts first:

```bash
pnpm cb import files ./notes-or-export
```

This command reports `mode: source_artifact_v1`. It indexes supported `.md`, `.markdown`, `.html`, `.htm`, and `.txt` files as source artifacts with file path metadata. Do not tell the user this created pages; promote or rewrite important material into pages separately.

The agent should only persist useful durable context. Use:

- `company_brain_ingest_source_artifact` for raw notes, chat excerpts, meeting notes, connector text, or project context.
- `company_brain_save_memory` for durable facts, decisions, preferences, status, and contradictions.
- `company_brain_recall` before answering project questions or starting work.
- `company_brain_create_project` when a new client/project begins.

## Memory Creation Paths

Company Brain retrieval can be automatic, but memory writes should be deliberate and source-grounded.

Use three creation paths:

- Explicit user instruction: save when the user says "remember this", "save this as a decision", or "add this to Company Brain".
- Workflow checkpoint: after completing a task, reading durable project context, summarizing a meeting, making an architecture decision, discovering a recurring client preference, or correcting an old assumption.
- Candidate memory review: propose likely memories with source quotes and wait for approval when the information is sensitive, ambiguous, noisy, or interpretive.

Default policy:

- Save raw source artifacts only when asked or when the workflow explicitly calls for capture.
- Save explicit memories only when durable, useful later, source-grounded, and not secret.
- Ask before saving sensitive client/personal details or uncertain interpretations.
- Never save secrets, API keys, transient chatter, or unverified guesses.

Boundary:

- Company Brain owns the memory schema, citations, lifecycle, recall modes, future candidate-memory inbox, and MCP/API tools.
- Agents own the workflow timing: before-task recall, after-task summary, post-meeting capture, project-closeout capture, and similar checkpoints.
- Future Company Brain should expose policy/config so agents do not invent their own memory rules.

Current default retrieval mode is explicitly `bm25_local_v1`. This is local keyword ranking over memories, page chunks, and source chunks. It is not vector search or hybrid retrieval. The older `lexical_v1` mode is still available for comparison.

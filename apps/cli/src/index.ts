#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createDb, type CompanyBrainDb } from "@company-brain/db";
import { createGitWriter } from "@company-brain/git-writer";
import {
  createMemoryStore,
  type MemoryKind,
  type MemorySource,
  type RecallResponse,
  type RecallSearchMode
} from "@company-brain/memory";
import {
  createPageStore,
  reindexAllPages,
  type Page,
  type PageSearchResult,
  type PageVersion,
  type PageWithRelations
} from "@company-brain/pages";
import { createWorkspace, resolveWorkspaceDir } from "@company-brain/workspace";

type Flags = Record<string, string | boolean>;

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") {
  cliArgs.shift();
}

const [command, subcommand, ...rest] = cliArgs;
const defaultApiUrl = process.env.COMPANY_BRAIN_API_URL ?? "http://localhost:3000";
const memoryKinds = new Set(["fact", "decision", "preference", "status", "contradiction"]);
const importExtensions = new Set([".html", ".htm", ".md", ".markdown", ".txt"]);
const migrationTables = [
  "pages",
  "page_links",
  "page_versions",
  "page_chunks",
  "page_comments",
  "page_share_links",
  "page_activity",
  "source_artifacts",
  "source_chunks",
  "page_source_artifacts",
  "memories",
  "memory_sources"
];

function parseFlags(args: string[]) {
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return { flags, positionals };
}

function flagString(flags: Flags, name: string) {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function memorySourcesFromFlags(flags: Flags): Array<Omit<MemorySource, "id" | "memoryId">> {
  const sourceFlags = [
    ["source-artifact", "artifact"],
    ["source-chunk", "source_chunk"],
    ["source-page", "page"],
    ["source-page-chunk", "page_chunk"]
  ] as const;
  const provided = sourceFlags.filter(([name]) => flagString(flags, name));
  if (provided.length > 1) {
    throw new Error(
      "memory save accepts one source flag at a time: --source-artifact, --source-chunk, --source-page, or --source-page-chunk"
    );
  }

  const quote = flagString(flags, "quote") ?? null;
  if (provided.length === 0) {
    return quote ? [{ sourceType: "manual", pageId: null, pageChunkId: null, artifactId: null, sourceChunkId: null, quote }] : [];
  }

  const [name, sourceType] = provided[0];
  const id = flagString(flags, name);
  if (!id) {
    return [];
  }

  return [
    {
      sourceType,
      pageId: sourceType === "page" ? id : null,
      pageChunkId: sourceType === "page_chunk" ? id : null,
      artifactId: sourceType === "artifact" ? id : null,
      sourceChunkId: sourceType === "source_chunk" ? id : null,
      quote
    }
  ];
}

async function htmlFromFlags(flags: Flags) {
  const html = flagString(flags, "html");
  if (html) {
    return html;
  }

  const htmlFile = flagString(flags, "html-file");
  if (htmlFile) {
    return readFile(htmlFile, "utf8");
  }

  return undefined;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPageList(pages: Page[]) {
  for (const page of pages) {
    process.stdout.write(`${page.id}\t/${page.slug}\t${page.title}\n`);
  }
}

function printSearchResults(results: PageSearchResult[]) {
  for (const result of results) {
    process.stdout.write(
      `${result.score}\t/${result.slug}\t${result.title}\t${result.matchReason}\t${result.snippet}\n`
    );
  }
}

function printPageVersions(versions: PageVersion[]) {
  for (const version of versions) {
    process.stdout.write(
      `${version.id}\t${version.createdAt}\t${version.createdBy}\t/${version.slug}\t${version.title}\n`
    );
  }
}

async function collectImportFiles(inputPath: string, recursive: boolean): Promise<string[]> {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return importExtensions.has(path.extname(inputPath).toLowerCase()) ? [inputPath] : [];
  }

  if (!info.isDirectory()) {
    return [];
  }

  const entries = await readdir(inputPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...(await collectImportFiles(entryPath, recursive)));
      }
      continue;
    }

    if (entry.isFile() && importExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function sourceTypeForFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "file:markdown";
  }
  if (extension === ".html" || extension === ".htm") {
    return "file:html";
  }
  return "file:text";
}

async function ingestArtifact(input: {
  sourceType: string;
  title: string;
  rawText: string;
  metadata?: Record<string, unknown>;
  actor: string;
  useApi: boolean;
}) {
  if (input.useApi) {
    return (
      await requestApi<{ artifact: unknown }>("/api/source-artifacts", {
        method: "POST",
        body: JSON.stringify({
          sourceType: input.sourceType,
          title: input.title,
          rawText: input.rawText,
          metadata: input.metadata,
          actor: input.actor
        })
      })
    ).artifact;
  }

  return (await createMemoryStore()).ingestArtifact({
    sourceType: input.sourceType,
    title: input.title,
    rawText: input.rawText,
    metadata: input.metadata,
    actor: input.actor
  });
}

/**
 * Direct-mode page store with the file-backed writer wired in, so offline
 * `--direct` writes commit markdown to data/workspace (not DB-only, which the
 * next reindex would tombstone).
 */
async function directPageStore() {
  const workspaceDir = resolveWorkspaceDir();
  return createPageStore(await createDb(), {
    gitWriter: createGitWriter({ workspaceDir }),
    workspace: createWorkspace({ workspaceDir }),
  });
}

async function resolvePage(ref: string) {
  const pages = await createPageStore();
  const byId = await pages.get(ref);
  if (byId) {
    return { pages, page: byId };
  }

  const slug = ref.startsWith("/") ? ref.slice(1) : ref;
  const bySlug = await pages.getBySlug(slug);
  return { pages, page: bySlug };
}

async function requestApi<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${defaultApiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function canUseApi() {
  try {
    const response = await fetch(`${defaultApiUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function listPages(useApi: boolean) {
  if (useApi) {
    return (await requestApi<{ pages: Page[] }>("/api/pages")).pages;
  }

  return (await createPageStore()).list();
}

async function searchPages(query: string, limit: number, useApi: boolean) {
  if (useApi) {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return (await requestApi<{ results: PageSearchResult[] }>(`/api/search/pages?${params}`)).results;
  }

  return (await createPageStore()).search(query, limit);
}

function recallModeFromFlags(flags: Flags): RecallSearchMode | undefined {
  const mode = flagString(flags, "mode");
  if (!mode) {
    return undefined;
  }
  if (mode !== "bm25_local_v1" && mode !== "lexical_v1") {
    throw new Error("memory recall --mode must be bm25_local_v1 or lexical_v1");
  }
  return mode;
}

async function recall(query: string, limit: number, useApi: boolean, mode?: RecallSearchMode) {
  if (useApi) {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (mode) {
      params.set("mode", mode);
    }
    return requestApi<RecallResponse>(`/api/recall?${params}`);
  }

  return (await createMemoryStore()).recall(query, limit, mode);
}

async function getPage(ref: string, useApi: boolean) {
  if (!useApi) {
    const result = await resolvePage(ref);
    if (!result.page) {
      return null;
    }

    return result.pages.getWithRelations(result.page.id);
  }

  const pages = await listPages(true);
  const slug = ref.startsWith("/") ? ref.slice(1) : ref;
  const page = pages.find((candidate) => candidate.id === ref || candidate.slug === slug);
  if (!page) {
    return null;
  }

  return (await requestApi<{ page: PageWithRelations }>(`/api/pages/${page.id}`)).page;
}

async function listPageVersions(ref: string, useApi: boolean) {
  const current = await getPage(ref, useApi);
  if (!current) {
    return null;
  }

  if (useApi) {
    return {
      page: current,
      versions: (await requestApi<{ versions: PageVersion[] }>(`/api/pages/${current.id}/versions`)).versions
    };
  }

  const store = await createPageStore();
  return {
    page: current,
    versions: (await store.listVersions(current.id)) ?? []
  };
}

async function getPageVersion(ref: string, versionId: string, useApi: boolean) {
  const current = await getPage(ref, useApi);
  if (!current) {
    return null;
  }

  if (useApi) {
    return {
      page: current,
      version: (await requestApi<{ version: PageVersion }>(`/api/pages/${current.id}/versions/${versionId}`)).version
    };
  }

  const store = await createPageStore();
  const version = await store.getVersion(current.id, versionId);
  return version ? { page: current, version } : null;
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const { flags } = parseFlags([subcommand, ...rest].filter(Boolean));
    const useApi = !flags.direct && (await canUseApi());

    // Inspect the local workspace git repo + file count (files are canonical).
    const workspaceDir = resolveWorkspaceDir();
    let workspaceCheck = "missing";
    let uncommitted = 0;
    let fileCount = 0;
    if (existsSync(path.join(workspaceDir, ".git"))) {
      try {
        const status = await createGitWriter({ workspaceDir }).status();
        workspaceCheck = status.clean ? "clean" : "dirty";
        uncommitted = status.changed.length;
        fileCount = (await createWorkspace({ workspaceDir }).listPageSlugs()).length;
      } catch {
        workspaceCheck = "error";
      }
    }

    if (!useApi && !flags.direct) {
      printJson({
        ok: false,
        checks: {
          api: "not-running",
          database: "not-checked",
          homePage: "not-checked",
          pageCount: 0,
          workspace: workspaceCheck,
          uncommitted
        }
      });
      return;
    }

    const allPages = await listPages(useApi);
    const home = allPages.find((page) => page.slug === "home");
    printJson({
      ok: Boolean(home),
      checks: {
        api: useApi ? "ok" : "not-running",
        database: useApi ? "via-api" : "ok",
        homePage: home ? "ok" : "missing",
        pageCount: allPages.length,
        workspace: workspaceCheck,
        uncommitted,
        // index is fresh when the live page count matches the file count
        indexFresh: workspaceCheck === "missing" ? "n/a" : allPages.length === fileCount
      }
    });
    return;
  }

  if (command === "workspace") {
    await handleWorkspaceCommand(subcommand, rest);
    return;
  }

  if (command === "projects") {
    await handleProjectsCommand(subcommand, rest);
    return;
  }

  if (command === "migrate") {
    await handleMigrateCommand(subcommand, rest);
    return;
  }

  if (command === "reindex") {
    const { flags } = parseFlags([subcommand, ...rest].filter(Boolean));
    const useApi = !flags.direct && (await canUseApi());
    if (useApi) {
      await requestApi("/api/admin/reindex", { method: "POST" });
      printJson({ ok: true, mode: "api" });
      return;
    }
    if (flags.direct && (await canUseApi())) {
      throw new Error(
        "Refusing --direct reindex: the server is running and owns the workspace. Omit --direct to use the API, or stop the server first."
      );
    }
    const db = await createDb();
    const workspace = createWorkspace({ workspaceDir: resolveWorkspaceDir() });
    await reindexAllPages(db, workspace);
    await db.close();
    printJson({ ok: true, mode: "direct" });
    return;
  }

  if (command === "import") {
    await handleImportCommand(subcommand, rest);
    return;
  }

  if (command !== "pages") {
    if (command === "memory") {
      await handleMemoryCommand(subcommand, rest);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  }

  const { flags, positionals } = parseFlags(rest);
  const json = Boolean(flags.json);
  const useApi = !flags.direct && (await canUseApi());
  if (!useApi && !flags.direct) {
    throw new Error("Company Brain API is not reachable. Start `pnpm dev` or pass --direct for local PGlite access.");
  }

  // Files+git are canonical and the server is the single writer. A --direct
  // write while the server is up would race the workspace git lock, so demote.
  const writeSubcommands = new Set(["create", "update", "duplicate", "move", "delete", "restore"]);
  if (flags.direct && writeSubcommands.has(subcommand ?? "") && (await canUseApi())) {
    throw new Error(
      "Refusing --direct write: the server is running and owns the workspace. Omit --direct to use the API, or stop the server first."
    );
  }

  if (subcommand === "list") {
    const allPages = await listPages(useApi);
    if (json) {
      printJson({ pages: allPages });
    } else {
      printPageList(allPages);
    }
    return;
  }

  if (subcommand === "search") {
    const query = positionals.join(" ").trim();
    if (!query) {
      throw new Error("pages search requires a query");
    }

    const limit = Number(flagString(flags, "limit") ?? 20);
    const results = await searchPages(query, limit, useApi);
    if (json) {
      printJson({ results });
    } else {
      printSearchResults(results);
    }
    return;
  }

  if (subcommand === "get") {
    const ref = positionals[0];
    if (!ref) {
      throw new Error("pages get requires <id-or-slug>");
    }

    const page = await getPage(ref, useApi);
    if (!page) {
      throw new Error(`Page not found: ${ref}`);
    }

    printJson({ page });
    return;
  }

  if (subcommand === "versions") {
    const ref = positionals[0];
    if (!ref) {
      throw new Error("pages versions requires <id-or-slug>");
    }

    const result = await listPageVersions(ref, useApi);
    if (!result) {
      throw new Error(`Page not found: ${ref}`);
    }

    if (json) {
      printJson(result);
    } else {
      printPageVersions(result.versions);
    }
    return;
  }

  if (subcommand === "version") {
    const [ref, versionId] = positionals;
    if (!ref || !versionId) {
      throw new Error("pages version requires <id-or-slug> <version-id>");
    }

    const result = await getPageVersion(ref, versionId, useApi);
    if (!result) {
      throw new Error(`Page version not found: ${ref} ${versionId}`);
    }

    printJson(result);
    return;
  }

  if (subcommand === "create") {
    const title = flagString(flags, "title");
    const html = await htmlFromFlags(flags);
    if (!title || !html) {
      throw new Error("pages create requires --title and --html or --html-file");
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const page = useApi
      ? (await requestApi<{ page: Page }>("/api/pages", {
          method: "POST",
          body: JSON.stringify({ title, html, actor })
        })).page
      : await (await directPageStore()).create({ title, html, actor });
    printJson({ page });
    return;
  }

  if (subcommand === "update") {
    const ref = positionals[0];
    if (!ref) {
      throw new Error("pages update requires <id-or-slug>");
    }

    const current = await getPage(ref, useApi);
    if (!current) {
      throw new Error(`Page not found: ${ref}`);
    }

    const body = {
      title: flagString(flags, "title"),
      html: await htmlFromFlags(flags),
      actor: flagString(flags, "actor") ?? "cli"
    };
    const page = useApi
      ? (await requestApi<{ page: Page }>(`/api/pages/${current.id}`, {
          method: "PUT",
          body: JSON.stringify(body)
        })).page
      : await (await directPageStore()).update(current.id, body);
    printJson({ page });
    return;
  }

  if (subcommand === "duplicate") {
    const ref = positionals[0];
    if (!ref) {
      throw new Error("pages duplicate requires <id-or-slug>");
    }

    const current = await getPage(ref, useApi);
    if (!current) {
      throw new Error(`Page not found: ${ref}`);
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const page = useApi
      ? (await requestApi<{ page: Page }>(`/api/pages/${current.id}/duplicate`, {
          method: "POST",
          body: JSON.stringify({ actor })
        })).page
      : await (await directPageStore()).duplicate(current.id, actor);
    printJson({ page });
    return;
  }

  if (subcommand === "move") {
    const [ref, parentRef] = positionals;
    if (!ref) {
      throw new Error("pages move requires <id-or-slug> [parent-id-or-slug|top]");
    }

    const current = await getPage(ref, useApi);
    if (!current) {
      throw new Error(`Page not found: ${ref}`);
    }

    let parentPageId: string | null = null;
    if (parentRef && parentRef !== "top") {
      const parent = await getPage(parentRef, useApi);
      if (!parent) {
        throw new Error(`Parent page not found: ${parentRef}`);
      }
      parentPageId = parent.id;
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const page = useApi
      ? (await requestApi<{ page: Page }>(`/api/pages/${current.id}/move`, {
          method: "POST",
          body: JSON.stringify({ parentPageId, actor })
        })).page
      : await (await directPageStore()).move(current.id, { parentPageId, actor });
    printJson({ page });
    return;
  }

  if (subcommand === "delete") {
    const ref = positionals[0];
    if (!ref) {
      throw new Error("pages delete requires <id-or-slug>");
    }

    const current = await getPage(ref, useApi);
    if (!current) {
      throw new Error(`Page not found: ${ref}`);
    }

    const page = useApi
      ? (await requestApi<{ page: Page }>(`/api/pages/${current.id}`, {
          method: "DELETE",
          body: JSON.stringify({ actor: flagString(flags, "actor") ?? "cli" })
        })).page
      : await (await directPageStore()).softDelete(current.id, flagString(flags, "actor") ?? "cli");
    printJson({ page });
    return;
  }

  if (subcommand === "restore") {
    const [ref, versionId] = positionals;
    if (!ref || !versionId) {
      throw new Error("pages restore requires <id-or-slug> <version-id>");
    }

    const current = await getPage(ref, useApi);
    if (!current) {
      throw new Error(`Page not found: ${ref}`);
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const page = useApi
      ? (await requestApi<{ page: Page }>(`/api/pages/${current.id}/versions/${versionId}/restore`, {
          method: "POST",
          body: JSON.stringify({ actor })
        })).page
      : await (await directPageStore()).restoreVersion(current.id, versionId, actor);
    if (!page) {
      throw new Error(`Page version not found: ${ref} ${versionId}`);
    }

    printJson({ page });
    return;
  }

  throw new Error(`Unknown pages command: ${subcommand ?? ""}`);
}

async function tableCount(db: CompanyBrainDb, table: string) {
  const result = await db.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function copyTable(source: CompanyBrainDb, target: CompanyBrainDb, table: string) {
  const rows = (await source.query<Record<string, unknown>>(`select * from ${table}`)).rows;
  for (const row of rows) {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    await target.query(
      `
        insert into ${table} (${columns.join(", ")})
        values (${placeholders})
        on conflict do nothing
      `,
      columns.map((column) => row[column])
    );
  }

  return rows.length;
}

async function handleMigrateCommand(subcommand: string | undefined, rest: string[]) {
  const { flags, positionals } = parseFlags(rest);
  const target = positionals[0];
  if (subcommand !== "to" || (target !== "postgres" && target !== "supabase")) {
    throw new Error("migrate requires: pnpm cb migrate to postgres --database-url <postgres-url>");
  }

  const databaseUrl = flagString(flags, "database-url") ?? process.env.COMPANY_BRAIN_TARGET_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("migrate to requires --database-url or COMPANY_BRAIN_TARGET_DATABASE_URL");
  }

  if (!flags["allow-running-api"] && (await canUseApi())) {
    throw new Error(
      "Refusing offline migration while the Company Brain API is running. Stop the server first, or pass --allow-running-api if you know no writes are happening."
    );
  }

  const source = await createDb({ dataDir: process.env.COMPANY_BRAIN_DATA_DIR });
  const destination = await createDb({ databaseUrl });
  try {
    const nonEmpty = (
      await Promise.all(migrationTables.map(async (table) => [table, await tableCount(destination, table)] as const))
    ).filter(([, count]) => count > 0);
    if (nonEmpty.length > 0 && !flags["allow-non-empty"]) {
      throw new Error(
        `Target Postgres is not empty (${nonEmpty.map(([table, count]) => `${table}:${count}`).join(", ")}). Pass --allow-non-empty to merge with on-conflict-do-nothing.`
      );
    }

    const copied: Record<string, number> = {};
    for (const table of migrationTables) {
      copied[table] = await copyTable(source, destination, table);
    }

    const targetCounts = Object.fromEntries(
      await Promise.all(migrationTables.map(async (table) => [table, await tableCount(destination, table)] as const))
    );
    printJson({
      ok: true,
      target,
      copied,
      targetCounts,
      next: "Set COMPANY_BRAIN_DATABASE_URL or DATABASE_URL to this Postgres URL and run pnpm cb doctor."
    });
  } finally {
    await source.close();
    await destination.close();
  }
}

async function handleWorkspaceCommand(subcommand: string | undefined, rest: string[]) {
  const { flags } = parseFlags(rest);
  const useApi = !flags.direct && (await canUseApi());
  if (!useApi && !flags.direct) {
    throw new Error("Company Brain API is not reachable. Start `pnpm dev` or pass --direct for local PGlite access.");
  }

  if (subcommand === "init") {
    const actor = flagString(flags, "actor") ?? "cli";
    const pages = useApi
      ? (await requestApi<{ pages: Page[] }>("/api/workspace/init", {
          method: "POST",
          body: JSON.stringify({ actor })
        })).pages
      : await (await createPageStore()).ensureParaWorkspace(actor);
    printJson({ pages });
    return;
  }

  throw new Error(`Unknown workspace command: ${subcommand ?? ""}`);
}

async function handleProjectsCommand(subcommand: string | undefined, rest: string[]) {
  const { flags, positionals } = parseFlags(rest);
  const useApi = !flags.direct && (await canUseApi());
  if (!useApi && !flags.direct) {
    throw new Error("Company Brain API is not reachable. Start `pnpm dev` or pass --direct for local PGlite access.");
  }

  if (subcommand === "create") {
    const projectName = positionals.join(" ").trim();
    if (!projectName) {
      throw new Error("projects create requires <project-name>");
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const pages = useApi
      ? (await requestApi<{ pages: Page[] }>("/api/projects", {
          method: "POST",
          body: JSON.stringify({ name: projectName, actor })
        })).pages
      : await (await createPageStore()).createProject(projectName, actor);
    printJson({ pages });
    return;
  }

  throw new Error(`Unknown projects command: ${subcommand ?? ""}`);
}

async function handleImportCommand(subcommand: string | undefined, rest: string[]) {
  if (subcommand && subcommand !== "files") {
    throw new Error(`Unknown import command: ${subcommand}`);
  }

  const importArgs = subcommand === "files" ? rest : subcommand ? [subcommand, ...rest] : rest;
  const { flags, positionals } = parseFlags(importArgs);
  const useApi = !flags.direct && (await canUseApi());
  if (!useApi && !flags.direct) {
    throw new Error("Company Brain API is not reachable. Start `pnpm dev` or pass --direct for local PGlite access.");
  }

  const inputPath = positionals[0];
  if (!inputPath) {
    throw new Error("import files requires <file-or-directory>");
  }

  const actor = flagString(flags, "actor") ?? "cli-import";
  const recursive = !flags["no-recursive"];
  const rootPath = path.resolve(inputPath);
  const files = await collectImportFiles(rootPath, recursive);
  if (files.length === 0) {
    printJson({
      imported: [],
      skipped: "No supported files found. Supported extensions: .md, .markdown, .html, .htm, .txt"
    });
    return;
  }
  if (flagString(flags, "title") && files.length > 1) {
    throw new Error("import files --title can only be used when importing one file");
  }

  const imported: unknown[] = [];
  for (const filePath of files) {
    const rawText = await readFile(filePath, "utf8");
    if (!rawText.trim()) {
      continue;
    }

    const relativePath = path.relative(rootPath, filePath) || path.basename(filePath);
    const title = flagString(flags, "title") ?? relativePath;
    const artifact = await ingestArtifact({
      sourceType: flagString(flags, "source-type") ?? sourceTypeForFile(filePath),
      title,
      rawText,
      metadata: {
        importMode: "source_artifact_v1",
        path: filePath,
        relativePath
      },
      actor,
      useApi
    });
    imported.push(artifact);
  }

  printJson({
    mode: "source_artifact_v1",
    count: imported.length,
    imported
  });
}

async function handleMemoryCommand(subcommand: string | undefined, rest: string[]) {
  const { flags, positionals } = parseFlags(rest);
  const json = Boolean(flags.json);
  const useApi = !flags.direct && (await canUseApi());
  if (!useApi && !flags.direct) {
    throw new Error("Company Brain API is not reachable. Start `pnpm dev` or pass --direct for local PGlite access.");
  }

  if (subcommand === "ingest") {
    const sourceType = flagString(flags, "source-type") ?? "manual";
    const title = flagString(flags, "title");
    const textFile = flagString(flags, "text-file");
    const rawText = flagString(flags, "text") ?? (textFile ? await readFile(textFile, "utf8") : undefined);
    if (!title || !rawText) {
      throw new Error("memory ingest requires --title and --text or --text-file");
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const artifact = await ingestArtifact({ sourceType, title, rawText, actor, useApi });
    printJson({ artifact });
    return;
  }

  if (subcommand === "save") {
    const kind = flagString(flags, "kind");
    const content = flagString(flags, "content");
    if (!kind || !content) {
      throw new Error("memory save requires --kind and --content");
    }
    if (!memoryKinds.has(kind)) {
      throw new Error("memory save --kind must be fact, decision, preference, status, or contradiction");
    }

    const body: {
      kind: MemoryKind;
      content: string;
      subject?: string;
      confidence?: number;
      actor: string;
      sources: Array<Omit<MemorySource, "id" | "memoryId">>;
    } = {
      kind: kind as MemoryKind,
      content,
      subject: flagString(flags, "subject"),
      confidence: flagString(flags, "confidence") ? Number(flagString(flags, "confidence")) : undefined,
      actor: flagString(flags, "actor") ?? "cli",
      sources: memorySourcesFromFlags(flags)
    };
    const memory = useApi
      ? (await requestApi<{ memory: unknown }>("/api/memories", {
          method: "POST",
          body: JSON.stringify(body)
        })).memory
      : await (await createMemoryStore()).saveMemory(body);
    printJson({ memory });
    return;
  }

  if (subcommand === "recall") {
    const query = positionals.join(" ").trim();
    if (!query) {
      throw new Error("memory recall requires a query");
    }

    const result = await recall(query, Number(flagString(flags, "limit") ?? 10), useApi, recallModeFromFlags(flags));
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`searchMode: ${result.searchMode}\n`);
      for (const item of result.results) {
        process.stdout.write(
          `${item.score}\t${item.type}\t${item.title}\t${item.citation.label}\t${item.snippet}\n`
        );
      }
    }
    return;
  }

  if (subcommand === "forget") {
    const id = positionals[0];
    if (!id) {
      throw new Error("memory forget requires <memory-id>");
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const memory = useApi
      ? (await requestApi<{ memory: unknown }>(`/api/memories/${id}/forget`, {
          method: "POST",
          body: JSON.stringify({ actor })
        })).memory
      : await (await createMemoryStore()).forgetMemory(id, actor);
    printJson({ memory });
    return;
  }

  if (subcommand === "forget-artifact") {
    const id = positionals[0];
    if (!id) {
      throw new Error("memory forget-artifact requires <artifact-id>");
    }

    const actor = flagString(flags, "actor") ?? "cli";
    const artifact = useApi
      ? (await requestApi<{ artifact: unknown }>(`/api/source-artifacts/${id}/forget`, {
          method: "POST",
          body: JSON.stringify({ actor })
        })).artifact
      : await (await createMemoryStore()).forgetArtifact(id, actor);
    printJson({ artifact });
    return;
  }

  throw new Error(`Unknown memory command: ${subcommand ?? ""}`);
}

function printHelp() {
  process.stdout.write(`Company Brain CLI

Usage:
  pnpm cb doctor
  pnpm cb migrate to postgres --database-url <postgres-url>
  pnpm cb migrate to supabase --database-url <supabase-postgres-url>
  pnpm cb import files ./notes-or-export [--no-recursive] [--source-type file]
  pnpm cb workspace init
  pnpm cb projects create "Client Project"
  pnpm cb memory ingest --title "Title" --text "raw text" [--source-type manual]
  pnpm cb memory save --kind fact --content "..." [--subject "..."] [--source-artifact <id> | --source-chunk <id> | --source-page <id> | --source-page-chunk <id>] [--quote "..."]
  pnpm cb memory recall "query" [--json] [--limit 10] [--mode bm25_local_v1|lexical_v1]
  pnpm cb memory forget <memory-id>
  pnpm cb memory forget-artifact <artifact-id>
  pnpm cb pages list [--json]
  pnpm cb pages search "query" [--json] [--limit 20]
  pnpm cb pages get <id-or-slug>
  pnpm cb pages versions <id-or-slug> [--json]
  pnpm cb pages version <id-or-slug> <version-id>
  pnpm cb pages create --title "Title" --html "<h1>Title</h1>"
  pnpm cb pages create --title "Title" --html-file ./page.html
  pnpm cb pages update <id-or-slug> [--title "Title"] [--html "..."] [--html-file ./page.html]
  pnpm cb pages duplicate <id-or-slug>
  pnpm cb pages move <id-or-slug> [parent-id-or-slug|top]
  pnpm cb pages delete <id-or-slug>
  pnpm cb pages restore <id-or-slug> <version-id>

Options:
  --actor <name>  Actor recorded in page metadata. Defaults to cli.
  --direct        Access PGlite directly instead of the running API.
  --json          Print JSON for list.
  --mode <mode>   Recall mode. Defaults to bm25_local_v1. Use lexical_v1 for the old term-overlap retriever.
  --no-recursive  Do not recurse when importing a directory.
  --source-artifact <id>    Attach an artifact citation to memory save.
  --source-chunk <id>       Attach a source chunk citation to memory save.
  --source-page <id>        Attach a page citation to memory save.
  --source-page-chunk <id>  Attach a page chunk citation to memory save.
  --quote <text>            Attach citation text to memory save. Without a source flag, this creates a manual citation.
  --allow-non-empty         Allow migration into a non-empty Postgres database.
  --allow-running-api       Allow migration while the local API is reachable.
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

import { existsSync } from "node:fs";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import git from "isomorphic-git";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A human or agent performing a mutation. Maps to a git author. */
export interface Actor {
  name: string;
  email?: string;
}

export interface GitWriterOptions {
  /** Absolute path to the workspace directory (becomes a git repo). */
  workspaceDir: string;
  /** Default branch name for a freshly-initialized repo. Defaults to "main". */
  defaultBranch?: string;
  /**
   * Called after a mutation produces a new commit (the reindex seam). Runs
   * inside the serialized queue, so the index update cannot race the next
   * mutation. Not called when a mutation results in no commit.
   */
  onCommit?: (info: CommitHookInfo) => Promise<void> | void;
}

export interface CommitHookInfo {
  /** Repo-relative paths the mutation declared. */
  paths: string[];
  /** The new commit hash. */
  hash: string;
}

/**
 * A single serialized workspace mutation: declare the paths it touches, perform
 * the file writes in `write()`, and the queue stages exactly those paths and
 * commits them atomically with the actor's attribution.
 */
export interface WorkspaceMutation {
  /** Explicit repo-relative paths this mutation creates, modifies, or deletes. */
  paths: string[];
  message: string;
  actor: Actor;
  /** Performs the file writes/deletes for the declared paths. */
  write: () => Promise<void> | void;
  /**
   * Repo-global optimistic-concurrency guard (the commit hash the caller last saw,
   * compared against workspace HEAD). Retained for back-compat; prefer
   * `expectedPathVersion` for per-file checks — repo-HEAD fires false conflicts on
   * edits to unrelated files.
   */
  baseVersion?: string;
  /**
   * Per-file optimistic-concurrency guard (Phase 5): the last-commit oid the caller
   * last saw for a specific path. Checked inside the writer mutex before `write()`;
   * if that path's current last-commit oid differs, the write is stale → conflict.
   * Unlike `baseVersion` this only conflicts on changes to *that* file, so concurrent
   * edits to unrelated files don't collide. `oid: null` means "expected absent" (new file).
   */
  expectedPathVersion?: { path: string; oid: string | null };
}

export interface MutationResult {
  hash: string;
  /** False when nothing changed (no new commit was created). */
  changed: boolean;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: { name: string; email: string };
  /** Commit time in epoch seconds. */
  timestamp: number;
}

export interface FileDiff {
  path: string;
  /** File content at the parent commit, or null if the file did not exist then. */
  before: string | null;
  /** File content at the target commit, or null if the file was deleted in it. */
  after: string | null;
}

export interface WorkspaceStatus {
  /** Repo-relative paths with uncommitted changes (staged or unstaged). */
  changed: string[];
  clean: boolean;
}

/** The marker that proves this repo is managed by Company Brain. */
const MANAGED_CONFIG_PATH = "companybrain.managed";

/** Staging-all sentinels that must never be passed as explicit paths. */
const STAGE_ALL_SENTINELS = new Set([".", "-A", "--all", "*", ""]);

export class GitWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWriterError";
  }
}

/**
 * Thrown when a mutation's `baseVersion` no longer matches HEAD — another writer
 * committed first. Callers map this to an HTTP 409 (optimistic concurrency).
 */
export class WorkspaceConflictError extends Error {
  readonly baseVersion: string;
  readonly currentVersion: string;
  constructor(baseVersion: string, currentVersion: string) {
    super(
      `Stale write: baseVersion ${baseVersion.slice(0, 8)} no longer matches HEAD ${currentVersion.slice(0, 8)}.`
    );
    this.name = "WorkspaceConflictError";
    this.baseVersion = baseVersion;
    this.currentVersion = currentVersion;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitWriter(options: GitWriterOptions) {
  const dir = options.workspaceDir;
  const defaultBranch = options.defaultBranch ?? "main";
  // Post-commit hooks run inside the queue after each commit. Multiple stores
  // (pages, memory) each register a hook that filters to the paths/area it owns.
  const commitHooks: NonNullable<GitWriterOptions["onCommit"]>[] = [];
  if (options.onCommit) commitHooks.push(options.onCommit);

  async function isRepo(): Promise<boolean> {
    return existsSync(join(dir, ".git"));
  }

  async function isManaged(): Promise<boolean> {
    const value = await git.getConfig({ fs, dir, path: MANAGED_CONFIG_PATH });
    return value === "true";
  }

  /**
   * Initialize the workspace as a git repo if needed and stamp the managed
   * marker. Refuses to operate on a pre-existing repo that lacks the marker, so
   * we never auto-commit into a repo Company Brain did not create.
   */
  async function ensureRepo(): Promise<void> {
    if (await isRepo()) {
      if (!(await isManaged())) {
        throw new GitWriterError(
          `Refusing to operate on ${dir}: existing git repo is not Company Brain-managed ` +
            `(missing ${MANAGED_CONFIG_PATH}=true).`
        );
      }
      return;
    }
    // git.init creates the dir itself, but ensure it explicitly so we never
    // depend on that behavior (fresh installs may lack the parent dirs).
    await mkdir(dir, { recursive: true });
    await git.init({ fs, dir, defaultBranch });
    await git.setConfig({ fs, dir, path: MANAGED_CONFIG_PATH, value: "true" });
  }

  function assertExplicitPaths(paths: string[]): void {
    if (paths.length === 0) {
      throw new GitWriterError("stageAndCommit requires at least one explicit path.");
    }
    for (const p of paths) {
      if (STAGE_ALL_SENTINELS.has(p.trim())) {
        throw new GitWriterError(
          `Refusing to stage "${p}": explicit paths only, never stage-all (git add .).`
        );
      }
    }
  }

  function toAuthor(actor: Actor): { name: string; email: string } {
    const safe = actor.name.trim() || "unknown";
    return {
      name: safe,
      email: actor.email?.trim() || `${slugifyEmailLocal(safe)}@company-brain.local`,
    };
  }

  async function headOid(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir, ref: "HEAD" });
    } catch {
      return null; // no commits yet
    }
  }

  /**
   * Stage exactly the given paths (adding existing files, removing deleted
   * ones) and commit them with the actor's attribution. Returns the new commit
   * hash, or the existing HEAD hash if nothing actually changed (no empty
   * commits).
   */
  async function stageAndCommit(
    paths: string[],
    message: string,
    actor: Actor
  ): Promise<string> {
    assertExplicitPaths(paths);
    await ensureRepo();

    for (const filepath of paths) {
      if (existsSync(join(dir, filepath))) {
        await git.add({ fs, dir, filepath });
      } else {
        // Removing a path that isn't tracked (e.g. a delete-variant that never
        // existed) is a no-op, not an error.
        try {
          await git.remove({ fs, dir, filepath });
        } catch {
          /* path not tracked */
        }
      }
    }

    if (!(await hasStagedChanges(paths))) {
      const current = await headOid();
      if (current) return current;
    }

    return git.commit({ fs, dir, message, author: toAuthor(actor) });
  }

  /** True if any of the given paths differ between the index and HEAD. */
  async function hasStagedChanges(paths: string[]): Promise<boolean> {
    for (const filepath of paths) {
      const [, head, , stage] = (
        await git.statusMatrix({ fs, dir, filepaths: [filepath] })
      )[0] ?? [filepath, 0, 0, 0];
      if (head !== stage) return true;
    }
    return false;
  }

  /** Commits that touched a path, newest first. */
  async function history(relPath: string): Promise<CommitInfo[]> {
    await ensureRepo();
    const commits = await git.log({ fs, dir, filepath: relPath, force: true });
    return commits.map((c) => ({
      hash: c.oid,
      message: c.commit.message.trim(),
      author: { name: c.commit.author.name, email: c.commit.author.email },
      timestamp: c.commit.author.timestamp,
    }));
  }

  /** The oid of the most recent commit that touched a path, or null if none. */
  async function lastCommitOid(relPath: string): Promise<string | null> {
    await ensureRepo();
    try {
      const commits = await git.log({ fs, dir, filepath: relPath, depth: 1, force: true });
      return commits[0]?.oid ?? null;
    } catch {
      return null; // path never committed
    }
  }

  async function readBlobAt(oid: string, relPath: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ fs, dir, oid, filepath: relPath });
      return new TextDecoder().decode(blob);
    } catch {
      return null; // path absent at this commit
    }
  }

  /**
   * Content of a path before/after a commit. isomorphic-git has no diff
   * command, so we read the blob at the commit and at its first parent; callers
   * (or the UI) render the line diff from these.
   */
  async function diff(hash: string, relPath: string): Promise<FileDiff> {
    await ensureRepo();
    const after = await readBlobAt(hash, relPath);
    const { commit } = await git.readCommit({ fs, dir, oid: hash });
    const parent = commit.parent[0];
    const before = parent ? await readBlobAt(parent, relPath) : null;
    return { path: relPath, before, after };
  }

  /** Author/message/timestamp for a single commit, or null if unknown. */
  async function commitMeta(hash: string): Promise<CommitInfo | null> {
    await ensureRepo();
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: hash });
      return {
        hash,
        message: commit.message.trim(),
        author: { name: commit.author.name, email: commit.author.email },
        timestamp: commit.author.timestamp,
      };
    } catch {
      return null;
    }
  }

  /** Content of a path as of a given commit (for restore/preview). */
  async function restore(hash: string, relPath: string): Promise<string> {
    await ensureRepo();
    const content = await readBlobAt(hash, relPath);
    if (content === null) {
      throw new GitWriterError(`Path "${relPath}" does not exist at commit ${hash}.`);
    }
    return content;
  }

  async function status(): Promise<WorkspaceStatus> {
    await ensureRepo();
    const matrix = await git.statusMatrix({ fs, dir });
    const changed = matrix
      .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
      .map(([filepath]) => filepath);
    return { changed, clean: changed.length === 0 };
  }

  /** Restore the declared paths to their state at `priorHead` (rollback). */
  async function rollbackPaths(paths: string[], priorHead: string | null): Promise<void> {
    for (const p of paths) {
      const existedAtHead = priorHead ? (await readBlobAt(priorHead, p)) !== null : false;
      if (existedAtHead && priorHead) {
        await git.checkout({ fs, dir, ref: priorHead, filepaths: [p], force: true });
      } else if (existsSync(join(dir, p))) {
        await rm(join(dir, p), { force: true });
      }
    }
  }

  // Serialized single-writer queue: one mutation runs at a time so commits and
  // the reindex hook never race. New mutations chain onto the tail promise.
  let tail: Promise<unknown> = Promise.resolve();

  async function runMutation(mutation: WorkspaceMutation): Promise<MutationResult> {
    assertExplicitPaths(mutation.paths);
    await ensureRepo();
    const priorHead = await headOid();

    if (mutation.baseVersion !== undefined && mutation.baseVersion !== (priorHead ?? "")) {
      throw new WorkspaceConflictError(mutation.baseVersion, priorHead ?? "");
    }

    // Per-file optimistic-concurrency check — inside the mutex, before write(), so a
    // racing commit between the caller's read and this enqueue is caught atomically.
    // Only conflicts on changes to the specific path (no false cross-file conflicts).
    if (mutation.expectedPathVersion !== undefined) {
      const { path, oid } = mutation.expectedPathVersion;
      const currentOid = await lastCommitOid(path);
      if (currentOid !== oid) {
        throw new WorkspaceConflictError(oid ?? "", currentOid ?? "");
      }
    }

    let hash: string;
    let changed: boolean;
    try {
      await mutation.write();
      hash = await stageAndCommit(mutation.paths, mutation.message, mutation.actor);
      changed = hash !== priorHead;
    } catch (error) {
      // Pre-commit failure: nothing is committed yet, so revert the worktree.
      await rollbackPaths(mutation.paths, priorHead);
      throw error;
    }

    // The commit is durable. A post-commit hook failure (e.g. a reindex/DB
    // error) must NOT roll back the committed canonical file — that would leave
    // git history ahead of a reverted worktree. Surface the error so the caller
    // can retry; the derived index is recoverable via reindex.
    if (changed) {
      for (const hook of commitHooks) {
        await hook({ paths: mutation.paths, hash });
      }
    }
    return { hash, changed };
  }

  /** Enqueue a mutation; resolves/rejects after it (and its hook) complete. */
  function enqueue(mutation: WorkspaceMutation): Promise<MutationResult> {
    const result = tail.then(
      () => runMutation(mutation),
      () => runMutation(mutation)
    );
    // Keep the chain alive even if this mutation rejects.
    tail = result.catch(() => undefined);
    return result;
  }

  /** Replace all in-queue post-commit hooks with a single one (back-compat). */
  function setOnCommit(hook: GitWriterOptions["onCommit"]): void {
    commitHooks.length = 0;
    if (hook) commitHooks.push(hook);
  }

  /** Append an in-queue post-commit hook (each store registers its own). */
  function addCommitHook(hook: NonNullable<GitWriterOptions["onCommit"]>): void {
    commitHooks.push(hook);
  }

  return {
    ensureRepo,
    isManaged,
    stageAndCommit,
    enqueue,
    setOnCommit,
    addCommitHook,
    history,
    lastCommitOid,
    diff,
    commitMeta,
    restore,
    status,
    headOid,
  };
}

export type GitWriter = ReturnType<typeof createGitWriter>;

function slugifyEmailLocal(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

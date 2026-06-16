import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import git from "isomorphic-git";
import fs from "node:fs";
import { createGitWriter, GitWriterError, WorkspaceConflictError } from "./index.ts";
import type { CommitHookInfo } from "./index.ts";

async function withWriter<T>(
  run: (writer: ReturnType<typeof createGitWriter>, dir: string) => Promise<T>,
  options?: { onCommit?: (info: CommitHookInfo) => void | Promise<void> }
) {
  const dir = await mkdtemp(join(tmpdir(), "company-brain-git-writer-test-"));
  try {
    return await run(createGitWriter({ workspaceDir: dir, onCommit: options?.onCommit }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const actor = { name: "Test Agent", email: "agent@example.com" };

test("ensureRepo initializes a managed repo", async () => {
  await withWriter(async (writer, dir) => {
    await writer.ensureRepo();
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(await writer.isManaged(), true);
  });
});

test("stageAndCommit commits one path with author and message", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\n");
    const hash = await writer.stageAndCommit(["a.md"], "add a", actor);
    assert.match(hash, /^[0-9a-f]{40}$/);

    const log = await writer.history("a.md");
    assert.equal(log.length, 1);
    assert.equal(log[0].message, "add a");
    assert.equal(log[0].author.name, "Test Agent");
    assert.equal(log[0].author.email, "agent@example.com");
  });
});

test("stageAndCommit stages only the listed paths", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\n");
    await writeFile(join(dir, "b.md"), "# B\n");
    await writeFile(join(dir, "c.md"), "# C\n");

    await writer.stageAndCommit(["a.md", "b.md"], "add a and b", actor);

    const st = await writer.status();
    assert.equal(st.changed.includes("c.md"), true);
    assert.equal(st.changed.includes("a.md"), false);
    assert.equal(st.changed.includes("b.md"), false);
    assert.equal((await writer.history("c.md")).length, 0);
  });
});

test("stageAndCommit refuses stage-all sentinels", async () => {
  await withWriter(async (writer) => {
    await assert.rejects(() => writer.stageAndCommit(["."], "nope", actor), GitWriterError);
    await assert.rejects(() => writer.stageAndCommit(["-A"], "nope", actor), GitWriterError);
    await assert.rejects(() => writer.stageAndCommit([], "nope", actor), GitWriterError);
  });
});

test("ensureRepo refuses an unmanaged pre-existing repo", async () => {
  await withWriter(async (writer, dir) => {
    await git.init({ fs, dir, defaultBranch: "main" }); // no managed marker
    await assert.rejects(() => writer.ensureRepo(), GitWriterError);
  });
});

test("stageAndCommit does not create an empty commit", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\n");
    const first = await writer.stageAndCommit(["a.md"], "add a", actor);
    const again = await writer.stageAndCommit(["a.md"], "noop", actor);
    assert.equal(again, first); // nothing changed -> same HEAD, no new commit
    assert.equal((await writer.history("a.md")).length, 1);
  });
});

test("history, diff, and restore round-trip across commits", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\nv1\n");
    const h1 = await writer.stageAndCommit(["a.md"], "v1", actor);
    await writeFile(join(dir, "a.md"), "# A\nv2\n");
    const h2 = await writer.stageAndCommit(["a.md"], "v2", actor);

    const log = await writer.history("a.md");
    assert.equal(log.length, 2);
    assert.equal(log[0].hash, h2); // newest first

    const d = await writer.diff(h2, "a.md");
    assert.equal(d.before, "# A\nv1\n");
    assert.equal(d.after, "# A\nv2\n");

    assert.equal(await writer.restore(h1, "a.md"), "# A\nv1\n");
  });
});

test("diff reports null before for a file's first commit", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\n");
    const h1 = await writer.stageAndCommit(["a.md"], "v1", actor);
    const d = await writer.diff(h1, "a.md");
    assert.equal(d.before, null);
    assert.equal(d.after, "# A\n");
  });
});

test("restore throws for a path absent at the commit", async () => {
  await withWriter(async (writer, dir) => {
    await writeFile(join(dir, "a.md"), "# A\n");
    const h1 = await writer.stageAndCommit(["a.md"], "v1", actor);
    await assert.rejects(() => writer.restore(h1, "missing.md"), GitWriterError);
  });
});

// --- U2: serialized queue --------------------------------------------------

test("enqueue serializes mutations in submission order", async () => {
  await withWriter(async (writer, dir) => {
    // Submit concurrently (no await between) — the queue must serialize them.
    const p1 = writer.enqueue({
      paths: ["a.md"],
      message: "m1",
      actor,
      write: () => writeFile(join(dir, "a.md"), "a\n"),
    });
    const p2 = writer.enqueue({
      paths: ["b.md"],
      message: "m2",
      actor,
      write: () => writeFile(join(dir, "b.md"), "b\n"),
    });
    await Promise.all([p1, p2]);

    const messages = (await git.log({ fs, dir })).map((c) => c.commit.message.trim());
    assert.deepEqual(messages, ["m2", "m1"]); // newest first; m2 committed after m1
  });
});

test("enqueue fires onCommit once per commit with paths and hash", async () => {
  const seen: CommitHookInfo[] = [];
  await withWriter(
    async (writer, dir) => {
      const { hash } = await writer.enqueue({
        paths: ["a.md"],
        message: "m1",
        actor,
        write: () => writeFile(join(dir, "a.md"), "a\n"),
      });
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].paths, ["a.md"]);
      assert.equal(seen[0].hash, hash);
    },
    { onCommit: (info) => void seen.push(info) }
  );
});

test("a failing mutation rolls back, leaves HEAD unchanged, and the queue survives", async () => {
  const seen: CommitHookInfo[] = [];
  await withWriter(
    async (writer, dir) => {
      await writer.enqueue({
        paths: ["a.md"],
        message: "seed",
        actor,
        write: () => writeFile(join(dir, "a.md"), "seed\n"),
      });
      const headBefore = await writer.headOid();

      await assert.rejects(() =>
        writer.enqueue({
          paths: ["b.md"],
          message: "boom",
          actor,
          write: async () => {
            await writeFile(join(dir, "b.md"), "partial\n"); // partial write...
            throw new Error("boom"); // ...then fail
          },
        })
      );

      assert.equal(await writer.headOid(), headBefore); // no new commit
      assert.equal(existsSync(join(dir, "b.md")), false); // partial write rolled back
      assert.equal((await writer.status()).clean, true);

      // The queue still works after a failure.
      const { hash } = await writer.enqueue({
        paths: ["c.md"],
        message: "after",
        actor,
        write: () => writeFile(join(dir, "c.md"), "c\n"),
      });
      assert.match(hash, /^[0-9a-f]{40}$/);
      assert.equal(seen.filter((s) => s.paths.includes("b.md")).length, 0); // hook never fired for failed mutation
    },
    { onCommit: (info) => void seen.push(info) }
  );
});

test("a mutation with no file changes does not create an empty commit", async () => {
  const seen: CommitHookInfo[] = [];
  await withWriter(
    async (writer, dir) => {
      const first = await writer.enqueue({
        paths: ["a.md"],
        message: "v1",
        actor,
        write: () => writeFile(join(dir, "a.md"), "v1\n"),
      });
      const noop = await writer.enqueue({
        paths: ["a.md"],
        message: "noop",
        actor,
        write: () => writeFile(join(dir, "a.md"), "v1\n"), // identical content
      });
      assert.equal(noop.changed, false);
      assert.equal(noop.hash, first.hash);
      assert.equal(seen.length, 1); // hook only fired for the real commit
    },
    { onCommit: (info) => void seen.push(info) }
  );
});

// --- U3: attribution + optimistic concurrency ------------------------------

test("a mutation whose baseVersion matches HEAD commits", async () => {
  await withWriter(async (writer, dir) => {
    const first = await writer.enqueue({
      paths: ["a.md"],
      message: "v1",
      actor,
      write: () => writeFile(join(dir, "a.md"), "v1\n"),
    });
    const second = await writer.enqueue({
      paths: ["a.md"],
      message: "v2",
      actor,
      baseVersion: first.hash,
      write: () => writeFile(join(dir, "a.md"), "v2\n"),
    });
    assert.notEqual(second.hash, first.hash);
    assert.equal(second.changed, true);
  });
});

test("a stale baseVersion throws WorkspaceConflictError and leaves HEAD unchanged", async () => {
  await withWriter(async (writer, dir) => {
    const first = await writer.enqueue({
      paths: ["a.md"],
      message: "v1",
      actor,
      write: () => writeFile(join(dir, "a.md"), "v1\n"),
    });
    await writer.enqueue({
      paths: ["a.md"],
      message: "v2",
      actor,
      write: () => writeFile(join(dir, "a.md"), "v2\n"),
    });
    const headBefore = await writer.headOid();

    await assert.rejects(
      () =>
        writer.enqueue({
          paths: ["a.md"],
          message: "stale",
          actor,
          baseVersion: first.hash, // stale: HEAD has moved past v1
          write: () => writeFile(join(dir, "a.md"), "v3\n"),
        }),
      WorkspaceConflictError
    );
    assert.equal(await writer.headOid(), headBefore);
  });
});

test("human and agent actors produce distinct, well-formed commit authors", async () => {
  await withWriter(async (writer, dir) => {
    await writer.enqueue({
      paths: ["a.md"],
      message: "by human",
      actor: { name: "Alice Smith" }, // no email -> derived local part
      write: () => writeFile(join(dir, "a.md"), "a\n"),
    });
    await writer.enqueue({
      paths: ["b.md"],
      message: "by agent",
      actor: { name: "Researcher", email: "agent@company-brain.local" },
      write: () => writeFile(join(dir, "b.md"), "b\n"),
    });

    const log = await git.log({ fs, dir });
    const byMessage = Object.fromEntries(log.map((c) => [c.commit.message.trim(), c.commit.author]));
    assert.equal(byMessage["by human"].name, "Alice Smith");
    assert.equal(byMessage["by human"].email, "alice-smith@company-brain.local");
    assert.equal(byMessage["by agent"].email, "agent@company-brain.local");
  });
});

// KTD1 validation spike: confirms the full isomorphic-git cycle Phase 0 relies
// on (init -> commit -> amend-file -> commit -> log -> diff -> restore) works.
// If this ever fails the bar, the package swaps to simple-git behind the same
// factory interface (see plan KTD1).
test("KTD1 spike: nested-path init/commit/log/diff/restore cycle", async () => {
  await withWriter(async (writer, dir) => {
    await mkdir(join(dir, "pages", "engineering"), { recursive: true });
    const rel = "pages/engineering/runbook.md";
    await writeFile(join(dir, rel), "# Runbook\nstep 1\n");
    const h1 = await writer.stageAndCommit([rel], "runbook v1", actor);
    await writeFile(join(dir, rel), "# Runbook\nstep 1\nstep 2\n");
    const h2 = await writer.stageAndCommit([rel], "runbook v2", actor);

    const log = await writer.history(rel);
    assert.equal(log.length, 2);
    const d = await writer.diff(h2, rel);
    assert.equal(d.before, "# Runbook\nstep 1\n");
    assert.equal(d.after, "# Runbook\nstep 1\nstep 2\n");
    assert.equal(await writer.restore(h1, rel), "# Runbook\nstep 1\n");
  });
});

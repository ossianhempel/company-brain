import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDb } from "@company-brain/db";
import { createWorkspace } from "@company-brain/workspace";
import { createGitWriter } from "@company-brain/git-writer";
import { createAgentStore, createProviderRegistry, type Provider, type RunInput } from "./index.ts";

async function withRun<T>(
  run: (store: Awaited<ReturnType<typeof createAgentStore>>, registry: ReturnType<typeof createProviderRegistry>) => Promise<T>
) {
  const wsDir = await mkdtemp(join(tmpdir(), "cb-run-ws-"));
  const dbDir = await mkdtemp(join(tmpdir(), "cb-run-db-"));
  const db = await createDb(dbDir);
  const ws = createWorkspace({ workspaceDir: wsDir });
  const gw = createGitWriter({ workspaceDir: wsDir });
  const registry = createProviderRegistry();
  try {
    const store = await createAgentStore(db, { gitWriter: gw, workspace: ws, providers: registry });
    return await run(store, registry);
  } finally {
    await db.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
}

/** A fake provider that records the input it was run with. */
function fakeProvider(id: string, behavior: (input: RunInput) => ReturnType<Provider["run"]>): Provider & { lastInput?: RunInput } {
  const p: Provider & { lastInput?: RunInput } = {
    id,
    detect: async () => ({ available: true }),
    run: async (input) => {
      p.lastInput = input;
      return behavior(input);
    },
  };
  return p;
}

test("runAgent executes a provider and writes a done transcript", async () => {
  await withRun(async (store, registry) => {
    registry.register(fakeProvider("fake", async () => ({ status: "done", turns: [{ role: "agent", content: "All summarized." }], usage: { outputTokens: 5 } })));
    await store.saveAgentFile("scribe", "You are the scribe.");

    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "Summarize today.", providerOverride: "fake" });
    assert.equal(conv?.status, "done");
    assert.equal(conv?.provider, "fake");

    const full = await store.getConversation(conv!.id);
    assert.equal(full?.turns[0].role, "user");
    assert.equal(full?.turns[0].content, "Summarize today.");
    assert.equal(full?.turns[1].content, "All summarized.");
    assert.deepEqual(full?.usage, { outputTokens: 5 });
  });
});

test("runAgent passes the persona body as the system prompt", async () => {
  await withRun(async (store, registry) => {
    const provider = fakeProvider("fake", async () => ({ status: "done", turns: [] }));
    registry.register(provider);
    await store.saveAgentFile("scribe", "You are the meticulous scribe.");
    await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "fake" });
    assert.match(provider.lastInput?.systemPrompt ?? "", /meticulous scribe/);
  });
});

test("an unknown provider records a failed transcript (no throw)", async () => {
  await withRun(async (store) => {
    await store.saveAgentFile("scribe", "x");
    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "ghost" });
    assert.equal(conv?.status, "failed");
    assert.match(conv?.error ?? "", /Unknown provider/);
  });
});

test("an agent with no provider records a failed transcript", async () => {
  await withRun(async (store) => {
    await store.saveAgentFile("scribe", "x");
    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "go" });
    assert.equal(conv?.status, "failed");
    assert.match(conv?.error ?? "", /No provider configured/);
  });
});

test("a provider that fails (e.g. CLI down) is recorded, not thrown", async () => {
  await withRun(async (store, registry) => {
    registry.register(fakeProvider("fake", async () => ({ status: "failed", turns: [], error: "cli unavailable" })));
    await store.saveAgentFile("scribe", "x");
    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "fake" });
    assert.equal(conv?.status, "failed");
    assert.equal(conv?.error, "cli unavailable");
  });
});

test("concurrent runs produce two distinct transcripts", async () => {
  await withRun(async (store, registry) => {
    registry.register(fakeProvider("fake", async () => ({ status: "done", turns: [{ role: "agent", content: "ok" }] })));
    await store.saveAgentFile("scribe", "x");
    const [a, b] = await Promise.all([
      store.runAgent({ agentSlug: "scribe", prompt: "one", providerOverride: "fake" }),
      store.runAgent({ agentSlug: "scribe", prompt: "two", providerOverride: "fake" }),
    ]);
    assert.notEqual(a?.id, b?.id);
    assert.equal((await store.listConversations()).length, 2);
  });
});

test("a provider that throws is recorded as a failed transcript (not escaped)", async () => {
  await withRun(async (store, registry) => {
    registry.register({
      id: "boom",
      detect: async () => ({ available: true }),
      run: async () => {
        throw new Error("provider exploded");
      },
    });
    await store.saveAgentFile("scribe", "x");
    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "boom" });
    assert.equal(conv?.status, "failed");
    assert.match(conv?.error ?? "", /provider exploded/);
  });
});

test("an unavailable provider (detect=false) is recorded as failed without running", async () => {
  await withRun(async (store, registry) => {
    let ran = false;
    registry.register({
      id: "down",
      detect: async () => ({ available: false, error: "cli not installed" }),
      run: async () => {
        ran = true;
        return { status: "done", turns: [] };
      },
    });
    await store.saveAgentFile("scribe", "x");
    const conv = await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "down" });
    assert.equal(conv?.status, "failed");
    assert.match(conv?.error ?? "", /cli not installed/);
    assert.equal(ran, false); // run() not invoked for an unavailable provider
  });
});

test("listConversations tolerates a non-finite limit (no SQL break)", async () => {
  await withRun(async (store, registry) => {
    registry.register(fakeProvider("fake", async () => ({ status: "done", turns: [] })));
    await store.saveAgentFile("scribe", "x");
    await store.runAgent({ agentSlug: "scribe", prompt: "go", providerOverride: "fake" });
    const list = await store.listConversations({ limit: Number("abc") }); // NaN
    assert.equal(list.length >= 1, true); // falls back to default, doesn't throw
  });
});

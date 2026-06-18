import assert from "node:assert/strict";
import test from "node:test";
import {
  detectCli,
  createProviderRegistry,
  type CommandRunner,
  type ExecResult,
  type Provider,
} from "./provider.ts";

/** A fake CommandRunner: `present` maps command -> path; `exec` maps path -> result. */
function fakeRunner(present: Record<string, string>, exec: (cmd: string, args: string[]) => ExecResult): CommandRunner {
  return {
    async which(command) {
      return present[command] ?? null;
    },
    async exec(command, args) {
      return exec(command, args);
    },
  };
}

test("detectCli reports available + version when the CLI resolves and --version succeeds", async () => {
  const runner = fakeRunner(
    { claude: "/opt/homebrew/bin/claude" },
    () => ({ code: 0, stdout: "claude 1.2.3\n", stderr: "", timedOut: false })
  );
  const d = await detectCli(runner, ["claude-code", "claude"]);
  assert.equal(d.available, true);
  assert.equal(d.path, "/opt/homebrew/bin/claude");
  assert.equal(d.version, "claude 1.2.3");
});

test("detectCli reports unavailable when no candidate resolves", async () => {
  const runner = fakeRunner({}, () => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
  const d = await detectCli(runner, ["nope", "alsonope"]);
  assert.equal(d.available, false);
  assert.match(d.error ?? "", /found on PATH/);
});

test("detectCli reports unavailable when the version probe times out", async () => {
  const runner = fakeRunner(
    { codex: "/usr/local/bin/codex" },
    () => ({ code: -1, stdout: "", stderr: "", timedOut: true })
  );
  const d = await detectCli(runner, ["codex"]);
  assert.equal(d.available, false);
  assert.match(d.error ?? "", /timed out/);
});

test("detectCli reports unavailable on a non-zero version exit", async () => {
  const runner = fakeRunner(
    { codex: "/usr/local/bin/codex" },
    () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false })
  );
  const d = await detectCli(runner, ["codex"]);
  assert.equal(d.available, false);
  assert.equal(d.error, "boom");
});

test("registry lists every provider with its detection result", async () => {
  const registry = createProviderRegistry();
  const mk = (id: string, available: boolean): Provider => ({
    id,
    detect: async () => ({ available }),
    run: async () => ({ status: "done", turns: [] }),
  });
  registry.register(mk("claude_local", true));
  registry.register(mk("codex_local", false));
  assert.deepEqual(registry.ids().sort(), ["claude_local", "codex_local"]);
  const all = await registry.detectAll();
  assert.equal(all.find((p) => p.id === "claude_local")?.detection.available, true);
  assert.equal(all.find((p) => p.id === "codex_local")?.detection.available, false);
  assert.equal(registry.get("claude_local")?.id, "claude_local");
  assert.equal(registry.get("missing"), null);
});

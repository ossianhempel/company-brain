import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRunner, ExecResult } from "../provider.ts";
import { createLocalCliProvider, defaultParseOutput, claudeLocalProvider, codexLocalProvider } from "./local-cli.ts";

function runner(opts: {
  path?: string;
  version?: ExecResult;
  run?: ExecResult;
  onExec?: (cmd: string, args: string[]) => void;
}): CommandRunner {
  return {
    async which(command) {
      return opts.path && (command === "claude" || command === "codex" || command === "cli") ? opts.path : null;
    },
    async exec(cmd, args) {
      opts.onExec?.(cmd, args);
      if (args.includes("--version")) return opts.version ?? { code: 0, stdout: "1.0.0", stderr: "", timedOut: false };
      return opts.run ?? { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
}

const config = (over = {}) => ({ id: "cli", candidates: ["cli"], buildArgs: (i: { prompt: string }) => ["run", i.prompt], ...over });

test("runs a CLI emitting plain text to a single agent turn", async () => {
  const p = createLocalCliProvider(config(), runner({ path: "/bin/cli", run: { code: 0, stdout: "Hello from the agent.", stderr: "", timedOut: false } }));
  const r = await p.run({ systemPrompt: "be nice", prompt: "hi" });
  assert.equal(r.status, "done");
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].content, "Hello from the agent.");
});

test("parses JSON-lines output into turns + usage", () => {
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Part one." }] } }),
    JSON.stringify({ type: "result", result: "ignored when assistant present", usage: { outputTokens: 42 } }),
  ].join("\n");
  const parsed = defaultParseOutput(stdout);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].content, "Part one.");
  assert.deepEqual(parsed.usage, { outputTokens: 42 });
});

test("a non-zero exit is a failed run with stderr captured", async () => {
  const p = createLocalCliProvider(config(), runner({ path: "/bin/cli", run: { code: 1, stdout: "", stderr: "kaboom", timedOut: false } }));
  const r = await p.run({ systemPrompt: "s", prompt: "p" });
  assert.equal(r.status, "failed");
  assert.equal(r.error, "kaboom");
});

test("a timeout is a failed run", async () => {
  const p = createLocalCliProvider(config(), runner({ path: "/bin/cli", run: { code: -1, stdout: "", stderr: "", timedOut: true } }));
  const r = await p.run({ systemPrompt: "s", prompt: "p" });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /timed out/);
});

test("an unavailable CLI fails without executing a run", async () => {
  let runCalled = false;
  const p = createLocalCliProvider(
    config(),
    runner({ run: { code: 0, stdout: "x", stderr: "", timedOut: false }, onExec: (_c, args) => { if (!args.includes("--version")) runCalled = true; } })
  );
  const r = await p.run({ systemPrompt: "s", prompt: "p" });
  assert.equal(r.status, "failed");
  assert.equal(runCalled, false); // never spawned the run
});

test("model override is passed into the spawned args", async () => {
  let seen: string[] = [];
  const p = claudeLocalProvider(runner({ path: "/bin/cli", run: { code: 0, stdout: "ok", stderr: "", timedOut: false }, onExec: (_c, args) => { if (!args.includes("--version")) seen = args; } }));
  await p.run({ systemPrompt: "s", prompt: "p", model: "opus-x" });
  assert.equal(seen.includes("--model"), true);
  assert.equal(seen.includes("opus-x"), true);
});

test("prompt + system prompt are sent via stdin, never argv (no ps/proc leak)", async () => {
  let seenArgs: string[] = [];
  let seenInput: string | undefined;
  const r: CommandRunner = {
    async which() {
      return "/bin/claude";
    },
    async exec(_cmd, args, opts) {
      if (!args.includes("--version")) {
        seenArgs = args;
        seenInput = opts?.input;
      }
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
  };
  const p = claudeLocalProvider(r);
  await p.run({ systemPrompt: "SECRET-PERSONA", prompt: "SECRET-TASK" });
  assert.equal(seenArgs.some((a) => a.includes("SECRET")), false); // nothing sensitive in argv
  assert.match(seenInput ?? "", /SECRET-PERSONA/);
  assert.match(seenInput ?? "", /SECRET-TASK/);
});

test("spawns the CLI in a scratch cwd, not the workspace", async () => {
  let seenCwd: string | undefined;
  const r: CommandRunner = {
    async which() {
      return "/bin/claude";
    },
    async exec(_cmd, args, opts) {
      if (!args.includes("--version")) seenCwd = opts?.cwd;
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
  };
  await claudeLocalProvider(r).run({ systemPrompt: "s", prompt: "p" });
  assert.equal(typeof seenCwd, "string");
  assert.notEqual(seenCwd, process.cwd()); // not the server/workspace cwd
});

test("parses Codex exec --json agent_message events into turns + usage", () => {
  const stdout = [
    JSON.stringify({ type: "item.started", item: { type: "agent_message" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex answer." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 7 } }),
  ].join("\n");
  const parsed = defaultParseOutput(stdout);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].content, "Codex answer.");
  assert.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 7 });
});

test("codexLocalProvider passes --skip-git-repo-check (exec requires a git repo)", async () => {
  const execArgs: string[][] = [];
  const provider = codexLocalProvider(
    runner({
      path: "/bin/codex",
      run: { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }), stderr: "", timedOut: false },
      onExec: (_cmd, args) => execArgs.push(args),
    })
  );
  const result = await provider.run({ systemPrompt: "", prompt: "hi" });
  assert.equal(result.status, "done");
  const runCall = execArgs.find((args) => args.includes("exec"));
  assert.ok(runCall, "expected a codex exec call");
  assert.ok(runCall!.includes("--skip-git-repo-check"), "exec args must include --skip-git-repo-check");
});

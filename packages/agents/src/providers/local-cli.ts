import {
  createNodeCommandRunner,
  detectCli,
  type CommandRunner,
  type Provider,
  type ProviderTurn,
  type RunInput,
  type RunResult,
} from "../provider.ts";

// ---------------------------------------------------------------------------
// Local-CLI provider — drives an installed agent CLI (claude / codex) via the
// CommandRunner. The mechanism (detect -> spawn -> parse) is generic; per-CLI
// argv + output parsing are config. The default flags are a best-effort
// starting point and may need tuning per CLI version — the adapter mechanism
// and parsing are what these tests pin down.
// ---------------------------------------------------------------------------

export interface LocalCliConfig {
  id: string;
  candidates: string[];
  versionArgs?: string[];
  /** Build the argv for a run. */
  buildArgs: (input: RunInput) => string[];
  /** Optional stdin payload (e.g. the prompt). */
  buildInput?: (input: RunInput) => string;
  /** Parse CLI stdout into turns + usage. Defaults to {@link defaultParseOutput}. */
  parseOutput?: (stdout: string) => { turns: ProviderTurn[]; usage?: Record<string, unknown> };
  defaultTimeoutMs?: number;
}

/**
 * Parse CLI stdout. Understands a stream of JSON lines (Claude/Codex headless
 * `--output-format json` shape: assistant message content + a result/usage
 * line); falls back to treating the whole stdout as one agent turn.
 */
export function defaultParseOutput(stdout: string): { turns: ProviderTurn[]; usage?: Record<string, unknown> } {
  const assistantTexts: string[] = [];
  let resultText: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let sawJson = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(trimmed);
      obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      obj = null;
    }
    if (!obj) continue;
    sawJson = true;
    const message = obj.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (obj.type === "assistant" && Array.isArray(message?.content)) {
      const text = message!.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("");
      if (text) assistantTexts.push(text);
    }
    if (obj.usage && typeof obj.usage === "object") usage = obj.usage as Record<string, unknown>;
    if (obj.type === "result" && typeof obj.result === "string") resultText = obj.result;
  }

  if (!sawJson) {
    const text = stdout.trim();
    return { turns: text ? [{ role: "agent", content: text }] : [] };
  }
  const turns: ProviderTurn[] = assistantTexts.map((content) => ({ role: "agent", content }));
  if (turns.length === 0 && resultText) turns.push({ role: "agent", content: resultText });
  return { turns, usage };
}

export function createLocalCliProvider(config: LocalCliConfig, runner: CommandRunner = createNodeCommandRunner()): Provider {
  const parse = config.parseOutput ?? defaultParseOutput;
  return {
    id: config.id,
    detect: () => detectCli(runner, config.candidates, { versionArgs: config.versionArgs }),
    async run(input: RunInput): Promise<RunResult> {
      const detection = await detectCli(runner, config.candidates, { versionArgs: config.versionArgs });
      if (!detection.available || !detection.path) {
        return { status: "failed", turns: [], error: detection.error ?? `${config.id} unavailable` };
      }
      const res = await runner.exec(detection.path, config.buildArgs(input), {
        input: config.buildInput ? config.buildInput(input) : undefined,
        timeoutMs: input.timeoutMs ?? config.defaultTimeoutMs ?? 120_000,
      });
      if (res.timedOut) return { status: "failed", turns: [], error: "run timed out" };
      if (res.code !== 0) return { status: "failed", turns: [], error: res.stderr.trim() || `exit ${res.code}` };
      const parsed = parse(res.stdout);
      return { status: "done", turns: parsed.turns, usage: parsed.usage };
    },
  };
}

/**
 * Combine persona (system prompt) + task (user prompt) into a single stdin
 * payload. Prompt text is fed via stdin — never argv — so private company
 * knowledge isn't exposed in `ps`/`/proc`/crash logs on shared hosts.
 */
function combinePrompts(input: RunInput): string {
  const system = input.systemPrompt.trim();
  const user = input.prompt.trim();
  return system ? `${system}\n\n---\n\n${user}` : user;
}

/** Claude Code headless provider (best-effort default flags; prompt via stdin). */
export function claudeLocalProvider(runner?: CommandRunner): Provider {
  return createLocalCliProvider(
    {
      id: "claude_local",
      candidates: ["claude", "claude-code"],
      buildArgs: (input) => ["-p", "--output-format", "json", ...(input.model ? ["--model", input.model] : [])],
      buildInput: combinePrompts,
    },
    runner
  );
}

/** Codex CLI headless provider (best-effort default flags; prompt via stdin). */
export function codexLocalProvider(runner?: CommandRunner): Provider {
  return createLocalCliProvider(
    {
      id: "codex_local",
      candidates: ["codex"],
      buildArgs: (input) => ["exec", "--json", ...(input.model ? ["--model", input.model] : [])],
      buildInput: combinePrompts,
    },
    runner
  );
}

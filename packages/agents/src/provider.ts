import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Provider layer — a pluggable interface for executing an agent run. The
// primary provider (U9) drives a locally-installed agent CLI; detection finds
// it via PATH (+ homebrew/nvm). The CommandRunner boundary is injectable so
// detection and execution are testable without real CLIs on the host.
// ---------------------------------------------------------------------------

export interface ProviderTurn {
  role: string;
  content: string;
}

export interface RunInput {
  systemPrompt: string;
  prompt: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface RunResult {
  status: "done" | "failed";
  turns: ProviderTurn[];
  usage?: Record<string, unknown>;
  error?: string;
}

export interface DetectionResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface Provider {
  readonly id: string;
  detect(): Promise<DetectionResult>;
  run(input: RunInput): Promise<RunResult>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The host-command boundary — injected so providers/detection are testable. */
export interface CommandRunner {
  /** Resolve a command name to an absolute executable path, or null if absent. */
  which(command: string): Promise<string | null>;
  exec(command: string, args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<ExecResult>;
}

/** Extra dirs to search beyond PATH — homebrew, the node bin, and nvm. */
function searchDirs(): string[] {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", dirname(process.execPath));
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  // nvm installs CLIs under ~/.nvm/versions/node/<version>/bin — enumerate them.
  const nvmVersions = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmVersions)) {
    try {
      for (const version of readdirSync(nvmVersions)) dirs.push(join(nvmVersions, version, "bin"));
    } catch {
      /* best-effort */
    }
  }
  return [...new Set(dirs)];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default CommandRunner backed by node child_process + filesystem PATH search. */
export function createNodeCommandRunner(): CommandRunner {
  return {
    async which(command) {
      if (command.includes("/")) return isExecutable(command) ? command : null;
      for (const dir of searchDirs()) {
        const candidate = join(dir, command);
        if (existsSync(candidate) && isExecutable(candidate)) return candidate;
      }
      return null;
    },
    exec(command, args, opts = {}) {
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let done = false;
        const finish = (code: number) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        };
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeoutMs)
          : null;
        child.stdout?.on("data", (d) => (stdout += String(d)));
        child.stderr?.on("data", (d) => (stderr += String(d)));
        child.on("error", (err) => {
          stderr += String((err as Error).message);
          finish(-1);
        });
        child.on("close", (code) => finish(code ?? -1));
        if (opts.input != null) {
          child.stdin?.write(opts.input);
          child.stdin?.end();
        }
      });
    },
  };
}

/**
 * Three-tier detection: resolve the first existing candidate command, run a
 * version probe with a timeout, classify available/unavailable.
 */
export async function detectCli(
  runner: CommandRunner,
  candidates: string[],
  opts: { versionArgs?: string[]; timeoutMs?: number } = {}
): Promise<DetectionResult> {
  const versionArgs = opts.versionArgs ?? ["--version"];
  const timeoutMs = opts.timeoutMs ?? 5000;
  let resolved: string | null = null;
  for (const candidate of candidates) {
    resolved = await runner.which(candidate);
    if (resolved) break;
  }
  if (!resolved) return { available: false, error: `none of [${candidates.join(", ")}] found on PATH` };

  const res = await runner.exec(resolved, versionArgs, { timeoutMs });
  if (res.timedOut) return { available: false, path: resolved, error: "version probe timed out" };
  if (res.code !== 0) return { available: false, path: resolved, error: res.stderr.trim() || `exit ${res.code}` };
  return { available: true, path: resolved, version: res.stdout.trim() || undefined };
}

export interface RegisteredProvider {
  id: string;
  detection: DetectionResult;
}

export interface ProviderRegistry {
  register(provider: Provider): void;
  get(id: string): Provider | null;
  ids(): string[];
  detectAll(): Promise<RegisteredProvider[]>;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, Provider>();
  return {
    register(provider) {
      providers.set(provider.id, provider);
    },
    get(id) {
      return providers.get(id) ?? null;
    },
    ids() {
      return [...providers.keys()];
    },
    async detectAll() {
      const out: RegisteredProvider[] = [];
      for (const provider of providers.values()) {
        out.push({ id: provider.id, detection: await provider.detect() });
      }
      return out;
    },
  };
}

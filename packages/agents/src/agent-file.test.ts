import assert from "node:assert/strict";
import test from "node:test";
import { newAgent, parseAgent, buildAgentFile } from "./agent-file.ts";

const stored = (frontmatter: Record<string, unknown>, markdown: string) =>
  ({ frontmatter: frontmatter as never, markdown });

test("round-trips an agent doc through build -> parse", () => {
  const doc = newAgent({
    id: "ag1",
    name: "Scribe",
    provider: "claude_local",
    model: "opus",
    tags: ["ops"],
    systemPrompt: "You are the scribe.\n\nKeep notes concise.",
  });
  const file = buildAgentFile(doc);
  const parsed = parseAgent(stored(file.frontmatter, file.markdown));

  assert.equal(parsed.id, "ag1");
  assert.equal(parsed.name, "Scribe");
  assert.equal(parsed.provider, "claude_local");
  assert.equal(parsed.model, "opus");
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.tags, ["ops"]);
  assert.match(parsed.systemPrompt, /You are the scribe\./);
  assert.match(parsed.systemPrompt, /Keep notes concise\./);
});

test("applies defaults when frontmatter omits optional fields", () => {
  const parsed = parseAgent(stored({ id: "a", title: "Analyst" }, "Analyze things."));
  assert.equal(parsed.name, "Analyst");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.model, undefined);
  assert.deepEqual(parsed.tags, []);
});

test("parses a hand-authored agent file (no id) and backfills an id", () => {
  const parsed = parseAgent(stored({ title: "Greeter" }, "Say hello."));
  assert.match(parsed.id, /[0-9a-f-]{8,}/);
  assert.equal(parsed.name, "Greeter");
  assert.equal(parsed.systemPrompt, "Say hello.");
});

test("enabled:false round-trips (not coerced to true)", () => {
  const file = buildAgentFile(newAgent({ name: "Paused", systemPrompt: "x", enabled: false }));
  assert.equal((file.frontmatter as Record<string, unknown>).enabled, false);
  assert.equal(parseAgent(stored(file.frontmatter, file.markdown)).enabled, false);
});

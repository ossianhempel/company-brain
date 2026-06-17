import assert from "node:assert/strict";
import test from "node:test";
import { parseConversation, buildConversationFile, type ConversationDoc } from "./conversation-file.ts";

const stored = (frontmatter: Record<string, unknown>, markdown: string) =>
  ({ frontmatter: frontmatter as never, markdown });

const base = (over: Partial<ConversationDoc> = {}): ConversationDoc => ({
  id: "c1",
  agent: "scribe",
  status: "done",
  provider: "claude_local",
  startedAt: "2026-06-17T10:00:00.000Z",
  turns: [],
  ...over,
});

test("round-trips status, timing, usage, error, and ordered turns", () => {
  const doc = base({
    job: "nightly",
    model: "opus",
    endedAt: "2026-06-17T10:01:00.000Z",
    usage: { inputTokens: 120, outputTokens: 80 },
    turns: [
      { role: "user", content: "Summarize today." },
      { role: "agent", content: "Done: 3 commits, 1 PR." },
    ],
  });
  const file = buildConversationFile(doc);
  const parsed = parseConversation(stored(file.frontmatter, file.markdown));

  assert.equal(parsed.id, "c1");
  assert.equal(parsed.agent, "scribe");
  assert.equal(parsed.job, "nightly");
  assert.equal(parsed.status, "done");
  assert.equal(parsed.model, "opus");
  assert.equal(parsed.endedAt, "2026-06-17T10:01:00.000Z");
  assert.deepEqual(parsed.usage, { inputTokens: 120, outputTokens: 80 });
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.turns[0].role, "user");
  assert.equal(parsed.turns[1].content, "Done: 3 commits, 1 PR.");
});

test("a failed conversation with an error and no result block parses", () => {
  const doc = base({ status: "failed", error: "provider unavailable", turns: [{ role: "system", content: "boot" }] });
  const file = buildConversationFile(doc);
  const parsed = parseConversation(stored(file.frontmatter, file.markdown));
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.error, "provider unavailable");
  assert.equal(parsed.turns.length, 1);
});

test("a `## ` line inside a fenced code block does not split a turn", () => {
  const doc = base({
    turns: [
      { role: "agent", content: "Here is markdown:\n\n```md\n## Not a heading\nstill the same turn\n```\n\nEnd." },
    ],
  });
  const file = buildConversationFile(doc);
  const parsed = parseConversation(stored(file.frontmatter, file.markdown));
  assert.equal(parsed.turns.length, 1); // the fenced ## did not start a new turn
  assert.match(parsed.turns[0].content, /## Not a heading/);
  assert.match(parsed.turns[0].content, /End\./);
});

test("awaiting_input status round-trips", () => {
  const doc = base({ status: "awaiting_input", turns: [{ role: "agent", content: "Need a decision." }] });
  const file = buildConversationFile(doc);
  assert.equal(parseConversation(stored(file.frontmatter, file.markdown)).status, "awaiting_input");
});

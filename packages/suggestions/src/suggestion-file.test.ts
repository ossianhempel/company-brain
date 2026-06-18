import assert from "node:assert/strict";
import test from "node:test";
import { buildSuggestionFile, parseSuggestion, type SuggestionDoc } from "./suggestion-file.ts";

const doc: SuggestionDoc = {
  id: "sg1",
  targetPageId: "page-home",
  baseOid: "abc123",
  author: "ada",
  status: "open",
  title: "Fix the intro",
  proposedMarkdown: "# Home\n\nNew intro.\n",
};

test("buildSuggestionFile → parseSuggestion round-trips", () => {
  const file = buildSuggestionFile(doc);
  const parsed = parseSuggestion({ frontmatter: file.frontmatter, markdown: file.markdown });
  assert.equal(parsed.id, "sg1");
  assert.equal(parsed.targetPageId, "page-home");
  assert.equal(parsed.baseOid, "abc123");
  assert.equal(parsed.author, "ada");
  assert.equal(parsed.status, "open");
  assert.equal(parsed.title, "Fix the intro");
  assert.match(parsed.proposedMarkdown, /New intro\./);
});

test("parseSuggestion defaults unknown status to open and missing baseOid to null", () => {
  const parsed = parseSuggestion({ frontmatter: { id: "x", status: "bogus" } as never, markdown: "body\n" });
  assert.equal(parsed.status, "open");
  assert.equal(parsed.baseOid, null);
});

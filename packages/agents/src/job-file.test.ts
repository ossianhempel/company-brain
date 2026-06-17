import assert from "node:assert/strict";
import test from "node:test";
import { parseJob, serializeJob, JobValidationError } from "./job-file.ts";

const VALID = `name: Nightly summary
enabled: true
schedule: "0 2 * * *"
provider: claude_local
agent: scribe
prompt: Summarize today's activity.
timeoutMs: 60000
onComplete:
  - extract-memory
`;

test("parses a valid job YAML into a typed JobDoc", () => {
  const job = parseJob(VALID, "nightly");
  assert.equal(job.id, "nightly"); // slug-derived (no explicit id)
  assert.equal(job.slug, "nightly");
  assert.equal(job.name, "Nightly summary");
  assert.equal(job.enabled, true);
  assert.equal(job.schedule, "0 2 * * *");
  assert.equal(job.provider, "claude_local");
  assert.equal(job.agent, "scribe");
  assert.equal(job.prompt, "Summarize today's activity.");
  assert.equal(job.timeoutMs, 60000);
  assert.deepEqual(job.onComplete, ["extract-memory"]);
});

test("rejects an invalid cron schedule, naming the field", () => {
  const raw = `schedule: "not a cron"\nagent: scribe\nprompt: do it\n`;
  assert.throws(() => parseJob(raw, "bad"), (e: Error) => e instanceof JobValidationError && /cron/.test(e.message));
});

test("rejects a job missing agent or prompt", () => {
  assert.throws(() => parseJob(`schedule: "* * * * *"\nprompt: x\n`, "noagent"), (e: Error) => /agent/.test(e.message));
  assert.throws(() => parseJob(`schedule: "* * * * *"\nagent: a\n`, "noprompt"), (e: Error) => /prompt/.test(e.message));
});

test("defaults enabled/oneShot and round-trips serialize -> parse", () => {
  const raw = `schedule: "* * * * *"\nagent: a\nprompt: p\n`;
  const job = parseJob(raw, "minimal");
  assert.equal(job.enabled, true); // default
  assert.equal(job.oneShot, false); // default
  assert.equal(job.name, "minimal"); // defaults to slug

  const reparsed = parseJob(serializeJob(job), "minimal");
  assert.deepEqual({ ...reparsed }, { ...job });
});

test("ignores unknown extra keys (forward-compat)", () => {
  const raw = `schedule: "* * * * *"\nagent: a\nprompt: p\nfutureKey: whatever\n`;
  const job = parseJob(raw, "x");
  assert.equal(job.agent, "a");
});

test("only explicit enabled:false disables", () => {
  const job = parseJob(`schedule: "* * * * *"\nagent: a\nprompt: p\nenabled: false\n`, "paused");
  assert.equal(job.enabled, false);
});

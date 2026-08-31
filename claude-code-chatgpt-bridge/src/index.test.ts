import test from "node:test";
import assert from "node:assert/strict";
import { validateRoutineUrl } from "./claude.js";

process.env.BRIDGE_ACCESS_TOKEN = "test-secret-that-is-longer-than-thirty-two-characters";
process.env.JOB_RUNNING_TIMEOUT_MS = "50";
// No REDIS_URL set here on purpose: exercises the in-memory fallback store.
const { completeJob, createJob, getJob } = await import("./jobs.js");

test("accepts an official routine fire URL", () => {
  assert.equal(
    validateRoutineUrl("https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"),
    "https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"
  );
});

test("accepts a signed Claude callback and stores its result", async () => {
  const { job, callbackToken } = await createJob();
  assert.equal(await completeJob(job.id, callbackToken, "completed", "Relatório final"), true);
  const stored = await getJob(job.id);
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.result, "Relatório final");
});

test("rejects a callback with the wrong token", async () => {
  const { job } = await createJob();
  assert.equal(await completeJob(job.id, "wrong-token-that-is-long-enough", "completed", "x"), false);
  assert.equal((await getJob(job.id))?.status, "running");
});

test("marks a stale running job as timeout instead of staying silent forever", async () => {
  const { job } = await createJob();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stale = await getJob(job.id);
  assert.equal(stale?.status, "timeout");
  assert.match(stale?.result ?? "", /tempo limite/);
});

test("a completed job is not overwritten by the timeout check", async () => {
  const { job, callbackToken } = await createJob();
  await completeJob(job.id, callbackToken, "completed", "Chegou a tempo");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const later = await getJob(job.id);
  assert.equal(later?.status, "completed");
  assert.equal(later?.result, "Chegou a tempo");
});

test("rejects arbitrary URLs and SSRF targets", () => {
  for (const value of [
    "https://evil.example/v1/claude_code/routines/trig_abc/fire",
    "http://api.anthropic.com/v1/claude_code/routines/trig_abc/fire",
    "https://api.anthropic.com.evil.example/v1/claude_code/routines/trig_abc/fire"
  ]) {
    assert.throws(() => validateRoutineUrl(value));
  }
});

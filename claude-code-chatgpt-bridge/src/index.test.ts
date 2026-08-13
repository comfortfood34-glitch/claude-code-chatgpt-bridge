import test from "node:test";
import assert from "node:assert/strict";
import { validateRoutineUrl } from "./claude.js";
import { completeJob, createJob, getJob } from "./jobs.js";

test("accepts an official routine fire URL", () => {
  assert.equal(
    validateRoutineUrl("https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"),
    "https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"
  );
});

test("accepts a signed Claude callback and stores its result", () => {
  process.env.BRIDGE_ACCESS_TOKEN = "test-secret-that-is-longer-than-thirty-two-characters";
  const { job, callbackToken } = createJob();
  assert.equal(completeJob(job.id, callbackToken, "completed", "Relatório final"), true);
  assert.equal(getJob(job.id)?.status, "completed");
  assert.equal(getJob(job.id)?.result, "Relatório final");
});

test("rejects a callback with the wrong token", () => {
  process.env.BRIDGE_ACCESS_TOKEN = "test-secret-that-is-longer-than-thirty-two-characters";
  const { job } = createJob();
  assert.equal(completeJob(job.id, "wrong-token-that-is-long-enough", "completed", "x"), false);
  assert.equal(getJob(job.id)?.status, "running");
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

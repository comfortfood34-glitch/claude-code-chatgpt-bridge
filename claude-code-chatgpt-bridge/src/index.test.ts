import test from "node:test";
import assert from "node:assert/strict";
import { validateRoutineUrl } from "./claude.js";

test("accepts an official routine fire URL", () => {
  assert.equal(
    validateRoutineUrl("https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"),
    "https://api.anthropic.com/v1/claude_code/routines/trig_abc-123/fire"
  );
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

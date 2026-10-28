import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudFollowupReady, parseProjectSessions, projectSessionId,
  queueCloudFollowup, validateCloudSessionId
} from "./cloud-followup.js";

const ZAS_SESSION = "cse_01Xqqv5uXdWN1kA21ijWz6RV";
const configured = JSON.stringify({ zas: ZAS_SESSION, kaisosystem: "session_012345ABC" });

test("resolves the same fixed cloud session for a project's follow-ups", () => {
  const sessions = parseProjectSessions(configured);
  assert.equal(sessions.zas, ZAS_SESSION);
  assert.equal(projectSessionId("zas", configured), ZAS_SESSION);
  assert.equal(projectSessionId("kaisosystem", configured), "session_012345ABC");
});

test("never silently creates or selects an alternative session", () => {
  assert.throws(() => projectSessionId("missing", configured), /project_session_not_configured/);
  assert.throws(() => projectSessionId("../zas", configured), /invalid_project/);
  assert.throws(() => projectSessionId("zas", ""), /project_session_not_configured/);
});

test("rejects invalid registry config and untrusted session identifiers", () => {
  for (const value of ["null", "[]", "{broken", '{"zas":"https://evil.example"}',
    '{"../other":"cse_123"}', '{"__proto__":"no"}']) {
    assert.throws(() => parseProjectSessions(value));
  }
  assert.throws(() => validateCloudSessionId("https://evil.com"));
  assert.throws(() => validateCloudSessionId("cse_123;touch /tmp/pwn"));
});

test("queues a follow-up to the SAME session, with exactly the supplied text", async () => {
  const seen: string[] = [];
  await queueCloudFollowup(ZAS_SESSION, "Continue o PR sem deploy", async (session, message) => {
    seen.push(session, message);
  });
  assert.deepEqual(seen, [ZAS_SESSION, "Continue o PR sem deploy"]);
});

test("invalid payload is rejected before any executor call", async () => {
  let called = false;
  const runner = async () => { called = true; };
  await assert.rejects(queueCloudFollowup("bad", "work", runner), /invalid_cloud_session_id/);
  await assert.rejects(queueCloudFollowup(ZAS_SESSION, "", runner), /invalid_followup_message/);
  await assert.rejects(queueCloudFollowup(ZAS_SESSION, "x".repeat(65_537), runner), /invalid_followup_message/);
  assert.equal(called, false);
});

test("CLI credentials are separate from the routine token", () => {
  assert.equal(cloudFollowupReady({ CLAUDE_ROUTINE_TOKEN: "routine-secret" }), false);
  assert.equal(cloudFollowupReady({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }), true);
});

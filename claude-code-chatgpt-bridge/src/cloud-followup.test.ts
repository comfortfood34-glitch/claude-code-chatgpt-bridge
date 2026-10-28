import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudFollowupReady, parseFollowupTask, parseProjectSessions, projectSessionId,
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

test("legacy project envelope explicitly binds follow-up to ZAS without a new session", () => {
  const result = parseFollowupTask("PROJECT: zas\nConfira os testes em leitura");
  assert.deepEqual(result, { project: "zas", task: "Confira os testes em leitura" });
  assert.equal(projectSessionId(result.project, configured), ZAS_SESSION);
});

test("legacy project envelope refuses ambiguous or missing routing", () => {
  for (const value of ["Confira status do ZAS", "PROJECT: zas", "PROJECT: ../zas\nx", "PROJECT: test\n "]) {
    assert.throws(() => parseFollowupTask(value), /existing_session_requires_project_prefix/);
  }
});

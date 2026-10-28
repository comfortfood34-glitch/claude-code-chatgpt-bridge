import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eligibleFile, probeGrok, redact, responseText, REVIEW_REPO, reviewPull, validSignature, webhookReview } from "./grok.js";

test("webhook signature authenticates exact bytes, fails closed", () => {
  const secret = "s".repeat(40), body = Buffer.from('{"x":1}');
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(validSignature(body, sig, secret), true);
  assert.equal(validSignature(Buffer.from('{"x":2}'), sig, secret), false);
  assert.equal(validSignature(body, sig, ""), false);
  assert.equal(validSignature(body, "sha256=oops", secret), false);
});
test("webhook accepts only PR update events for ZAS, no review-comment loops", () => {
  const body = { action: "synchronize", number: 955, repository: { full_name: REVIEW_REPO } };
  assert.equal(webhookReview("pull_request", body)?.pr_number, 955);
  assert.equal(webhookReview("issue_comment", body), null);
  assert.equal(webhookReview("pull_request", { ...body, repository: { full_name: "other/repo" } }), null);
  assert.equal(webhookReview("pull_request", { ...body, action: "closed" }), null);
});
test("obvious credentials excluded or redacted; incomplete inference is rejected", () => {
  assert.equal(eligibleFile(".env.production"), false);
  assert.equal(eligibleFile("certs/tls.key"), false);
  assert.equal(eligibleFile("src/feature.ts"), true);
  assert.ok(!redact('XAI_API_KEY=xai-1234567890123456789012345').includes("123456789"));
  assert.throws(() => responseText({ status: "incomplete", output: [] }));
});
test("read-only probe exposes only status, no key or response content", async () => {
  process.env.XAI_API_KEY = "private-test-key";
  const result = await probeGrok(async () => new Response("secret-body", { status: 401 }));
  assert.deepEqual(result, { configured: true, verified: false, code: "xai_http_401" });
});

test("review sends bounded diff to xAI, pins SHA, publishes comment without approval", async () => {
  process.env.XAI_API_KEY = "private-test-key";
  process.env.GROK_GITHUB_TOKEN = "private-github-test";
  const calls: { url: string; body: string }[] = [], sha = "a".repeat(40);
  const net: typeof fetch = async (url, init) => {
    const u = String(url); calls.push({ url: u, body: String(init?.body ?? "") });
    if (u.includes("/files?")) return Response.json([{ filename: "src/f.ts", status: "modified", changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" }, { filename: ".env", status: "modified", changes: 1, patch: "+SECRET=never-send-this" }]);
    if (u === "https://api.x.ai/v1/responses") return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Revisão parcial", findings: [{ severity: "high", file: "src/f.ts", line: 1, problem: "Erro", recommendation: "Corrigir" }], limitations: ["Sem testes"] }) }] }] });
    if (u.endsWith("/comments")) return Response.json({ id: 1 });
    return Response.json({ number: 955, state: "open", title: "PR", head: { sha } });
  };
  const result = await reviewPull({ repository: REVIEW_REPO, pr_number: 955, publish: true }, net);
  assert.equal(result.published, true);
  assert.equal(result.sha, sha);
  const request = JSON.parse(calls.find(c => c.url.includes("api.x.ai"))!.body);
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.equal(request.reasoning.effort, "low");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.tools, undefined);
  assert.ok(!JSON.stringify(request).includes("never-send-this"));
  assert.ok(result.report.includes(".env"));
  assert.equal(calls.filter(c => c.url.endsWith("/comments")).length, 1);
  assert.ok(!calls.some(c => /\/reviews|\/merge/.test(c.url)));
});

test("new HEAD during analysis prevents publishing a stale review", async () => {
  let reads = 0, comments = 0;
  const net: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes("/files?")) return Response.json([{ filename: "f.ts", status: "modified", changes: 1, patch: "+x" }]);
    if (u.includes("api.x.ai")) return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Recorte", findings: [], limitations: [] }) }] }] });
    if (u.endsWith("/comments")) { comments++; return Response.json({}); }
    return Response.json({ number: 955, state: "open", title: "PR", head: { sha: (++reads <= 2 ? "a" : "b").repeat(40) } });
  };
  const result = await reviewPull({ repository: REVIEW_REPO, pr_number: 955, publish: true }, net);
  assert.equal(result.stale, true);
  assert.equal(result.published, false);
  assert.equal(comments, 0);
});


test("daily budget receipt is terminal skipped, not a retryable queue error", async () => {
  const { queueReceipt, safeReviewError } = await import("./grok-queue.js");
  assert.deepEqual(queueReceipt("budget_limit"), { job_id: null, state: "skipped", reason: "grok_daily_review_limit" });
  assert.equal(safeReviewError(new Error("no_reviewable_diff")), "no_reviewable_diff");
  assert.equal(safeReviewError(new Error("secret=private-value")), "review_failed_no_automatic_retry");
});

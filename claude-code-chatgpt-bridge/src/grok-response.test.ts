import { test } from "node:test";
import assert from "node:assert/strict";
import { readResponse, requestVerdict, splitDiffs } from "./grok-response.js";
import { reviewPull, REVIEW_REPO, type ReviewProgress } from "./grok.js";

const verdict = { summary: "Bloco revisado", findings: [], limitations: ["Sem executar testes"] };
const completion = { status: "completed", output: [{ type: "reasoning", encrypted_content: "ignore" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] };

test("fragmented SSE handles partial UTF-8/frames/CRLF and requires completed event", async () => {
  const bytes = new TextEncoder().encode('data: {"type":"response.created"}\r\n\r\ndata: ' + JSON.stringify({ type: "response.completed", response: completion }) + '\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i,i+7)); c.close(); } });
  assert.deepEqual(await readResponse(new Response(stream, { headers: { "Content-Type": "text/event-stream" } })), completion);
  await assert.rejects(readResponse(new Response('data: {"type":"response.created"}\n\n', { headers: { "Content-Type": "text/event-stream" } })), /ended_without_completion/);
});

test("chunking bounds every request without silently dropping a large file", () => {
  const patch = "one line\n".repeat(100), diff = { file: "large.ts", status: "modified", patch };
  const groups = splitDiffs([diff, { file: "other.ts", status: "added", patch: "+x" }], 100);
  assert.ok(groups.length > 1);
  for (const group of groups) assert.ok(group.reduce((n,d) => n+d.patch.length, 0) <= 100);
  assert.equal(groups.flat().filter(d => d.file === "large.ts").map(d => d.patch).join(""), patch);
});

test("provider timeout/invalid JSON/HTTP code are precise and sanitized", async () => {
  await assert.rejects(requestVerdict({}, async () => { throw new DOMException("potentially sensitive", "TimeoutError"); }), /xai_request_timeout/);
  await assert.rejects(requestVerdict({}, async () => new Response("private provider error", { status: 403 })), /^Error: xai_http_403$/);
  await assert.rejects(requestVerdict({}, async () => Response.json({ ...completion, output: [{ type: "message", content: [{ type: "output_text", text: "not-json" }] }] })), /grok_invalid_json/);
});

test("completed chunks are checkpointed before a later failure; no incomplete review is published", async () => {
  process.env.XAI_API_KEY = "private-test"; process.env.GROK_GITHUB_TOKEN = "private-test";
  let calls = 0, comments = 0;
  const checkpoints: ReviewProgress[] = [];
  const net: typeof fetch = async url => {
    const u = String(url);
    if (u.includes("/files?")) return Response.json([{ filename: "large.ts", status: "modified", changes: 500, patch: "+value\n".repeat(4000) }]);
    if (u.includes("api.x.ai")) { if (++calls === 2) throw new DOMException("expired", "TimeoutError"); return Response.json(completion); }
    if (u.endsWith("/comments")) { comments++; return Response.json({}); }
    return Response.json({ number: 955, state: "open", title: "PR", head: { sha: "a".repeat(40) } });
  };
  await assert.rejects(reviewPull({ repository: REVIEW_REPO, pr_number: 955, publish: true }, net, async p => { checkpoints.push(p); }), /xai_request_timeout/);
  assert.equal(checkpoints.at(-1)?.completed, 1);
  assert.equal(checkpoints.at(-1)?.chunk_results[0].summary, verdict.summary);
  assert.equal(comments, 0);
});


test("publication denial preserves the final report checkpoint without another inference", async () => {
  let calls = 0;
  let saved: ReviewProgress | undefined;
  const net: typeof fetch = async url => {
    const u = String(url);
    if (u.includes("/files?")) return Response.json([{ filename: "f.ts", status: "modified", changes: 1, patch: "+x" }]);
    if (u.includes("api.x.ai")) { calls++; return Response.json(completion); }
    if (u.endsWith("/comments")) return new Response("private provider response", { status: 403 });
    return Response.json({ number: 955, state: "open", title: "PR", head: { sha: "a".repeat(40) } });
  };
  await assert.rejects(reviewPull({ repository: REVIEW_REPO, pr_number: 955, publish: true }, net, async p => { saved = p; }), /github_http_403/);
  assert.equal(calls, 1);
  assert.equal(saved?.stage, "publishing_report");
  assert.ok(saved?.report?.includes("Grok"));
  assert.ok(saved?.report?.includes("Bloco revisado"));
});

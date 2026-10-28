import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Verdict, responseText, requestVerdict, splitDiffs } from "./grok-response.js";
export { Verdict, responseText } from "./grok-response.js";

export const REVIEW_REPO = "comfortfood34-glitch/soyzas";
export const ReviewRequest = z.object({ repository: z.literal(REVIEW_REPO), pr_number: z.number().int().positive(), publish: z.boolean().default(true) });
export type ReviewInput = z.infer<typeof ReviewRequest>;
type Net = typeof fetch;
const File = z.object({ filename: z.string(), status: z.string(), patch: z.string().optional(), changes: z.number() });
const Pull = z.object({ number: z.number(), state: z.string(), title: z.string(), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) });


export function validSignature(body: Buffer, header: string, secret: string) {
  if (secret.length < 32 || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
export function webhookReview(event: string, body: unknown): ReviewInput | null {
  if (event !== "pull_request") return null;
  const parsed = z.object({ action: z.enum(["opened", "reopened", "synchronize", "ready_for_review"]), number: z.number().int().positive(), repository: z.object({ full_name: z.literal(REVIEW_REPO) }) }).safeParse(body);
  return parsed.success ? { repository: REVIEW_REPO, pr_number: parsed.data.number, publish: true } : null;
}
export function redact(text: string) {
  return text.replace(/\b(?:xai-|sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]{15,}/g, "[REDACTED]")
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/-]{15,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',;]{8,}/gi, "$1[REDACTED]");
}
export function eligibleFile(path: string) {
  return !/(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|(?:^|\/)(?:credentials|secrets)(?:\.|\/|$)/i.test(path);
}
export function grokConfiguration() {
  return { xai_key_present: Boolean(process.env.XAI_API_KEY), github_token_present: Boolean(process.env.GROK_GITHUB_TOKEN), webhook_secret_present: (process.env.GROK_WEBHOOK_SECRET?.length ?? 0) >= 32, polling_enabled: process.env.GROK_POLL_ENABLED === "true", persistent_queue: Boolean(process.env.REDIS_URL), model: process.env.XAI_REVIEW_MODEL ?? "grok-4.7", repository: REVIEW_REPO };
}
async function github(path: string, net: Net, init?: RequestInit) {
  const token = process.env.GROK_GITHUB_TOKEN;
  if (!token) throw new Error("grok_github_token_missing");
  const r = await net("https://api.github.com/repos/" + REVIEW_REPO + path, { ...init, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!r.ok) throw new Error("github_http_" + r.status);
  return r.json();
}
export async function probeGrok(net: Net = fetch) {
  if (!process.env.XAI_API_KEY) return { configured: false, verified: false, code: "xai_key_missing" };
  try {
    const r = await net("https://api.x.ai/v1/models", { headers: { Authorization: "Bearer " + process.env.XAI_API_KEY }, signal: AbortSignal.timeout(20_000), redirect: "error" });
    return { configured: true, verified: r.ok, code: r.ok ? "models_access_ok_not_inference_test" : "xai_http_" + r.status };
  } catch { return { configured: true, verified: false, code: "xai_network_error" }; }
}
export async function listOpenReviewTargets(net: Net = fetch) {
  return z.array(Pull).parse(await github("/pulls?state=open&per_page=100&sort=updated&direction=desc", net))
    .map(p => ({ pr_number: p.number, sha: p.head.sha }));
}
export async function logGrokReadiness() {
  if (!process.env.XAI_API_KEY && !process.env.GROK_GITHUB_TOKEN) return;
  let githubCode = "github_token_missing";
  if (process.env.GROK_GITHUB_TOKEN) {
    try { await listOpenReviewTargets(); githubCode = "github_pr_read_ok_write_not_tested"; }
    catch (e) { githubCode = e instanceof Error && /^github_http_\d{3}$/.test(e.message) ? e.message : "github_probe_failed"; }
  }
  console.log(JSON.stringify({ event: "grok_readiness", ...grokConfiguration(), xai_probe: await probeGrok(), github_probe: githubCode }));
}

export type ReviewProgress = { sha: string; stage: string; total: number; completed: number; chunk_results: z.infer<typeof Verdict>[]; report?: string };
export async function reviewPull(input: ReviewInput, net: Net = fetch, progress: (p: ReviewProgress) => Promise<void> = async () => {}) {
  ReviewRequest.parse(input);
  if (!process.env.XAI_API_KEY) throw new Error("xai_key_missing");
  const pull = Pull.parse(await github(`/pulls/${input.pr_number}`, net));
  if (pull.state !== "open") throw new Error("pull_request_not_open");
  const files: z.infer<typeof File>[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = z.array(File).parse(await github(`/pulls/${input.pr_number}/files?per_page=100&page=${page}`, net));
    files.push(...batch);
    if (batch.length < 100) break;
    if (page === 3) throw new Error("pull_request_too_large_split_review");
  }
  const omitted: string[] = [];
  let remaining = 100_000;
  const diffs = files.flatMap(f => {
    if (!eligibleFile(f.filename) || !f.patch || f.patch.length > remaining) { omitted.push(f.filename); return []; }
    remaining -= f.patch.length;
    return [{ file: f.filename, status: f.status, patch: redact(f.patch) }];
  });
  if (!diffs.length) throw new Error("no_reviewable_diff");
  const groups = splitDiffs(diffs), verdicts: z.infer<typeof Verdict>[] = [];
  const checkpoint = async (stage: string, report?: string) => progress(JSON.parse(redact(JSON.stringify({ sha: pull.head.sha, stage, total: groups.length, completed: verdicts.length, chunk_results: verdicts, ...(report ? { report } : {}) }))));
  for (let index = 0; index < groups.length; index++) {
    const latest = Pull.parse(await github(`/pulls/${input.pr_number}`, net));
    if (latest.head.sha !== pull.head.sha || latest.state !== "open") throw new Error("grok_head_changed_during_review");
    await checkpoint("analyzing_chunk_" + (index + 1));
    const verdict = await requestVerdict({ repository: REVIEW_REPO, pr: input.pr_number, head: pull.head.sha, chunk: index + 1, total: groups.length, diffs: groups[index] }, net);
    const included = new Set(groups[index].map(f => f.file));
    if (verdict.findings.some(f => !included.has(f.file))) throw new Error("grok_finding_outside_reviewed_files");
    verdicts.push(verdict);
    await checkpoint("chunk_saved");
  }
  const verdict = { summary: verdicts.map((v,i) => `Bloco ${i+1}/${groups.length}: ${v.summary}`).join("\n"), findings: verdicts.flatMap(v => v.findings), limitations: [...new Set(verdicts.flatMap(v => v.limitations))] };
  const current = Pull.parse(await github(`/pulls/${input.pr_number}`, net));
  const stale = current.head.sha !== pull.head.sha || current.state !== "open";
  const report = redact([`## Grok — revisão do diff`, `Commit analisado: \`${pull.head.sha}\``, stale ? "**DESATUALIZADA: a PR mudou durante a análise. Não usar como validação do HEAD atual.**" : "", `Cobertura: ${groups.length}/${groups.length} blocos concluídos; raciocínio low explícito. Revisão fragmentada pode perder relações entre arquivos.`, verdict.summary,
    ...verdict.findings.map(f => `- **${f.severity}** — \`${f.file}${f.line ? ":" + f.line : ""}\`: ${f.problem}\n  Correção sugerida: ${f.recommendation}`),
    verdict.findings.length ? "" : "Nenhum achado retornado neste recorte; isso não comprova ausência de falhas.",
    "### Limitações", "Análise automatizada de diffs, sem execução de testes e sem acesso ao contexto completo. Não autoriza merge ou deploy.",
    ...verdict.limitations, omitted.length ? "Arquivos não analisados: " + omitted.map(p => "`" + p + "`").join(", ") : "Todos os patches retornados pelo GitHub foram incluídos; o GitHub pode omitir conteúdo de patches grandes."
  ].filter(Boolean).join("\n\n")).slice(0, 55_000);
  await checkpoint("publishing_report", report);
  if (input.publish && !stale) await github(`/issues/${input.pr_number}/comments`, net, { method: "POST", body: JSON.stringify({ body: report }) });
  return { sha: pull.head.sha, stale, published: input.publish && !stale, report };
}

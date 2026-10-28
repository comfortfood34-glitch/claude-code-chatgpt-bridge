import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { REVIEW_REPO, ReviewRequest, reviewPull, listOpenReviewTargets, type ReviewInput, type ReviewProgress } from "./grok.js";

type ReviewJob = { id: string; input: ReviewInput; state: "queued" | "running" | "completed" | "error"; created_at: string; updated_at: string; result?: Awaited<ReturnType<typeof reviewPull>>; error?: string; progress?: ReviewProgress };
let connection: ReturnType<typeof createClient> | undefined;
let ready: Promise<unknown> | undefined;
async function redis() {
  if (!process.env.REDIS_URL) throw new Error("grok_persistent_queue_missing");
  if (!connection) {
    connection = createClient({ url: process.env.REDIS_URL });
    connection.on("error", () => console.error(JSON.stringify({ event: "grok_queue_connection_error" })));
    ready = connection.connect();
  }
  await ready;
  return connection;
}
export function queueReceipt(result: unknown) {
  return result === "budget_limit"
    ? { job_id: null, state: "skipped", reason: "grok_daily_review_limit" }
    : { job_id: String(result), state: "queued" };
}
export function safeReviewError(error: unknown) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "github_request_timeout";
  if (error instanceof TypeError) return "github_network_error";
  const message = error instanceof Error ? error.message : "";
  return /^(?:(?:xai_|github_|grok_|pull_request_)[a-z0-9_]+|no_reviewable_diff)$/.test(message) ? message : "review_failed_no_automatic_retry";
}
const key = (id: string) => "bridge:grok:job:" + id;
const TTL = 7 * 24 * 3600;
export async function enqueueReview(input: ReviewInput, delivery: string = randomUUID()) {
  ReviewRequest.parse(input);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(delivery)) throw new Error("invalid_delivery_id");
  if (!process.env.XAI_API_KEY || !process.env.GROK_GITHUB_TOKEN) throw new Error("grok_review_credentials_missing");
  const db = await redis();
  const id = randomUUID(), now = new Date().toISOString();
  const job: ReviewJob = { id, input, state: "queued", created_at: now, updated_at: now };
  // Atomic delivery deduplication + storage + enqueue. No acknowledged job exists only in memory.
  const result = await db.eval(`local prior = redis.call('GET',KEYS[1])
    if prior and not (prior == 'budget_limit' and ARGV[5] == 'poll') then return prior end
    local count = tonumber(redis.call('GET',KEYS[4]) or '0')
    if count >= tonumber(ARGV[4]) then redis.call('SET',KEYS[1],'budget_limit','EX',ARGV[3]); return 'budget_limit' end
    redis.call('INCR',KEYS[4]); redis.call('EXPIRE',KEYS[4],172800)
    redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[3])
    redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3])
    redis.call('RPUSH',KEYS[3],ARGV[1]); return ARGV[1]`, {
    keys: ["bridge:grok:delivery:" + delivery, key(id), "bridge:grok:pending", "bridge:grok:budget:" + now.slice(0, 10)],
    arguments: [id, JSON.stringify(job), String(TTL), String(Math.min(100, Math.max(1, Number(process.env.GROK_MAX_REVIEWS_PER_DAY) || 20))), delivery.startsWith("poll-") ? "poll" : "webhook"]
  });
  return queueReceipt(result);
}
export async function getReviewJob(id: string): Promise<ReviewJob | null> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
  const db = await redis(), raw = await db.get(key(id));
  if (!raw) return null;
  const job = JSON.parse(raw) as ReviewJob;
  if (job.state === "running" && Date.now() - Date.parse(job.updated_at) > 20 * 60_000) {
    job.state = "error"; job.error = "worker_interrupted_or_timed_out_no_automatic_retry";
    await db.set(key(id), JSON.stringify(job), { EX: TTL });
  }
  return job;
}
export async function reviewQueueStatus() {
  const db = await redis();
  const jobs = [];
  for await (const k of db.scanIterator({ MATCH: "bridge:grok:job:*", COUNT: 100 })) {
    const job = await getReviewJob(k.slice("bridge:grok:job:".length));
    if (job) jobs.push({ id: job.id, pr: job.input.pr_number, state: job.state, created_at: job.created_at, updated_at: job.updated_at, error: job.error ?? null, sha: job.result?.sha ?? null, published: job.result?.published ?? false, stage: job.progress?.stage ?? null, chunks: job.progress ? `${job.progress.completed}/${job.progress.total}` : null });
    if (jobs.length >= 100) break;
  }
  return { pending: await db.lLen("bridge:grok:pending"), worker_lease_seconds: await db.ttl("bridge:grok:worker"), jobs: jobs.sort((a,b) => b.created_at.localeCompare(a.created_at)) };
}
let active = false;
async function tick() {
  if (active || !process.env.REDIS_URL || !process.env.XAI_API_KEY || !process.env.GROK_GITHUB_TOKEN) return;
  active = true;
  const lease = randomUUID();
  try {
    const db = await redis();
    if (!await db.set("bridge:grok:worker", lease, { NX: true, EX: 120 })) return;
    try {
      const claimed = await db.eval(`local id = redis.call('LPOP',KEYS[1])
        if not id then return nil end
        local k = ARGV[1] .. id
        local raw = redis.call('GET',k)
        if not raw then return nil end
        local job = cjson.decode(raw)
        if job.state ~= 'queued' then return nil end
        job.state = 'running'; job.updated_at = ARGV[2]
        local encoded = cjson.encode(job)
        redis.call('SET',k,encoded,'EX',ARGV[3]); return encoded`, {
          keys: ["bridge:grok:pending"], arguments: ["bridge:grok:job:", new Date().toISOString(), String(TTL)]
        });
      if (typeof claimed !== "string") return;
      const job = JSON.parse(claimed) as ReviewJob;
      const id = job.id;
      const heartbeat = setInterval(() => {
        void db.eval(`if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
          redis.call('EXPIRE',KEYS[1],120)
          local raw = redis.call('GET',KEYS[2])
          if raw then local j = cjson.decode(raw)
            if j.state == 'running' then j.updated_at = ARGV[2]; redis.call('SET',KEYS[2],cjson.encode(j),'EX',ARGV[3]) end end
          return 1`, { keys: ["bridge:grok:worker", key(id)], arguments: [lease, new Date().toISOString(), String(TTL)] })
          .catch(() => console.error(JSON.stringify({ event: "grok_heartbeat_failed", job_id: id })));
      }, 30_000);
      heartbeat.unref();
      try {
        job.result = await reviewPull(job.input, fetch, async p => {
          job.progress = p; job.updated_at = new Date().toISOString();
          await db.set(key(id), JSON.stringify(job), { EX: TTL });
          console.log(JSON.stringify({ event: "grok_review_progress", job_id: id, pr: job.input.pr_number, stage: p.stage, completed: p.completed, total: p.total, sha: p.sha }));
        });
        job.state = "completed";
      } catch (e) { job.state = "error"; job.error = safeReviewError(e); }
      finally { clearInterval(heartbeat); }
      job.updated_at = new Date().toISOString();
      await db.set(key(id), JSON.stringify(job), { EX: TTL });
      console.log(JSON.stringify({ event: "grok_review_finished", job_id: id, pr: job.input.pr_number, state: job.state, sha: job.result?.sha ?? null, published: job.result?.published ?? false, error: job.error ?? null }));
    } finally {
      await db.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", { keys: ["bridge:grok:worker"], arguments: [lease] });
    }
  } catch { console.error(JSON.stringify({ event: "grok_queue_processing_error" })); }
  finally { active = false; }
}
let polling = false;
async function poll() {
  if (polling || process.env.GROK_POLL_ENABLED !== "true" || !process.env.REDIS_URL || !process.env.XAI_API_KEY || !process.env.GROK_GITHUB_TOKEN) return;
  polling = true;
  try {
    for (const pr of await listOpenReviewTargets()) {
      const receipt = await enqueueReview({ repository: REVIEW_REPO, pr_number: pr.pr_number, publish: true }, `poll-${pr.pr_number}-${pr.sha}`);
      if (receipt.state === "skipped") break;
    }
  } catch { console.error(JSON.stringify({ event: "grok_poll_failed" })); }
  finally { polling = false; }
}
export function startGrokWorker() {
  setInterval(() => void tick(), 5000).unref();
  setInterval(() => void poll(), 60_000).unref();
}

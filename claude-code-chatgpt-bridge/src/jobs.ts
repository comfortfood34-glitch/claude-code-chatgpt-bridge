import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export type JobStatus = "running" | "completed" | "error" | "timeout";
export type ClaudeJob = {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  sessionId?: string;
  sessionUrl?: string;
  result?: string;
};

const MAX_RESULT_LENGTH = 60_000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const RUNNING_TIMEOUT_MS = Number(process.env.JOB_RUNNING_TIMEOUT_MS ?? 20 * 60 * 1000);

function secret(): string {
  const value = process.env.BRIDGE_ACCESS_TOKEN;
  if (!value || value.length < 32) throw new Error("BRIDGE_ACCESS_TOKEN must be at least 32 characters.");
  return value;
}

function signature(jobId: string): string {
  return createHmac("sha256", secret()).update(`claude-result:${jobId}`).digest("base64url");
}

// Job storage is pluggable: Redis in production (survives restarts/deploys),
// in-memory only as a local-dev fallback when REDIS_URL is not set.
interface JobStore {
  get(id: string): Promise<ClaudeJob | undefined>;
  set(job: ClaudeJob): Promise<void>;
}

class MemoryStore implements JobStore {
  private jobs = new Map<string, ClaudeJob>();
  async get(id: string) {
    const job = this.jobs.get(id);
    if (job && job.expiresAt <= Date.now()) { this.jobs.delete(id); return undefined; }
    return job;
  }
  async set(job: ClaudeJob) { this.jobs.set(job.id, job); }
}

class RedisStore implements JobStore {
  private client: RedisClientType;
  private ready: Promise<unknown>;
  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) =>
      console.error(JSON.stringify({ event: "redis_error", message: err instanceof Error ? err.message : String(err) }))
    );
    this.ready = this.client.connect();
  }
  private key(id: string) { return `bridge:job:${id}`; }
  async get(id: string) {
    await this.ready;
    const raw = await this.client.get(this.key(id));
    return raw ? (JSON.parse(raw) as ClaudeJob) : undefined;
  }
  async set(job: ClaudeJob) {
    await this.ready;
    const ttlSeconds = Math.max(1, Math.ceil((job.expiresAt - Date.now()) / 1000));
    await this.client.set(this.key(job.id), JSON.stringify(job), { EX: ttlSeconds });
  }
}

function buildStore(): JobStore {
  const url = process.env.REDIS_URL;
  return url ? new RedisStore(url) : new MemoryStore();
}

const store: JobStore = buildStore();

function applyTimeout(job: ClaudeJob): ClaudeJob {
  if (job.status === "running" && Date.now() - new Date(job.createdAt).getTime() > RUNNING_TIMEOUT_MS) {
    return {
      ...job,
      status: "timeout",
      result: "A sessão do Claude Code excedeu o tempo limite sem enviar um relatório final. Verifique a sessão diretamente ou tente novamente.",
      updatedAt: new Date().toISOString()
    };
  }
  return job;
}

export async function createJob(): Promise<{ job: ClaudeJob; callbackToken: string }> {
  const now = new Date().toISOString();
  const job: ClaudeJob = { id: randomUUID(), status: "running", createdAt: now, updatedAt: now, expiresAt: Date.now() + JOB_TTL_MS };
  await store.set(job);
  return { job: { ...job }, callbackToken: signature(job.id) };
}

export async function attachSession(jobId: string, sessionId: string, sessionUrl: string): Promise<void> {
  const job = await store.get(jobId);
  if (!job) return;
  job.sessionId = sessionId;
  job.sessionUrl = sessionUrl;
  job.updatedAt = new Date().toISOString();
  await store.set(job);
}

export async function failJob(jobId: string, message: string): Promise<void> {
  const job = await store.get(jobId);
  if (!job) return;
  job.status = "error";
  job.result = message.slice(0, MAX_RESULT_LENGTH);
  job.updatedAt = new Date().toISOString();
  await store.set(job);
}

export async function completeJob(jobId: string, token: string, status: "completed" | "error", result: string): Promise<boolean> {
  const job = await store.get(jobId);
  if (!job) return false;
  const supplied = Buffer.from(token);
  const expected = Buffer.from(signature(jobId));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  job.status = status;
  job.result = result.slice(0, MAX_RESULT_LENGTH);
  job.updatedAt = new Date().toISOString();
  await store.set(job);
  return true;
}

export async function getJob(jobId: string): Promise<ClaudeJob | undefined> {
  const job = await store.get(jobId);
  if (!job) return undefined;
  const withTimeout = applyTimeout(job);
  if (withTimeout.status !== job.status) await store.set(withTimeout);
  return withTimeout;
}

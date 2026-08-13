import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type JobStatus = "running" | "completed" | "error";
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

const jobs = new Map<string, ClaudeJob>();
const MAX_RESULT_LENGTH = 60_000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function secret(): string {
  const value = process.env.BRIDGE_ACCESS_TOKEN;
  if (!value || value.length < 32) throw new Error("BRIDGE_ACCESS_TOKEN must be at least 32 characters.");
  return value;
}

function signature(jobId: string): string {
  return createHmac("sha256", secret()).update(`claude-result:${jobId}`).digest("base64url");
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt <= now) jobs.delete(id);
}

export function createJob(): { job: ClaudeJob; callbackToken: string } {
  purgeExpired();
  const now = new Date().toISOString();
  const job: ClaudeJob = {
    id: randomUUID(), status: "running", createdAt: now, updatedAt: now,
    expiresAt: Date.now() + JOB_TTL_MS
  };
  jobs.set(job.id, job);
  return { job: { ...job }, callbackToken: signature(job.id) };
}

export function attachSession(jobId: string, sessionId: string, sessionUrl: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.sessionId = sessionId;
  job.sessionUrl = sessionUrl;
  job.updatedAt = new Date().toISOString();
}

export function failJob(jobId: string, message: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "error";
  job.result = message.slice(0, MAX_RESULT_LENGTH);
  job.updatedAt = new Date().toISOString();
}

export function completeJob(jobId: string, token: string, status: "completed" | "error", result: string): boolean {
  purgeExpired();
  const job = jobs.get(jobId);
  if (!job) return false;
  const supplied = Buffer.from(token);
  const expected = Buffer.from(signature(jobId));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  job.status = status;
  job.result = result.slice(0, MAX_RESULT_LENGTH);
  job.updatedAt = new Date().toISOString();
  return true;
}

export function getJob(jobId: string): ClaudeJob | undefined {
  purgeExpired();
  const job = jobs.get(jobId);
  return job ? { ...job } : undefined;
}

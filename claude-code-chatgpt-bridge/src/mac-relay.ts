import { timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { validateCloudSessionId } from "./cloud-followup.js";

export type RelayTask = {
  id: string;
  sessionId: string;
  message: string;
  state: "queued" | "claimed" | "sent" | "failed";
  createdAt: string;
  updatedAt: string;
};

const QUEUE = "bridge:mac-relay:queue";
const LAST_SEEN = "bridge:mac-relay:last-seen";
const TTL_SECONDS = 7 * 24 * 3600;
type MacRedisClient = ReturnType<typeof createClient>;
let client: MacRedisClient | undefined;
let pending: Promise<unknown> | undefined;

function taskKey(id: string): string { return "bridge:mac-relay:task:" + id; }

async function redis(): Promise<MacRedisClient> {
  if (!process.env.REDIS_URL) throw new Error("mac_relay_requires_redis");
  if (!client) {
    const instance = createClient({ url: process.env.REDIS_URL });
    instance.on("error", () => { /* Connection errors are handled by Redis calls. */ });
    client = instance;
    pending = instance.connect();
  }
  await pending;
  return client!;
}

export function authorizedRelayToken(provided: string, configured = process.env.CLAUDE_MAC_RELAY_TOKEN): boolean {
  if (!configured || configured.length < 40) return false;
  const a = Buffer.from(provided), b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validRelayId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export async function enqueueMacFollowup(id: string, sessionId: string, message: string): Promise<void> {
  if (!validRelayId(id)) throw new Error("invalid_relay_job_id");
  validateCloudSessionId(sessionId);
  if (!message.trim() || message.length > 65_536) throw new Error("invalid_relay_message");
  const db = await redis();
  const now = new Date().toISOString();
  const job: RelayTask = { id, sessionId, message, state: "queued", createdAt: now, updatedAt: now };
  await db.multi()
    .set(taskKey(id), JSON.stringify(job), { EX: TTL_SECONDS })
    .rPush(QUEUE, id)
    .exec();
}

export async function claimMacFollowup(): Promise<RelayTask | undefined> {
  const db = await redis();
  await db.set(LAST_SEEN, new Date().toISOString(), { EX: 3 * 24 * 3600 });
  // LPOP is atomic. Do not requeue claimed requests: duplicate instructions are
  // more dangerous than requiring an explicit retry after a Mac crash.
  for (let i = 0; i < 5; i++) {
    const id = await db.lPop(QUEUE);
    if (!id) return;
    const raw = await db.get(taskKey(id));
    if (!raw) continue;
    const job = JSON.parse(raw) as RelayTask;
    if (job.state !== "queued" || !validRelayId(job.id)) continue;
    const claimed: RelayTask = { ...job, state: "claimed", updatedAt: new Date().toISOString() };
    await db.set(taskKey(id), JSON.stringify(claimed), { EX: TTL_SECONDS });
    return claimed;
  }
  return;
}

export async function ackMacFollowup(id: string, ok: boolean, error?: string): Promise<"sent" | "failed" | "ignored"> {
  if (!validRelayId(id)) return "ignored";
  const db = await redis();
  const raw = await db.get(taskKey(id));
  if (!raw) return "ignored";
  const job = JSON.parse(raw) as RelayTask;
  if (job.state === "sent" || job.state === "failed") return job.state;
  if (job.state !== "claimed") return "ignored";
  const state = ok ? "sent" : "failed";
  // Errors are constrained to machine-readable safe codes. No CLI stdout/stderr.
  const classification = !ok && /^claude_relay_[a-z0-9_]{1,60}$/.test(error ?? "")
    ? error : "claude_relay_dispatch_error";
  const updated = { ...job, state, updatedAt: new Date().toISOString(),
    ...(ok ? {} : { error: classification }) };
  await db.set(taskKey(id), JSON.stringify(updated), { EX: TTL_SECONDS });
  return state;
}

export async function readMacRelayState(): Promise<{ enabled: boolean; lastSeen: string | null; active: boolean }> {
  if (!process.env.CLAUDE_MAC_RELAY_TOKEN || !process.env.REDIS_URL) {
    return { enabled: false, lastSeen: null, active: false };
  }
  const db = await redis();
  const lastSeen = await db.get(LAST_SEEN);
  return { enabled: true, lastSeen, active: !!lastSeen && Date.now() - Date.parse(lastSeen) < 90_000 };
}

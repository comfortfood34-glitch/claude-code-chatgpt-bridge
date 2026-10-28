import { spawn } from "node:child_process";

const SESSION_ID = /^(?:cse|session)_[A-Za-z0-9]+$/;
const PROJECT_ID = /^[a-z][a-z0-9_-]{0,47}$/;

export function validateCloudSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error("invalid_cloud_session_id");
  return value;
}

/**
 * Configuration is intentionally owned by the server, not the caller:
 * the ChatGPT tool cannot redirect messages to arbitrary Claude sessions.
 * This is a stable registry across Render restarts and deploys.
 */
export function parseProjectSessions(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("invalid_project_sessions_configuration"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_project_sessions_configuration");
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [project, session] of Object.entries(parsed)) {
    if (!PROJECT_ID.test(project) || typeof session !== "string") {
      throw new Error("invalid_project_sessions_configuration");
    }
    result[project] = validateCloudSessionId(session);
  }
  return result;
}

/** Explicit compatibility envelope for old ChatGPT connectors whose tool schema is cached. */
export function parseFollowupTask(value: string): { project: string; task: string } {
  const match = /^PROJECT:[ \t]*([a-z][a-z0-9_-]{0,47})[ \t]*\r?\n([\s\S]+)$/i.exec(value);
  if (!match || !match[2].trim()) throw new Error("existing_session_requires_project_prefix");
  return { project: match[1].toLowerCase(), task: match[2] };
}

export function projectSessionId(project: string, raw = process.env.CLAUDE_PROJECT_SESSIONS): string {
  if (!PROJECT_ID.test(project)) throw new Error("invalid_project");
  const sessionId = parseProjectSessions(raw)[project];
  if (!sessionId) throw new Error("project_session_not_configured");
  return sessionId;
}

export function cloudFollowupReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || (env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN?.trim() && env.CLAUDE_CODE_OAUTH_SCOPES?.trim()));
}

export type CloudFollowupRunner = (sessionId: string, message: string) => Promise<void>;

/**
 * Claude Code official CLI queues into an EXISTING cloud session when
 * invoked as: claude -p --cloud <session_id> with message on stdin.
 * Never use the routine-fire endpoint for follow-ups; it creates a new session.
 */
export async function queueCloudFollowup(
  sessionId: string,
  message: string,
  runner: CloudFollowupRunner = runClaudeCli
): Promise<void> {
  validateCloudSessionId(sessionId);
  if (!message.trim() || message.length > 65_536) throw new Error("invalid_followup_message");
  await runner(sessionId, message);
}

async function runClaudeCli(sessionId: string, message: string): Promise<void> {
  if (!cloudFollowupReady()) throw new Error("claude_cli_auth_missing");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("claude", ["-p", "--cloud", sessionId], {
      shell: false,
      stdio: "pipe",
      env: process.env
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("claude_cli_timeout"));
    }, 45_000);
    // Drain streams but NEVER log output: it may contain user data or secrets.
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", error => finish(new Error(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "claude_cli_not_installed" : "claude_cli_spawn_failed"
    )));
    child.once("close", code => finish(code === 0 ? undefined : new Error("claude_cli_send_failed")));
    child.stdin.on("error", () => { /* The close handler reports the failure. */ });
    child.stdin.end(message);
  });
}

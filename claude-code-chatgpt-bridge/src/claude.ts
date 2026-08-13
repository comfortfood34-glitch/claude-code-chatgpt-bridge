const ROUTINE_URL_PATTERN = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/;

export type RoutineResult = {
  type: "routine_fire";
  claude_code_session_id: string;
  claude_code_session_url: string;
};

export function validateRoutineUrl(value: string): string {
  if (!ROUTINE_URL_PATTERN.test(value)) {
    throw new Error("CLAUDE_ROUTINE_FIRE_URL is invalid or is not an official Anthropic routine URL.");
  }
  return value;
}

export async function fireClaudeRoutine(task: string): Promise<RoutineResult> {
  const routineUrl = validateRoutineUrl(process.env.CLAUDE_ROUTINE_FIRE_URL ?? "");
  const routineToken = process.env.CLAUDE_ROUTINE_TOKEN;
  if (!routineToken?.startsWith("sk-ant-oat01-")) {
    throw new Error("CLAUDE_ROUTINE_TOKEN is missing or invalid.");
  }

  const response = await fetch(routineUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${routineToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ text: task }),
    signal: AbortSignal.timeout(30_000)
  });

  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      message = parsed.error?.message ?? body;
    } catch {
      // Keep the provider response as diagnostic text.
    }
    throw new Error(`Claude routine failed (${response.status}): ${message.slice(0, 500)}`);
  }

  const result = JSON.parse(body) as Partial<RoutineResult>;
  if (
    result.type !== "routine_fire" ||
    typeof result.claude_code_session_id !== "string" ||
    typeof result.claude_code_session_url !== "string" ||
    !result.claude_code_session_url.startsWith("https://claude.ai/code/")
  ) {
    throw new Error("Claude returned an unexpected routine response.");
  }
  return result as RoutineResult;
}

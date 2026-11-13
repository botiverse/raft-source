// What `raft context search` and `raft context read` share: the flags both
// take, the request's refusals, and the answer's check and header.

import type { AgentContextQueryAnswerBody } from "@botiverse/raft-shared";
import { AGENT_API_RATE_LIMITED_CODE, foldAgentOneLineText, parseAgentContextQueryAnswerBody } from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { apiFailureError, rateLimitedCliError } from "../../core/apiFailure";
import { shellWord } from "../../core/commandLine";
import { CliError } from "../../core/errors";

/** Both commands' help: whose context it reads, who sees the query, and the rate limit. */
export const CONTEXT_HELP_AFTER =
  "\n--message-id is a message you sent, or, if a server owner or admin gave you a View Context grant, another agent's message"
  + "\nyou can see (never a personal assistant's). Each search or read is recorded, query included,"
  + "\nand people who can view that message's context see it in its \"Viewed by\" list on the web."
  + "\nSearches and reads are rate-limited; a refusal says how many seconds to wait.\n";

export const MESSAGE_ID_OPTION = {
  flags: "--message-id <id>",
  description: "A message you sent, or another agent's if you have a View Context grant (full id or 8-character short id)",
};

export function requireMessageId(raw: string | undefined): string {
  const id = raw?.trim() ?? "";
  if (!id) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--message-id is required: the id of the message whose context to look in, e.g. --message-id 1a2b3c4d",
    });
  }
  return id;
}

export function parseWholeFlag(name: string, raw: string | undefined, min: number, max?: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be a whole number ${max !== undefined ? `from ${min} to ${max}` : `of at least ${min}`}; got ${raw}`,
    });
  }
  return n;
}

/** A command line to run next, its values quoted for a POSIX shell. */
export function contextCommand(action: "search" | "read", messageId: string, flags: Array<[string, string | number]>): string {
  return ["raft", "context", action, "--message-id", shellWord(messageId), ...flags.flatMap(([flag, value]) => [flag, shellWord(String(value))])].join(" ");
}

/** The Server's refusal as the CLI's error: its sentence and next step; a 429 with the wait and the command again. */
export function contextQueryFailure(res: ApiResponse<unknown>, again: string): CliError {
  if (res.status === 429 || res.errorCode === AGENT_API_RATE_LIMITED_CODE) {
    const body = res.errorBody as { retryAfterSeconds?: unknown } | null | undefined;
    const seconds = typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds > 0 ? Math.ceil(body.retryAfterSeconds) : 60;
    return rateLimitedCliError({ message: res.error ?? "Too many context searches.", retryAfterSeconds: seconds }, again);
  }
  return apiFailureError(res, "CONTEXT_QUERY_FAILED");
}

/** The answer, checked again here: anything but entries is refused, never printed. */
export function requireAnswer(data: unknown, kind: "search" | "read"): AgentContextQueryAnswerBody {
  const body = parseAgentContextQueryAnswerBody(data);
  if (!body || body.answer.kind !== kind) {
    throw new CliError({ code: "INVALID_JSON_RESPONSE", message: `The Server's answer to a context ${kind} has an unexpected shape` });
  }
  return body;
}

export function answerHeader(messageId: string, body: AgentContextQueryAnswerBody): string {
  const runtime = [foldAgentOneLineText(body.runtime), ...(body.model ? [foldAgentOneLineText(body.model)] : [])].join(", ");
  return `Context of message ${foldAgentOneLineText(messageId)} (${runtime}; ${body.entryCount} ${body.entryCount === 1 ? "entry" : "entries"})`;
}

// One refusal envelope for every 4xx the Server answers (#wg-ax:#13,
// docs/contracts/agent-api-refusals.md). The Server writes it through one exit
// (the server's lib/refusal.ts `refuse()`); clients show `error` as sent and
// branch in code only on the codes in REFUSAL_CODES (refusalCodes.ts). A rule
// the Server adds later still reads on an older client, because the sentence
// carries it, not a table on the client.

import type { RaftHint } from "./agentOps/hint";

/** The most characters `error` may have. */
export const REFUSAL_ERROR_MAX_CHARS = 500;

/** A code: a stable identifier for logs and metrics, and the contract for the listed ones. */
export const REFUSAL_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Text that names a command or a flag (`raft …`, `--title`): it belongs in `next`, not in `error`. */
export const REFUSAL_COMMAND_PATTERN = /\braft [a-z]|(^|[\s`'"(])--[a-z]/;

export interface Refusal {
  /**
   * One line, at most REFUSAL_ERROR_MAX_CHARS, with a space in it: why the
   * request was refused and what to change, in words. It names no command
   * (the Server can't tell a CLI agent from a tool-mode one); a command goes
   * in `next`.
   */
  error: string;
  /** A stable code. The codes in REFUSAL_CODES are a contract clients may branch on; any other is for logs and metrics only. */
  code: string;
  /** The same request may be sent again after this many seconds (more than zero). The Server also sets the Retry-After header. */
  retryAfterSeconds?: number;
  /** The next step as a structured operation, rendered by each client in its own form (a `raft …` command, a tool call). */
  next?: RaftHint;
  /** The next step as text, for clients that predate `next`; refuse() writes it from `next` (the CLI form) when not given. */
  suggestedNextAction?: string;
  /** Machine data, only for codes in REFUSAL_CODES (a stale refusal's current revision); understanding the refusal never depends on it. */
  details?: Record<string, unknown>;
}

/** What refuse() writes: the envelope, plus `errorCode` (= `code`) for clients that read that name. */
export interface RefusalBody extends Refusal {
  errorCode: string;
}

/** Why `error` isn't a refusal sentence, or null when it is one. */
export function refusalSentenceProblem(error: string): string | null {
  const sentence = error.trim();
  if (!sentence) return "it is empty";
  if (/[\r\n]/.test(sentence)) return "it has more than one line";
  if (sentence.length > REFUSAL_ERROR_MAX_CHARS) return `it is longer than ${REFUSAL_ERROR_MAX_CHARS} characters`;
  if (!/\s/.test(sentence)) return "it is a single word or a code, not a sentence";
  if (REFUSAL_COMMAND_PATTERN.test(sentence)) return "it names a command or a flag; put the step in `next`";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Seconds to wait, rounded up; a wait has to be more than zero (as the RATE_LIMITED body has always required). */
function positiveSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

/** A `next` as the Server sent it, or undefined when it isn't a hint (a client never trusts a malformed one). */
function readHint(value: unknown): RaftHint | undefined {
  if (!isRecord(value) || !Array.isArray(value.cli) || value.cli.length === 0 || !value.cli.every((word) => typeof word === "string")) return undefined;
  const op = value.op;
  if (op === undefined) return { cli: value.cli as string[] };
  if (!isRecord(op) || typeof op.name !== "string" || !isRecord(op.args)) return undefined;
  const fill = Array.isArray(value.fill) && value.fill.every((key) => typeof key === "string") ? (value.fill as string[]) : undefined;
  return {
    cli: value.cli as string[],
    op: { name: op.name, args: op.args, ...(op.partial === true ? { partial: true as const } : {}) },
    ...(fill && fill.length > 0 ? { fill } : {}),
    ...(value.codeOnly === true ? { codeOnly: true as const } : {}),
  };
}

/**
 * The refusal in a 4xx body, read tolerantly: the envelope, or one of the
 * shapes the Server wrote before it (`errorCode`, `message`,
 * `suggested_next_action`, `next_action`, `retry_after_seconds`,
 * `retry_after`, `retryAfterMs`). Fields that aren't there, or aren't well formed, are
 * absent; `error` is only what the body said (a client decides whether it
 * reads as a sentence with refusalSentenceProblem).
 */
export function readRefusal(body: unknown): Partial<Refusal> {
  if (!isRecord(body)) return {};
  const out: Partial<Refusal> = {};
  const error = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : undefined;
  if (error !== undefined) out.error = error;
  const code = [body.code, body.errorCode, isRecord(body.error) ? body.error.code : undefined]
    .find((value): value is string => typeof value === "string" && REFUSAL_CODE_PATTERN.test(value));
  if (code !== undefined) out.code = code;
  const details = isRecord(body.details) ? body.details : undefined;
  // Top-level waits only: `details.retryAfterSeconds` belongs to the 429
  // RATE_LIMITED body, whose own parser (agentApiRateLimit.ts) reads it.
  const retryAfterSeconds = positiveSeconds(body.retryAfterSeconds)
    ?? positiveSeconds(body.retry_after_seconds)
    ?? positiveSeconds(body.retry_after)
    ?? (typeof body.retryAfterMs === "number" ? positiveSeconds(body.retryAfterMs / 1000) : undefined);
  if (retryAfterSeconds !== undefined) out.retryAfterSeconds = retryAfterSeconds;
  const next = readHint(body.next);
  if (next) out.next = next;
  const step = [body.suggestedNextAction, body.suggested_next_action, body.next_action]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (step !== undefined) out.suggestedNextAction = step.trim();
  if (details) out.details = details;
  return out;
}

// The Server's one exit for a refusal (#wg-ax:#13,
// docs/contracts/agent-api-refusals.md): every 4xx is written here, in the
// shared envelope (packages/shared/src/refusal.ts). A route calls refuse();
// code below a route throws RefusalError and the global handler
// (routes/errorResponse.ts) writes it. scripts/ci/refusal-ratchet.ts keeps
// direct `res.status(4xx)` from growing while routes move here.

import type { Request, Response } from "express";
import {
  AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE,
  AGENT_API_RATE_LIMITED_CODE,
  formatHint,
  parseAgentApiRateLimitedBody,
  refusalSentenceProblem,
  REFUSAL_CODE_PATTERN,
  type RaftHint,
  type RefusalBody,
} from "@botiverse/raft-shared";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";

/** The 4xx statuses a refusal may have. */
export type RefusalStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 412 | 413 | 415 | 416 | 422 | 423 | 426 | 429;

export interface RefusalInput {
  /** A stable code; listed in REFUSAL_CODES when a client acts on it in code. */
  code: string;
  /** One line with a space in it, at most 500 characters, naming no command: why, and what to change. */
  error: string;
  /** The next step as an operation (RAFT_HINTS); clients render it in their own form. */
  next?: RaftHint;
  /** The next step as text, when there is no operation for it. Written from `next` otherwise. */
  suggestedNextAction?: string;
  /** The same request may go again after this many seconds; also sets Retry-After. */
  retryAfterSeconds?: number;
  /** Machine data, only for a code in REFUSAL_CODES (a stale refusal's current revision). */
  details?: Record<string, unknown>;
}

/** Thrown by code below a route; the global handler writes it as the envelope. */
export class RefusalError extends Error {
  readonly status: RefusalStatus;
  readonly refusal: RefusalInput;

  constructor(status: RefusalStatus, refusal: RefusalInput) {
    super(refusal.error);
    this.name = "RefusalError";
    this.status = status;
    this.refusal = refusal;
  }
}

/**
 * Where a malformed refusal is reported. Tests and development throw;
 * production logs and still answers. Vitest counts as a test even where the
 * machine presets NODE_ENV=production (agent VMs, app.ts).
 */
function strict(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV !== "production";
}

function problemsOf(input: RefusalInput): string[] {
  const problems: string[] = [];
  if (!REFUSAL_CODE_PATTERN.test(input.code)) problems.push(`code "${input.code}" is not a code (${REFUSAL_CODE_PATTERN})`);
  const sentence = refusalSentenceProblem(input.error);
  if (sentence) problems.push(`error "${input.error.slice(0, 80)}": ${sentence}`);
  if (input.retryAfterSeconds !== undefined && !(Number.isFinite(input.retryAfterSeconds) && input.retryAfterSeconds > 0)) {
    problems.push(`retryAfterSeconds ${input.retryAfterSeconds} is not a wait of more than zero seconds`);
  }
  // Two codes older clients parse by their own body shape: write them so those
  // parsers still accept them, or keep their own writers.
  if (input.code === AGENT_API_RATE_LIMITED_CODE
    && !parseAgentApiRateLimitedBody({ error: input.error, code: input.code, details: input.details })) {
    problems.push("RATE_LIMITED needs details { operation, limit, windowSeconds, retryAfterSeconds } (older clients parse them; agentApiRateLimit.ts); use another code for other limits");
  }
  if (input.code === AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE) {
    problems.push("CLIENT_UPGRADE_REQUIRED keeps its own body (top-level minVersion/yourVersion, agentApiClientUpgrade.ts); don't send it through refuse()");
  }
  return problems;
}

/**
 * The body for a refusal: the envelope, `errorCode` for clients that read
 * that name, and `suggestedNextAction` written from `next` (the CLI form) for
 * clients that predate `next`.
 */
export function refusalBody(input: RefusalInput): RefusalBody {
  const problems = problemsOf(input);
  if (problems.length > 0) {
    const message = `[refusal] ${input.code}: ${problems.join("; ")}`;
    if (strict()) throw new Error(message);
    console.warn(message);
  }
  const step = input.suggestedNextAction ?? (input.next ? formatHint(input.next, "cli") : undefined);
  return {
    error: input.error.trim(),
    code: input.code,
    errorCode: input.code,
    ...(input.retryAfterSeconds !== undefined ? { retryAfterSeconds: Math.ceil(input.retryAfterSeconds) } : {}),
    ...(input.next ? { next: input.next } : {}),
    ...(step ? { suggestedNextAction: step } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

/** Longest request value a refusal sentence quotes; past it the sentence leaves the value out. */
const QUOTED_VALUE_MAX_CHARS = 200;

/**
 * A refusal sentence that quotes what the request sent (a target, a name, an
 * id), or `without` when a quoted value would break the sentence rules: a line
 * break, something that reads as a flag or a command, or an over-long value.
 * Request input is never trusted to keep the sentence valid, so a malformed
 * value still gets its own status and code, just without the echo. The choice
 * depends only on the values, so refusals that must read the same for every
 * reason stay identical.
 */
export function sentenceQuoting(values: readonly string[], quoted: string, without: string): string {
  const fits = values.every((value) => value.length <= QUOTED_VALUE_MAX_CHARS) && refusalSentenceProblem(quoted) === null;
  return fits ? quoted : without;
}

/** Answer a refusal: the status, the envelope, Retry-After when the request may go again, and the trace's error code. */
export function refuse(res: Response, status: RefusalStatus, input: RefusalInput): void {
  const body = refusalBody(input);
  setRequestTraceErrorCode(res, input.code);
  if (body.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(body.retryAfterSeconds));
  res.status(status).json(body);
}

/**
 * An express-rate-limit `handler`: a 429 refusal with this code and sentence,
 * and the seconds until the limiter's window lets the same request through.
 * Use it in place of a limiter's `message`, so a limited request answers the
 * envelope like every other refusal. Not for RATE_LIMITED: older clients parse
 * that code's own details, which a limiter can't fill in.
 */
export function rateLimitRefusal(code: string, error: string): (req: Request, res: Response) => void {
  return (req, res) => {
    const reset = (req as { rateLimit?: { resetTime?: unknown } }).rateLimit?.resetTime;
    const seconds = reset instanceof Date ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : undefined;
    refuse(res, 429, { code, error, ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}) });
  };
}

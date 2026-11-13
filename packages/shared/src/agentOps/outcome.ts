// Outcome: the result shape of every agent operation (the AX layer).
//
// An operation never throws for something the Server decided (a hold, a
// refusal, a missing capability); it returns an outcome whose `state` names
// what happened, whose `next` says the one thing to do now (the structured
// form of the CLI's `Next:` line, with the exact `raft …` command so a runtime
// that shells out to the CLI can hand the model the same instruction, and the
// operation that does the same for a runtime that calls operations), and
// whose `text` is the canonical agent-readable rendering. Failures carry a
// stable SDK code, the Server's machine code when it sent one, and a next
// action; raw bodies and transport causes are never surfaced (the Server
// sentences shown are ones written for agents: core's rate limit's,
// rateLimitedError, a too-old client's, clientUpgradeError, and an action
// card refusal's, actions.ts).

import type { z } from "zod";

import type { AgentApiClientError, AgentApiClientResult } from "../agentApiClient";
import type { AgentApiRouteKey } from "../agentApiContract";
import { AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE, AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS, parseAgentApiClientUpgradeRequiredBody } from "../agentApiClientUpgrade";
import { agentApiRateLimitedSentence, parseAgentApiRateLimitedBody } from "../agentApiRateLimit";
import { formatHint, RAFT_HINTS, type RaftHint, type RaftHintStyle, type RaftNextOperation } from "./hint";
import { readRefusal } from "../refusal";

export interface RaftNextStep {
  /** Stable step kind, for example `read_target`, `run_inbox_check`, `retry_after_review`. */
  kind: string;
  /**
   * The exact CLI command an agent would run for this step, when one exists;
   * with `createRaft({ hints: "tool" })`, the tool call instead.
   */
  command?: string;
  /**
   * Structured arguments for the step: plain, serialisable data (never a
   * closure), so a runtime whose next step runs in another process can store
   * it and act on it later — for example the `target` of a `read_target` step.
   * (An interrupted call's resume is `interrupt.resume`, not `args`.)
   */
  args?: Record<string, unknown>;
  /**
   * The manifest operation that takes this step, with its arguments in
   * manifest shape (valid for that operation's schema). `partial: true` when
   * some required arguments are the caller's to supply (a send's `content`).
   */
  operation?: RaftNextOperation;
  /** One sentence explaining why this is the next step. */
  why: string;
}

export type RaftOpErrorCode =
  | "INVALID_REQUEST"
  | "TRANSPORT_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "CAPABILITY_NOT_AUTHORIZED"
  | "SCOPE_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "UNSUPPORTED_FOR_EXTERNAL_AGENTS"
  | "UNAVAILABLE"
  /** A model-only operation was invoked from code (`invoke(…, { origin: "code" })`); nothing was sent. */
  | "MODEL_ONLY"
  /** A Raft app (Agent Login integration) refused or failed the call, or cannot be called safely. */
  | "APP_ERROR";

export interface RaftOpError {
  code: RaftOpErrorCode;
  /**
   * Safe SDK text; never a raw Server body or transport cause. The Server's
   * own sentence only where it is written for agents: core's rate limit, and
   * an `actions.prepare` refusal (what is wrong with the card).
   */
  message: string;
  status?: number;
  /** The Server's stable machine code for an HTTP rejection, when it sent one. */
  serverCode?: string;
  /** What to do now; from the Server when it said, otherwise the SDK default for this code. */
  nextAction: string;
  retryable: boolean;
  /** Whole seconds until the same request may go again: a 429 RATE_LIMITED, or any refusal that carries `retryAfterSeconds`. */
  retryAfterSeconds?: number;
  /** The Server's next step as an operation (the refusal's `next`); `nextAction` is it rendered, in the caller's hint style. */
  nextHint?: RaftHint;
}

export interface RaftFailure {
  ok: false;
  state: "error";
  error: RaftOpError;
  next: RaftNextStep | null;
  text: string;
}

export type RaftOutcome<TData, TState extends string = "ok"> =
  | { ok: true; state: TState; data: TData; next: RaftNextStep | null; text: string }
  | RaftFailure;

const SERVER_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const DEFAULT_MESSAGES: Record<RaftOpErrorCode, string> = {
  INVALID_REQUEST: "The request did not match the Agent API contract; nothing was sent.",
  TRANSPORT_ERROR: "The request did not reach the Raft Server.",
  HTTP_ERROR: "The Raft Server rejected the request.",
  INVALID_RESPONSE: "The Raft Server response did not match the Agent API contract.",
  CAPABILITY_NOT_AUTHORIZED: "This credential does not carry the capability this operation needs.",
  SCOPE_DENIED: "This agent's scope set does not allow this operation.",
  NOT_FOUND: "The target or message does not exist or is not visible to this agent.",
  CONFLICT: "The Raft Server refused the operation because of the current state.",
  IDEMPOTENCY_KEY_REUSED: "This idempotency key was already used for a different request.",
  UNSUPPORTED_FOR_EXTERNAL_AGENTS: "This operation is not available to External Agents.",
  UNAVAILABLE: "The Raft Server could not serve this operation right now.",
  MODEL_ONLY: "This operation only counts when the model sees its result, so it cannot be run from code; nothing was sent.",
  APP_ERROR: "The app refused or failed the call.",
};

function notFoundNextAction(style: RaftHintStyle): string {
  return `Check the target spelling with \`${formatHint(RAFT_HINTS.serverInfo({ view: "channels" }), style)}\` or resolve the message id first.`;
}

const DEFAULT_NEXT_ACTION: Record<RaftOpErrorCode, string> = {
  INVALID_REQUEST: "Fix the request arguments; nothing was sent.",
  TRANSPORT_ERROR: "Check connectivity to the Raft Server and retry if the operation is safe to repeat.",
  HTTP_ERROR: "Change what the error says, then try again. If it doesn't say what to change, this client may be older than the Raft Server: update it to the latest version.",
  INVALID_RESPONSE: "Upgrade the SDK or report the Server version; the response shape is not the one this SDK knows.",
  CAPABILITY_NOT_AUTHORIZED: "Ask a human who can mint credentials to include the missing capability.",
  SCOPE_DENIED: "Ask a human with editAgents authority to extend this agent's scopes.",
  NOT_FOUND: notFoundNextAction("cli"),
  CONFLICT: "Read the current state before repeating this operation.",
  IDEMPOTENCY_KEY_REUSED: "Use a new idempotency key for a different request, or resend the identical request to reconcile.",
  UNSUPPORTED_FOR_EXTERNAL_AGENTS: "Use your own runtime for this; the Server does not provide it to External Agents.",
  UNAVAILABLE: "Retry in a moment.",
  MODEL_ONLY: "Call it as a model tool call instead of from code.",
  APP_ERROR: "Read the app's error and adjust the request; if it keeps failing, tell the person who asked.",
};

const RETRYABLE: Record<RaftOpErrorCode, boolean> = {
  INVALID_REQUEST: false,
  TRANSPORT_ERROR: true,
  HTTP_ERROR: false,
  INVALID_RESPONSE: false,
  CAPABILITY_NOT_AUTHORIZED: false,
  SCOPE_DENIED: false,
  NOT_FOUND: false,
  CONFLICT: false,
  IDEMPOTENCY_KEY_REUSED: false,
  UNSUPPORTED_FOR_EXTERNAL_AGENTS: false,
  UNAVAILABLE: true,
  MODEL_ONLY: false,
  APP_ERROR: false,
};

function classifyHttp(status: number, serverCode: string | undefined): RaftOpErrorCode {
  const code = serverCode?.toLowerCase() ?? "";
  if (code === "idempotency_key_reused") return "IDEMPOTENCY_KEY_REUSED";
  if (code === "reminders_unsupported_for_external_agents") return "UNSUPPORTED_FOR_EXTERNAL_AGENTS";
  if (code === "capability_not_authorized") return "CAPABILITY_NOT_AUTHORIZED";
  if (code === "scope_denied") return "SCOPE_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 503) return "UNAVAILABLE";
  if (status >= 500) return "UNAVAILABLE";
  return "HTTP_ERROR";
}

const REFUSAL_SENTENCE_MAX_CHARS = 500;

/**
 * A 4xx refusal's own sentence, the body's `error`. The Server writes it for
 * the agent (why it refused, and what to change), so it is shown as sent,
 * whether or not this client knows the code: a rule added on a newer Server
 * still reads on an older client. One bounded line with a space in it, else
 * null (the default sentence stands).
 */
function refusalSentence(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const raw = (response as { error?: unknown }).error;
  if (typeof raw !== "string") return null;
  const sentence = raw.trim();
  // A sentence has a space: a bare code ("invalid_scope") or word ("Unauthorized") in `error` is not one.
  return /\s/.test(sentence) && !/[\r\n]/.test(sentence) && sentence.length <= REFUSAL_SENTENCE_MAX_CHARS ? sentence : null;
}

/**
 * Core's 429 RATE_LIMITED (agentApiRateLimit.ts: an app's writes over the
 * agent's budget): the Server's sentence, the one it writes for agents
 * (which writes, the limit, the wait; a stand-in from the details if it isn't
 * one short line), retryable after the wait. Nothing else of the body. The
 * refused request ran nothing, so repeating it does nothing twice.
 */
function rateLimitedError(response: unknown): Omit<RaftOpError, "code" | "status"> | null {
  const body = parseAgentApiRateLimitedBody(response);
  if (!body) return null;
  const { retryAfterSeconds } = body.details;
  const wait = `${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}`;
  return {
    message: agentApiRateLimitedSentence(body),
    serverCode: body.code,
    nextAction: `Wait ${wait}, then make the same request again (the refused one changed nothing).`,
    retryable: true,
    retryAfterSeconds,
  };
}

const CLIENT_UPGRADE_SENTENCE_MAX_CHARS = 1000;

/**
 * A 426 CLIENT_UPGRADE_REQUIRED (agentApiClientUpgrade.ts: this client is
 * older than the route accepts): the Server's sentence, which says exactly
 * how to upgrade (from the body, or the transport's `error` when it kept no
 * body, as a binary download's; a stand-in if it isn't one bounded line).
 * Not retryable: the same client is refused again until it is upgraded.
 */
function clientUpgradeError(error: Extract<AgentApiClientError, { kind: "http" }>): Omit<RaftOpError, "code" | "status"> | null {
  if (error.status !== AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS) return null;
  const body = parseAgentApiClientUpgradeRequiredBody(error.response);
  if (!body && error.errorCode !== AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE) return null;
  const sentence = (body?.error ?? error.message).trim();
  const message = sentence && !/[\r\n]/.test(sentence) && sentence.length <= CLIENT_UPGRADE_SENTENCE_MAX_CHARS
    ? sentence
    : `This client is too old for this request${body ? `: the Raft Server needs ${body.minVersion} or newer` : ""}. Upgrade it.`;
  return {
    message,
    serverCode: AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE,
    nextAction: "Upgrade as the error says, then run the same command again (the refused request changed nothing).",
    retryable: false,
  };
}

export function opErrorFromClientError(error: AgentApiClientError, status?: number): RaftOpError {
  if (error.kind === "transport") {
    return { code: "TRANSPORT_ERROR", message: DEFAULT_MESSAGES.TRANSPORT_ERROR, nextAction: DEFAULT_NEXT_ACTION.TRANSPORT_ERROR, retryable: true };
  }
  if (error.kind === "http") {
    const serverCode = typeof error.errorCode === "string" && SERVER_ERROR_CODE.test(error.errorCode) ? error.errorCode : undefined;
    const code = classifyHttp(error.status, serverCode);
    const limited = error.status === 429 ? rateLimitedError(error.response) : null;
    if (limited) return { ...limited, code, status: error.status };
    const upgrade = clientUpgradeError(error);
    if (upgrade) return { ...upgrade, code, status: error.status };
    // The refusal envelope (shared refusal.ts): a structured `next` wins over
    // the text step, and `retryAfterSeconds` makes any refusal retryable after
    // the wait, whatever its code.
    const refusal = readRefusal(error.response);
    const hint = refusal.next;
    const wait = refusal.retryAfterSeconds;
    const serverStep = hint
      ? formatHint(hint, "cli")
      : typeof error.suggestedNextAction === "string" && error.suggestedNextAction.trim()
        ? error.suggestedNextAction.trim()
        : null;
    const nextAction = serverStep
      ?? (wait !== undefined
        ? `Wait ${wait} second${wait === 1 ? "" : "s"}, then make the same request again.`
        : DEFAULT_NEXT_ACTION[code]);
    const sentence = error.status >= 400 && error.status < 500 ? refusalSentence(error.response) : null;
    return {
      code,
      message: sentence ?? DEFAULT_MESSAGES[code],
      status: error.status,
      ...(serverCode ? { serverCode } : {}),
      nextAction,
      retryable: wait !== undefined ? true : RETRYABLE[code],
      ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
      ...(hint ? { nextHint: hint } : {}),
    };
  }
  const requestSide = error.reason === "request_contract_mismatch" || error.reason === "missing_path_param" || error.reason === "missing_route";
  const code: RaftOpErrorCode = requestSide ? "INVALID_REQUEST" : "INVALID_RESPONSE";
  return {
    code,
    message: DEFAULT_MESSAGES[code],
    ...(status === undefined ? {} : { status }),
    nextAction: DEFAULT_NEXT_ACTION[code],
    retryable: false,
  };
}

export function opError(code: RaftOpErrorCode, overrides: Partial<Omit<RaftOpError, "code">> = {}): RaftOpError {
  return {
    code,
    message: DEFAULT_MESSAGES[code],
    nextAction: DEFAULT_NEXT_ACTION[code],
    retryable: RETRYABLE[code],
    ...overrides,
  };
}

/** Render an error the way an agent should read it: what failed, the code, and the next action. */
export function formatOpErrorText(error: RaftOpError): string {
  const lines = [`Error: ${error.message}`, `Code: ${error.code}`];
  if (error.serverCode) lines.push(`Server code: ${error.serverCode}`);
  lines.push(`Retryable: ${error.retryable ? "yes" : "no"}`);
  lines.push(`Next action: ${error.nextAction}`);
  return lines.join("\n");
}

/**
 * The Server's hint, while it is still the step: an operation that writes its
 * own next action over it (the Artifacts' words) leaves `nextHint` behind,
 * and then the hint must not override that step in another style.
 */
function currentHint(error: RaftOpError): RaftHint | undefined {
  return error.nextHint && error.nextAction === formatHint(error.nextHint, "cli") ? error.nextHint : undefined;
}

export function failureOutcome(error: RaftOpError): RaftFailure {
  const operation = currentHint(error)?.op;
  return { ok: false, state: "error", error, next: { kind: "recover", why: error.nextAction, ...(operation ? { operation } : {}) }, text: formatOpErrorText(error) };
}

/** A next action written for the CLI: it names a `raft` command or a `--flag`. */
export const CLI_NEXT_ACTION_PATTERN = /\braft [a-z]|(^|[\s`'"(])--[a-z]/;

/**
 * The attachment routes answer one uniform 404 for missing, unreadable and
 * other-subsystem ids (no existence oracle); the Server's next action names
 * the Feedback Admin CLI command, which a tool-mode model cannot run.
 */
const ATTACHMENT_UNAVAILABLE_TOOL_NEXT_ACTION =
  "This id is not an attachment you can read. Use an attachment id from a message you can see.";

/**
 * Render a failure's next action in a hint style. In "cli" style nothing
 * changes. In "tool" style no next action names a CLI command: the SDK's own
 * NOT_FOUND default (set deep in the shared client-error mapping) is
 * re-rendered as a tool call, `ATTACHMENT_UNAVAILABLE` gets a neutral step,
 * and any other Server-sent next action written for the CLI falls back to the
 * code's default.
 */
export function restyleDefaultNextAction<T>(outcome: T, style: RaftHintStyle): T {
  if (style === "cli" || !outcome || typeof outcome !== "object") return outcome;
  const failure = outcome as unknown as Partial<RaftFailure>;
  if (failure.ok !== false || !failure.error) return outcome;
  const current = failure.error.nextAction;
  let nextAction = current;
  const hint = currentHint(failure.error);
  if (hint) nextAction = formatHint(hint, style);
  else if (current === DEFAULT_NEXT_ACTION.NOT_FOUND) nextAction = notFoundNextAction(style);
  else if (failure.error.serverCode === "ATTACHMENT_UNAVAILABLE") nextAction = ATTACHMENT_UNAVAILABLE_TOOL_NEXT_ACTION;
  else if (CLI_NEXT_ACTION_PATTERN.test(current)) {
    nextAction = failure.error.code === "NOT_FOUND" ? notFoundNextAction(style) : DEFAULT_NEXT_ACTION[failure.error.code];
  }
  // A Server sentence written for the CLI (it names a command or a flag, as
  // ATTACHMENT_UNAVAILABLE's does) is not for a model that can't run one: the
  // code's own sentence instead.
  const message = CLI_NEXT_ACTION_PATTERN.test(failure.error.message) ? DEFAULT_MESSAGES[failure.error.code] : failure.error.message;
  if (nextAction === current && message === failure.error.message) return outcome;
  const error: RaftOpError = { ...failure.error, message, nextAction };
  const next = failure.next && failure.next.why === current ? { ...failure.next, why: nextAction } : failure.next ?? null;
  return { ...failure, error, next, text: formatOpErrorText(error) } as T;
}

/**
 * A failure of a keyed write (`idempotencyKey`). A retryable failure (the
 * request may not have reached the Server, or the Server was unavailable)
 * says to repeat the SAME request with the SAME key, and carries the key in
 * `next.args.idempotencyKey`, so a caller that let the SDK generate it can
 * still retry without acting twice.
 */
export function keyedWriteFailure(failure: RaftFailure, idempotencyKey: string): RaftFailure {
  if (!failure.error.retryable) return failure;
  return {
    ...failure,
    next: {
      kind: "retry_same_key",
      args: { idempotencyKey },
      why: "Repeat the same request with this idempotencyKey: if the first attempt was committed, the Server returns its result instead of acting twice.",
    },
  };
}

/** Map a shared-client failure to a failure outcome. */
export function failureFromClientResult<K extends AgentApiRouteKey>(
  result: Extract<AgentApiClientResult<K>, { ok: false }>,
): RaftFailure {
  return failureOutcome(opErrorFromClientError(result.error, result.status));
}

const MAX_REPORTED_ISSUES = 3;

/**
 * Validate an operation's input with its zod request schema. Returns null when
 * it is valid, otherwise an `INVALID_REQUEST` failure whose message names the
 * offending fields and what was expected (zod's issue text, which never
 * echoes the input value); nothing is sent.
 */
export function validateOpRequest(schema: z.ZodType, value: unknown): RaftFailure | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : String(part))).join(".").replace(/\.\[/g, "[");
    return `${path || "request"}: ${issue.message}`;
  });
  const more = parsed.error.issues.length > MAX_REPORTED_ISSUES ? ` (+${parsed.error.issues.length - MAX_REPORTED_ISSUES} more)` : "";
  return failureOutcome(opError("INVALID_REQUEST", { message: `Invalid request: ${issues.join("; ")}${more}. Nothing was sent.` }));
}

import { createHash } from "node:crypto";
import {
  ANTHROPIC_VERIFICATION_PORTAL_URL,
  MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS,
  boundedRuntimeErrorDetail,
  getRuntimeDisplayName,
  runtimeErrorReasonForClass,
  scrubRuntimeErrorText,
} from "@botiverse/raft-shared";
import type {
  CredentialInvalidReason,
  ReadinessCode,
  RuntimeErrorActivityDiagnostic,
  RuntimeErrorClass,
  RuntimeErrorReason,
  RuntimeErrorReasonProvenance,
  RuntimeErrorRequiredAction,
} from "@botiverse/raft-shared";

const MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS = 4096;
const RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS: RegExp[] = [
  /access token could not be refreshed/i,
  /\btoken_(?:revoked|invalidated)\b/i,
  /refresh token was already used/i,
  /access token.*invalidated/i,
  /authentication token has been invalidated/i,
  /logged out or signed in to another account/i,
  /not logged in/i,
  /not signed in/i,
  /login required/i,
  /log in first/i,
  /please log in/i,
  /authentication failed/i,
  /auth(?:entication)? failed/i,
  /authentication timed out/i,
  /missing (?:api )?token/i,
  /no (?:api )?token/i,
  /missing credentials/i,
  /credentials? not found/i,
  /invalid api key/i,
  /api key (?:is )?not set/i,
];
// task #917 — provider wording for an exhausted billing or credit balance.
// Seen: Grok Build "402 ... usage balance exhausted"; the others are the common
// provider phrasings of the same fact. "usage limit" / "quota exceeded" are a
// used-up quota, not billing (`isRuntimeUsageLimitText`), and are deliberately
// not matched here.
const RUNTIME_BILLING_EXHAUSTED_PATTERNS: RegExp[] = [
  /\bpayment required\b/i,
  /\b(?:usage|credit|account)\s+balance\b[^.]*\b(?:exhausted|depleted|insufficient|too low)\b/i,
  /\binsufficient\s+(?:balance|credits?|funds)\b/i,
  /\b(?:out of|run out of|no remaining)\s+credits?\b/i,
];
// task #352 — the provider answered that the account's plan/subscription does
// not include the requested model. Field sample (Sora, #proj-daemon:78630c13):
// z.ai `429: {"code":"1311","message":"Your current subscription plan does not
// yet include access to GLM-5.3-Highspeed"}`. Retrying cannot succeed until the
// user changes the model or the plan, so this is action-required like an auth
// failure. A plain rate-limit 429 and a timeout never match: both patterns need
// a plan/subscription word AND an access/model word joined by a negation.
//
// Codex answers a ChatGPT plan without Codex usage with a 403 "Usage not
// included in your plan" (#proj-raft-computer:#46, reconciler step 4a): the
// plan, not a limit that waiting ends, so it is the same plan-access fact.
const RUNTIME_PLAN_ACCESS_PATTERNS: RegExp[] = [
  /\busage not included in your plan\b/i,
  /\b(?:subscription|plan|tier)\b[^.\n]{0,80}\b(?:does not|doesn't|do not|don't|not)\b[^.\n]{0,40}\b(?:include|allow|support|grant)\b[^.\n]{0,40}\b(?:access|model)\b/i,
  /\b(?:model|access)\b[^.\n]{0,80}\b(?:not|isn't|is not)\b[^.\n]{0,20}\b(?:included|available|enabled|allowed)\b[^.\n]{0,40}\b(?:subscription|plan|tier)\b/i,
];
// Capacity / transient-limit wording can co-occur with "plan" and "model"
// ("your plan does not support more requests to this model right now") but
// means a temporary limit, not missing access. Any marker vetoes plan-access
// so a rate limit never becomes a user-action terminal failure.
const RUNTIME_TRANSIENT_LIMIT_MARKERS: RegExp[] = [
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  /\bconcurrenc(?:y|ies)\b/i,
  /\bretry(?:ing)?\b/i,
  /\btry again\b/i,
  /\blater\b/i,
  /\bresets?\b/i,
  /\bper (?:second|minute|hour|day)\b/i,
  /\b[RT]PM\b/,
  /\bat the moment\b/i,
  /\bright now\b/i,
  /\bat capacity\b/i,
];
const RUNTIME_LAUNCHER_FAILURE_PATTERNS: RegExp[] = [
  /\bunknown command\b[\s\S]*\b(?:codex|gemini|opencode)\.(?:js|mjs|cjs)\b/i,
];

export interface RuntimeErrorDiagnosticEnvelope {
  spanAttrs: Record<string, unknown>;
  eventAttrs: Record<string, unknown>;
}

export function buildRuntimeErrorDiagnosticEnvelope(message: string): RuntimeErrorDiagnosticEnvelope {
  const rawMessage = String(message || "");
  const scrubbed = scrubRuntimeErrorDiagnosticText(rawMessage);
  const { value: excerpt, truncated } = truncateDiagnosticText(scrubbed, MAX_RUNTIME_ERROR_MESSAGE_EXCERPT_CHARS);
  const httpStatus = extractHttpStatus(rawMessage);
  const runtimeErrorClass = classifyRuntimeError(rawMessage, httpStatus);
  const runtimeErrorReason = classifyRuntimeErrorReason(runtimeErrorClass);
  const runtimeErrorAction = classifyRuntimeErrorAction(runtimeErrorClass, rawMessage);
  const fingerprint = fingerprintRuntimeError(scrubbed);
  const inputTooLargeAttrs = runtimeErrorClass === "InputTooLargeError"
    ? extractInputTooLargeAttrs(rawMessage)
    : {};
  const spanAttrs: Record<string, unknown> = {
    turn_outcome: "failed",
    turn_subtype: "runtime_error",
    turn_reason: runtimeErrorReason,
    runtime_error_class: runtimeErrorClass,
    runtime_error_action: runtimeErrorAction,
    runtime_error_action_required: runtimeErrorAction !== "none",
    runtime_error_fingerprint: fingerprint,
    runtime_error_message_present: rawMessage.length > 0,
    runtime_error_message_length_bucket: bucketLength(rawMessage.length),
    runtime_error_message_truncated: truncated,
    ...inputTooLargeAttrs,
  };
  if (httpStatus !== null) {
    spanAttrs.runtime_error_http_status = httpStatus;
  }

  return {
    spanAttrs,
    eventAttrs: {
      ...spanAttrs,
      runtime_error_message_excerpt: excerpt,
    },
  };
}

/**
 * The typed API error a runtime reported with an error (Claude Code's
 * `error` / `api_error_code` and `api_error_status`): provider codes, most
 * specific first, and the HTTP status, never its wording.
 */
export interface RuntimeProviderErrorFacts {
  codes?: readonly string[];
  httpStatus?: number;
}

// Claude Code's typed error codes (its SDK `error` categories and
// `api_error_code`) that alone say what failed.
const PROVIDER_ERROR_CODE_CLASSES: Readonly<Record<string, string>> = {
  rate_limit: "RateLimitError",
  rate_limit_error: "RateLimitError",
  billing_error: "BillingError",
  authentication_failed: "AuthError",
  authentication_error: "AuthError",
  permission_error: "AuthError",
  verification_required: "AuthError",
  server_error: "ProviderServerError",
  api_error: "ProviderServerError",
  overloaded: "ProviderServerError",
  overloaded_error: "ProviderServerError",
  not_found_error: "NotFoundError",
};

// Wording of failures the text classifier leaves `RuntimeError`, read for the
// trace class only (see `runtimeErrorTraceClassAttrs`).
const TRACE_TEXT_CLASSES: ReadonlyArray<[RegExp, string]> = [
  [/\bprompt is too long\b|\bconversation too long\b|\b(?:auto-?compact(?:ion)?|compaction)\b[^.\n]{0,60}\bfail/i, "InputTooLargeError"],
  [/\b(?:usage|weekly|daily|session|hourly|\d+-hour|opus|sonnet) limit\b|\bhit your\b[^.\n]{0,60}\blimit\b|\bquota (?:exceeded|limit)\b/i, "RateLimitError"],
  [/\bconnection error\b|\bsocket hang up\b|\bfetch failed\b|\bECONNABORTED\b/i, "ProviderConnectionError"],
];

/** The class a typed provider error's codes name, first known code wins; undefined when none is known. */
export function providerErrorCodeClass(providerError: RuntimeProviderErrorFacts | undefined): string | undefined {
  return providerError?.codes
    ?.map((code) => Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_CODE_CLASSES, code) ? PROVIDER_ERROR_CODE_CLASSES[code] : undefined)
    .find((value) => value !== undefined);
}

function runtimeErrorClassForHttpStatus(httpStatus: number, message: string): string {
  if (httpStatus === 402) return "BillingError";
  if (httpStatus === 429) return "RateLimitError";
  if (httpStatus === 401) return "AuthError";
  if (httpStatus === 403) return isRuntimeAuthActionRequiredText(message) ? "AuthError" : "ProviderApiError";
  if (httpStatus === 404) return "NotFoundError";
  if (httpStatus >= 500) return "ProviderServerError";
  return "ProviderApiError";
}

/**
 * The class, reason and HTTP status a runtime error carries on the turn span
 * and its `runtime.error` record. A typed provider code decides the class
 * (a Claude `rate_limit` reads "You've hit your limit", which the text
 * classifier leaves `RuntimeError`); otherwise the text classifier's class,
 * then the failure wording it does not know, then the reported status.
 * `RuntimeError` only when none of them says anything. The reported status
 * wins over one parsed from the text. Trace attributes only: what the daemon
 * does about the error is still decided on the text, as before.
 */
export function runtimeErrorTraceClassAttrs(
  envelope: RuntimeErrorDiagnosticEnvelope,
  message: string,
  providerError?: RuntimeProviderErrorFacts,
): Record<string, unknown> {
  const textClass = String(envelope.spanAttrs.runtime_error_class);
  const reportedStatus = providerError?.httpStatus;
  const parsedStatus = envelope.spanAttrs.runtime_error_http_status;
  const httpStatus = typeof reportedStatus === "number" && Number.isInteger(reportedStatus) && reportedStatus >= 100 && reportedStatus <= 599
    ? reportedStatus
    : typeof parsedStatus === "number" ? parsedStatus : undefined;
  const codeClass = providerErrorCodeClass(providerError);
  const runtimeErrorClass = codeClass
    ?? (textClass !== "RuntimeError" ? textClass : undefined)
    ?? TRACE_TEXT_CLASSES.find(([pattern]) => pattern.test(message))?.[1]
    ?? (httpStatus !== undefined ? runtimeErrorClassForHttpStatus(httpStatus, message) : "RuntimeError");
  return {
    runtime_error_class: runtimeErrorClass,
    turn_reason: classifyRuntimeErrorReason(runtimeErrorClass),
    ...(httpStatus !== undefined ? { runtime_error_http_status: httpStatus } : {}),
  };
}

export function isRuntimeBillingErrorText(message: string): boolean {
  const rawMessage = String(message || "");
  return classifyRuntimeError(rawMessage, extractHttpStatus(rawMessage)) === "BillingError";
}

export function formatRuntimeBillingExhaustedMessage(runtimeId: string): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  return `${runtimeLabel} reported that the provider's billing or credit balance is exhausted. Raft stopped retrying because retries cannot succeed until the balance is restored. Messages that were waiting are kept and will be delivered when the agent starts again. Add credits or switch this agent to another model or provider, then restart the agent.`;
}

export function formatRuntimePlanAccessMessage(runtimeId: string, model?: string | null): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  const modelLabel = typeof model === "string" && model.trim() ? ` (${model.trim()})` : "";
  return `${runtimeLabel} reported that the provider plan for this agent does not include access to the configured model${modelLabel}. Raft stopped retrying because retries cannot succeed until the model or the plan changes. Switch this agent to a model the plan includes, or upgrade the plan, then retry starting this agent.`;
}

/**
 * #proj-raft-computer:#46 (reconciler step 4a): what an agent shows while its
 * deliveries are held for an invalid credential it did not see rejected
 * itself: the copy of the error the agent that saw it shows, and, on a
 * machine-shared sign-in, that another agent on it reported it. Published as
 * the agent's idle status, never as a runtime error (see the hosts'
 * `credentialInvalidHeldNotice`).
 */
export function formatCredentialInvalidHeldNotice(
  runtimeId: string,
  record: { invalidReason: CredentialInvalidReason; code?: ReadinessCode },
  model: string | null | undefined,
  sharedSignIn: boolean,
): string {
  const reason = record.invalidReason;
  const problem = (CREDENTIAL_PROBLEM_CODES as readonly string[]).includes(record.code ?? "") ? record.code as CredentialProblemCode : null;
  const copy = problem
    ? CREDENTIAL_PROBLEM_MESSAGES[problem]
    : reason === "billing"
    ? formatRuntimeBillingExhaustedMessage(runtimeId)
    : reason === "user_model_access"
      ? formatRuntimePlanAccessMessage(runtimeId, model)
      : formatRuntimeLoginRequiredMessage(runtimeId);
  return sharedSignIn ? `${copy} (Reported by another agent on the same sign-in.)` : copy;
}

/**
 * #proj-raft-computer:#68: account problems a provider reports with a typed
 * code (Claude Code's `error` / `api_error_code`), which only the account
 * holder can resolve. The daemon shows its own fixed text for them, never the
 * provider's wording or a link from it. The text classifies as `AuthError`
 * with `user_reauth`, so an older server still pauses the agent and tells its
 * owner; `credentialProblemCodeOf` reads the code back. One code in this step;
 * the next is one more entry.
 */
export const CREDENTIAL_PROBLEM_CODES = ["verification_required"] as const satisfies readonly ReadinessCode[];
export type CredentialProblemCode = (typeof CREDENTIAL_PROBLEM_CODES)[number];

const CREDENTIAL_PROBLEM_PREFIX = "The provider refused this request";

export const CREDENTIAL_PROBLEM_MESSAGES: Readonly<Record<CredentialProblemCode, string>> = {
  verification_required: `${CREDENTIAL_PROBLEM_PREFIX} (verification_required): the account signed in for this agent can't receive replies until its holder verifies it. `
    + `The account holder must finish the step in the Anthropic Verification Portal (${ANTHROPIC_VERIFICATION_PORTAL_URL}), then retry this agent. Messages are kept and will be delivered.`,
};

const CREDENTIAL_PROBLEM_TEXT = new RegExp(`^${CREDENTIAL_PROBLEM_PREFIX} \\((${CREDENTIAL_PROBLEM_CODES.join("|")})\\):`);

/** The account problem a daemon-authored message (`CREDENTIAL_PROBLEM_MESSAGES`) is about, else null. */
export function credentialProblemCodeOf(message: string): CredentialProblemCode | null {
  const match = CREDENTIAL_PROBLEM_TEXT.exec(String(message || ""));
  return match ? match[1] as CredentialProblemCode : null;
}

export function isRuntimeInputTooLargeErrorText(message: string): boolean {
  const rawMessage = String(message || "");
  return classifyRuntimeError(rawMessage, extractHttpStatus(rawMessage)) === "InputTooLargeError";
}

export function buildRuntimeErrorActivityDiagnostic(
  message: string,
  metadata: {
    nativeReasonPresent?: boolean;
    reasonProvenance?: RuntimeErrorReasonProvenance;
    /**
     * task #1127 — a caller that already holds a typed code supplies it here so
     * the class is decided by that code rather than re-derived from the text.
     * The text is still used for the fingerprint, and only for that.
     */
    errorClass?: RuntimeErrorClass;
  } = {},
): RuntimeErrorActivityDiagnostic {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
  const errorClass = metadata.errorClass ?? normalizeRuntimeErrorClass(envelope.spanAttrs.runtime_error_class);
  const requiredAction = classifyRuntimeErrorAction(errorClass, message);
  const readinessCode = credentialProblemCodeOf(message);
  return {
    errorClass,
    errorReason: metadata.errorClass
      ? runtimeErrorReasonForClass(metadata.errorClass)
      : normalizeRuntimeErrorReason(envelope.spanAttrs.turn_reason),
    fingerprint: String(envelope.spanAttrs.runtime_error_fingerprint),
    reasonProvenance: metadata.reasonProvenance ?? "runtime_error_event",
    ...(typeof metadata.nativeReasonPresent === "boolean"
      ? { nativeReasonPresent: metadata.nativeReasonPresent }
      : {}),
    ...(requiredAction !== "none" ? { requiredAction } : {}),
    ...(readinessCode ? { readinessCode } : {}),
  };
}

function normalizeRuntimeErrorClass(value: unknown): RuntimeErrorClass {
  switch (value) {
    case "InputTooLargeError":
    case "RateLimitError":
    case "AuthError":
    case "LauncherError":
    case "NotFoundError":
    case "ModelConfigError":
    case "TimeoutError":
    case "ProviderConnectionError":
    case "ProviderStreamError":
    case "ProviderServerError":
    case "ProviderApiError":
    case "OperationAbortedError":
    case "BillingError":
      return value;
    default:
      return "RuntimeError";
  }
}

function normalizeRuntimeErrorReason(value: unknown): RuntimeErrorReason {
  switch (value) {
    case "input_too_large":
    case "rate_limited":
    case "auth_failed":
    case "launcher_error":
    case "not_found":
    case "model_config_error":
    case "provider_timeout":
    case "provider_connection_error":
    case "provider_stream_error":
    case "provider_server_error":
    case "provider_api_error":
    case "operation_aborted":
    case "billing_exhausted":
      return value;
    default:
      return "unclassified_runtime_error";
  }
}

export function formatRuntimeLoginRequiredMessage(runtimeId: string): string {
  if (runtimeId === "builtin") {
    return "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.";
  }
  // Pi talks to model providers with API keys (environment or Pi's auth file);
  // a rejected request is almost always a bad or missing key, not a Pi login.
  if (runtimeId === "pi") {
    return "Pi's model provider rejected the API key, or no key is set for it on this machine. Check the API key for this agent's provider, then retry starting this agent.";
  }
  // Qwen Code has no login of its own: its provider is set by environment variables.
  if (runtimeId === "qwen") {
    return "Qwen Code's model provider rejected the request, or no provider is set. Set OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL in this agent's environment variables (or Qwen Code's settings on this machine), then retry starting this agent.";
  }
  if (runtimeId === "qoder") {
    return "Qoder is not logged in on this machine. Run `qodercli login` there, then retry starting this agent.";
  }
  if (runtimeId === "codebuddy") {
    return "CodeBuddy Code is not signed in on this machine. Sign in from its card on the Computer page (or run `codebuddy` there and sign in), then retry starting this agent.";
  }
  const runtimeLabel = runtimeDisplayName(runtimeId);
  return `${runtimeLabel} is not logged in on this machine. Please log in to ${runtimeLabel} locally, then retry starting this agent.`;
}

function formatStartTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** A free-tier model id: `opencode/…-free`, OpenRouter `…:free`. */
function isFreeTierModel(model: string): boolean {
  return /(?:^|[-:/])free$/i.test(model);
}

/**
 * The runtime started but produced no output within the start timeout. Most
 * such timeouts (OpenCode especially, on its free models) are the provider
 * queueing or rate-limiting the model, so name the model first; installation
 * or login is the less likely cause and stays as the generic hint. Every form
 * keeps "did not finish starting" (`isRuntimeStartTimeoutText`).
 */
export function formatRuntimeStartTimeoutMessage(
  runtimeId: string,
  input: { timeoutMs: number; model?: string | null },
): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  const within = `${runtimeLabel} did not finish starting within ${formatStartTimeoutDuration(input.timeoutMs)}.`;
  const model = input.model?.trim();
  if (runtimeId === "opencode" && model) {
    const tier = isFreeTierModel(model) ? ", free tier" : "";
    return `${within} The selected model (${model}${tier}) may be slow to respond, queued or rate-limited by its provider. Try again later, or switch to another model.`;
  }
  return `${within} Its model provider may be slow or rate-limited; also check that ${runtimeLabel} is installed, logged in, and can run non-interactively on this machine, then retry starting this agent.`;
}

// Raft offers no user-triggerable compaction, and Restart reloads the same
// session (Grok session/load, Pi/Built-in session file). For these runtimes,
// name the control that actually starts a new session, with its web labels
// ("Restart / Reset" → "Reset Session & Restart"; members see "Reset Model").
// Other runtimes keep the generic text until their recovery paths are verified
// one by one.
const RESET_GUIDED_INPUT_TOO_LARGE_RUNTIMES = new Set(["grok", "pi", "builtin"]);

/** How to start a new session from the web, for runtimes whose Restart resumes the same session. */
export function formatRuntimeResetSessionGuidance(): string {
  return "To start a new session, someone who can manage this agent can open Restart / Reset and choose Reset Session & Restart "
    + "(shown as Reset Model for members). This stops current work and clears the runtime conversation context, "
    + "while keeping Raft messages and workspace files, including MEMORY.md.";
}

export function runtimeNeedsResetSessionGuidance(runtimeId: string): boolean {
  return RESET_GUIDED_INPUT_TOO_LARGE_RUNTIMES.has(runtimeId);
}

export function formatRuntimeInputTooLargeMessage(runtimeId: string): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  if (runtimeNeedsResetSessionGuidance(runtimeId)) {
    return `${runtimeLabel} reported input that is too large for the selected model. Restart keeps the existing session. `
      + `${formatRuntimeResetSessionGuidance()} `
      + "If the error persists in a new session, reduce the prompt or configured startup context.";
  }
  return `${runtimeLabel} reported input that is too large for the selected model. Reduce the current prompt or injected startup context. For a resumed session, compact it or start a new session before retrying.`;
}

/**
 * The most one input may hold, in UTF-8 bytes, where OAR refuses a longer one
 * before sending it (its `maxInputBytes`: agy cuts a longer input without
 * saying so). OAR 0.103's Antigravity bound; said in the error only.
 */
const RUNTIME_MAX_INPUT_BYTES: Readonly<Record<string, number>> = { antigravity: 185_000 };

/**
 * What the agent's managers read when OAR refused an input for its length
 * (`input_too_large` on a refused prompt): the message, not the session, is
 * too long. Raft's own words, never OAR's reason (shared
 * `MESSAGE_TOO_LARGE_PATTERN` reads this sentence for an untyped row).
 */
export function formatRuntimeMessageTooLargeMessage(runtimeId: string): string {
  const maxBytes = RUNTIME_MAX_INPUT_BYTES[runtimeId];
  const bound = maxBytes ? ` (over about ${Math.round(maxBytes / 1000)} KB)` : "";
  return `This message is too long for ${runtimeDisplayName(runtimeId)} to take in one message${bound}, so it was not delivered. Shorten it, or split it into several messages.`;
}

/**
 * A start whose first input is over the runtime's one-input bound even
 * without any message (the standing prompt and startup context alone):
 * failed here, never handed to an older driver that would cut it.
 */
export function formatRuntimeStartupInputTooLargeMessage(runtimeId: string): string {
  const maxBytes = RUNTIME_MAX_INPUT_BYTES[runtimeId];
  const bound = maxBytes ? ` (over about ${Math.round(maxBytes / 1000)} KB)` : "";
  return `This agent's startup input is too long for ${runtimeDisplayName(runtimeId)} to take in one message${bound}, so it was not started. Shorten its MEMORY.md or startup context, then start it again.`;
}

// #wg-rbac:#57: the scrubber and the 512-char bound live in shared
// (runtimeErrorVisibility), so the server applies the same rule to every
// runtime error text it receives and serves. The daemon names stay.
export const scrubRuntimeErrorDiagnosticText = scrubRuntimeErrorText;

/** #688 bounded-diagnostic half: redact + cap a user-visible error string (decision-
 * package ~512B bound). Never return raw or unbounded lastRuntimeError/stderr to a
 * user-visible surface; the typed carrier keeps the full scrubbed fingerprint. */
export const MAX_VISIBLE_CRASH_DETAIL_CHARS = MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS;
export function buildBoundedVisibleCrashDetail(raw: string): string {
  return boundedRuntimeErrorDetail(raw);
}

function truncateDiagnosticText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function extractHttpStatus(message: string): number | null {
  const match = /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message)
    ?? /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/i.exec(message)
    ?? /\b([45]\d{2})\s*:/i.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/**
 * Connection evidence the close policy has always acted on: a socket error
 * code, or "Unable to connect to API".
 */
const SOCKET_CONNECTION_ERROR = /\b(?:ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|\bUnable to connect to API\b/i;
/**
 * task #927: a Rust (reqwest) runtime such as Grok CLI says a request could
 * not be sent as "error sending request for url (...)", with no socket code.
 * It is diagnosed as a connection error. The process-close policy does not
 * read this rule (see runtimeErrorClassForProcessClose).
 */
const REQUEST_SEND_FAILURE = /\berror sending request for url\b/i;

/**
 * The class the process-close policy decides on: the diagnostic class
 * without the request-send-failure rule, so a close is recoverable for
 * exactly the inputs it was before task #927 (an explicit
 * `ProviderConnectionError`, socket codes, "Unable to connect to API", ...).
 */
export function runtimeErrorClassForProcessClose(message: string): string {
  const rawMessage = String(message || "");
  return classifyRuntimeError(rawMessage, extractHttpStatus(rawMessage), { requestSendFailure: false });
}

function classifyRuntimeError(message: string, httpStatus: number | null, rules: { requestSendFailure?: boolean } = {}): string {
  // #proj-raft-computer:#68: the daemon's own text for a typed account
  // problem: the holder must act, as for a rejected sign-in.
  if (credentialProblemCodeOf(message)) return "AuthError";
  if (RUNTIME_LAUNCHER_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "LauncherError";
  }
  const explicit = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(message);
  if (explicit && /InputTooLargeError/i.test(explicit[1])) return "InputTooLargeError";
  if (
    (explicit && /^(?:AbortError|OperationAbortedError)$/i.test(explicit[1]))
    || /^\s*(?:this\s+)?operation was aborted\.?\s*$/i.test(message)
  ) {
    return "OperationAbortedError";
  }
  if (
    /\bINPUT_TOO_LARGE\b/i.test(message) ||
    /\binput too large\b/i.test(message) ||
    /\bexceeds the maximum allowed\b/i.test(message) ||
    (
      /\bmaximum context length is [\d,]+ tokens?\b/i.test(message) &&
      /\byou requested [\d,]+ tokens?\b/i.test(message)
    )
  ) {
    return "InputTooLargeError";
  }
  // task #917 — billing exhaustion is checked before the generic status mapping
  // so a 402 never lands in the retryable ProviderApiError bucket.
  if (httpStatus === 402 || RUNTIME_BILLING_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(message))) {
    return "BillingError";
  }
  // task #352 — plan/subscription-without-model is decided before the status
  // mapping so a 429 (or 403) carrying that wording never lands in the
  // retryable RateLimitError bucket.
  if (isRuntimePlanAccessText(message)) return "ModelConfigError";
  if (explicit) return explicit[1];
  if (httpStatus !== null) {
    if (httpStatus === 429) return "RateLimitError";
    if (httpStatus === 401) return "AuthError";
    if (httpStatus === 403) {
      return isRuntimeAuthActionRequiredText(message) ? "AuthError" : "ProviderApiError";
    }
    if (httpStatus === 404) return "NotFoundError";
    if (httpStatus >= 500) return "ProviderServerError";
    return "ProviderApiError";
  }
  if (isRuntimeAuthActionRequiredText(message)) return "AuthError";
  if (
    /\bmodel\b.*\bnot supported\b/i.test(message) ||
    /\bunsupported\b.*\bmodel\b/i.test(message) ||
    /\bmodel\b.*\bnot available\b/i.test(message)
  ) {
    return "ModelConfigError";
  }
  if (/\b(?:ETIMEDOUT|timeout|timed out)\b/i.test(message)) return "TimeoutError";
  if (SOCKET_CONNECTION_ERROR.test(message) || (rules.requestSendFailure !== false && REQUEST_SEND_FAILURE.test(message))) {
    return "ProviderConnectionError";
  }
  if (/stream closed before response\.completed|error decoding response body/i.test(message)) return "ProviderStreamError";
  if (/\b(?:selected\s+)?model\s+is\s+at\s+capacity\b/i.test(message)) return "RateLimitError";
  if (/\brate.?limit|too many requests\b/i.test(message)) return "RateLimitError";
  if (/\bnot found\b/i.test(message)) return "NotFoundError";
  return "RuntimeError";
}

export type RuntimeErrorAction = "none" | RuntimeErrorRequiredAction;

function classifyRuntimeErrorAction(runtimeErrorClass: string, message: string): RuntimeErrorAction {
  if (runtimeErrorClass === "AuthError") {
    return "user_reauth";
  }
  // task #352 — only the plan-without-model wording is action-required; other
  // ModelConfigError texts keep their existing sticky-terminal path.
  if (runtimeErrorClass === "ModelConfigError" && isRuntimePlanAccessText(message)) {
    return "user_model_access";
  }
  return "none";
}

function isRuntimePlanAccessText(text: string): boolean {
  if (RUNTIME_TRANSIENT_LIMIT_MARKERS.some((pattern) => pattern.test(text))) return false;
  return RUNTIME_PLAN_ACCESS_PATTERNS.some((pattern) => pattern.test(text));
}

export function isRuntimePlanAccessErrorText(message: string): boolean {
  return isRuntimePlanAccessText(String(message || ""));
}

/**
 * #proj-raft-computer:#46 (reconciler step 4a): a runtime error that says the
 * current version of the agent's provider credential is invalid, not that the
 * runtime process is broken: a rejected sign-in or key (`user_reauth`), a
 * plan without the model (`user_model_access`), an exhausted billing balance
 * (`billing`). Exactly the existing classification: the action-required
 * errors and the BillingError class. Null for everything else.
 */
export function credentialInvalidReasonOf(message: string): CredentialInvalidReason | null {
  const rawMessage = String(message || "");
  const runtimeErrorClass = classifyRuntimeError(rawMessage, extractHttpStatus(rawMessage));
  if (runtimeErrorClass === "BillingError") return "billing";
  const action = classifyRuntimeErrorAction(runtimeErrorClass, rawMessage);
  return action === "none" ? null : action;
}

function isRuntimeAuthActionRequiredText(text: string): boolean {
  return RUNTIME_AUTH_ACTION_REQUIRED_PATTERNS.some((pattern) => pattern.test(text));
}

function classifyRuntimeErrorReason(runtimeErrorClass: string): string {
  switch (runtimeErrorClass) {
    case "ProviderConnectionError":
      return "provider_connection_error";
    case "TimeoutError":
      return "provider_timeout";
    case "ProviderStreamError":
      return "provider_stream_error";
    case "RateLimitError":
      return "rate_limited";
    case "AuthError":
      return "auth_failed";
    case "LauncherError":
      return "launcher_error";
    case "NotFoundError":
      return "not_found";
    case "ModelConfigError":
      return "model_config_error";
    case "InputTooLargeError":
      return "input_too_large";
    case "ProviderServerError":
      return "provider_server_error";
    case "ProviderApiError":
      return "provider_api_error";
    case "OperationAbortedError":
      return "operation_aborted";
    case "BillingError":
      return "billing_exhausted";
    default:
      return "unclassified_runtime_error";
  }
}

function extractInputTooLargeAttrs(message: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const estimatedTokens = firstIntegerMatch(message, [
    /\bestimated\s+([\d,]+)\s+tokens?\b/i,
  ]);
  if (estimatedTokens !== null) attrs.runtime_input_estimated_tokens = estimatedTokens;

  const budgetTokens = firstIntegerMatch(message, [
    /\bbudget\s+([\d,]+)\b/i,
  ]);
  if (budgetTokens !== null) attrs.runtime_input_budget_tokens = budgetTokens;

  const contextLimitTokens = firstIntegerMatch(message, [
    /\bcontext limit\s+([\d,]+)\b/i,
    /\bmaximum allowed[^()]*\(([\d,]+)\)/i,
    /\bmaximum context length is\s+([\d,]+)\s+tokens?\b/i,
  ]);
  if (contextLimitTokens !== null) attrs.runtime_input_context_limit_tokens = contextLimitTokens;

  const requestedTokens = firstIntegerMatch(message, [
    /\byou requested\s+([\d,]+)\s+tokens?\b/i,
  ]);
  if (requestedTokens !== null) attrs.runtime_input_requested_tokens = requestedTokens;

  const messageTokens = firstIntegerMatch(message, [
    /\(([\d,]+)\s+in the messages?\b/i,
  ]);
  if (messageTokens !== null) attrs.runtime_input_message_tokens = messageTokens;

  const completionTokens = firstIntegerMatch(message, [
    /\b([\d,]+)\s+in the completion\b/i,
  ]);
  if (completionTokens !== null) attrs.runtime_input_completion_tokens = completionTokens;

  if (contextLimitTokens !== null && requestedTokens !== null && requestedTokens > contextLimitTokens) {
    attrs.runtime_input_overage_tokens = requestedTokens - contextLimitTokens;
  }

  const model = /\bmodel\s+([A-Za-z0-9._:/+-]+)\b/i.exec(message);
  if (model) attrs.runtime_input_model = model[1];

  return attrs;
}

function firstIntegerMatch(message: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const parsed = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/**
 * Prose-safe runtime name, resolved from the canonical `RUNTIMES` table in
 * shared so a new runtime is one table edit, not one edit per message site.
 * The `|| "This runtime"` guard covers an empty id, which the canonical
 * resolver returns verbatim.
 */
export function runtimeDisplayName(runtimeId: string): string {
  return getRuntimeDisplayName(runtimeId) || "This runtime";
}

// The parts of an error text that change between occurrences of the same
// error: a usage limit's reset time ("resets 1pm (UTC)", "[01:24:56]"), a
// date, a wait. AndyLok: Claude's limit errors alone had 102 fingerprints for
// one kind of error. Each becomes a placeholder; the words stay, so different
// errors keep different fingerprints. Applied to lower-cased text, in order.
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?";
const FINGERPRINT_VOLATILE_PARTS: ReadonlyArray<[RegExp, string]> = [
  // ISO date or date-time, with its offset.
  [/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:z\b|[+-]\d{2}:?\d{2}\b)?/g, "<date>"],
  // "Nov 14", "November 14th, 2026", "14 Nov 2026".
  [new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, "g"), "<date>"],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?\\b`, "g"), "<date>"],
  [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/g, "<date>"],
  // Clock times: "13:05", "01:24:56", "1:30pm", "1pm", "11 am".
  [/\b\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?(?:\s*[ap]\.?m\b\.?)?/g, "<time>"],
  [/\b\d{1,2}\s*[ap]\.?m\b\.?/g, "<time>"],
  // Time zones: IANA names, UTC/GMT offsets, common abbreviations.
  [/\b(?:africa|america|antarctica|asia|atlantic|australia|europe|indian|pacific|etc)\/[a-z_+-]+(?:\/[a-z_]+)?/g, "<tz>"],
  [/\b(?:utc|gmt)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/g, "<tz>"],
  [/\b(?:utc|gmt|[pmce][sd]t|bst|cet|cest|eet|eest|ist|jst|kst|hkt|sgt|aest|aedt|awst|nzst|nzdt)\b/g, "<tz>"],
  // Durations: "2h", "30 min", "5 seconds", "1.5s".
  [/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\b/g, "<duration>"],
];

// Identifiers minted per request (AndyLok: one invalid-model error from a
// custom Codex provider had 3 fingerprints in 3 turns). Applied first, to the
// lower-cased text: a labelled request/trace id whatever its shape, a UUID,
// a prefixed id (`req_…`, `chatcmpl-…`), then any run of hex or of letters
// and digits long enough to be an id. Runs of letters only (words) and of
// digits only (`<num>` below) are not ids. Linear: no lookahead scans a run.
const FINGERPRINT_ID_PARTS: ReadonlyArray<[RegExp, string | ((match: string) => string)]> = [
  [/\b(x-request-id|request[ _-]?id|req[ _-]?id|trace[ _-]?id|correlation[ _-]?id|cf-ray)(["']?\s*[:=]\s*["']?)[^\s,;"'(){}[\]]+/g, "$1$2<id>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>"],
  [/\b(req|msg|resp|chatcmpl|call|run|gen|evt)[_-][a-z0-9]{8,}\b/g, (match) => /\d/.test(match) ? `${match.slice(0, match.search(/[_-]/))}_<id>` : match],
  [/\b[0-9a-f]{8,}\b/g, (match) => /\d/.test(match) ? "<hex>" : match],
  [/\b[a-z0-9]{16,}\b/g, (match) => /\d/.test(match) && /[a-z]/.test(match) ? "<id>" : match],
];

/** The text a runtime error's fingerprint is the hash of. */
export function normalizeRuntimeErrorForFingerprint(value: string): string {
  let normalized = value.toLowerCase();
  for (const [pattern, placeholder] of FINGERPRINT_ID_PARTS) {
    normalized = typeof placeholder === "string" ? normalized.replace(pattern, placeholder) : normalized.replace(pattern, placeholder);
  }
  normalized = normalized.replace(/[0-9a-f]{12,}/g, "<hex>");
  for (const [pattern, placeholder] of FINGERPRINT_VOLATILE_PARTS) normalized = normalized.replace(pattern, placeholder);
  return normalized
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintRuntimeError(value: string): string {
  const normalized = normalizeRuntimeErrorForFingerprint(value);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function bucketLength(length: number): string {
  if (length === 0) return "0";
  if (length < 1024) return "<1k";
  if (length < 4096) return "1k-4k";
  if (length < 16384) return "4k-16k";
  return "16k+";
}

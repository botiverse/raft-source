import { createHash } from "node:crypto";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type {
  RuntimeErrorActivityDiagnostic,
  RuntimeErrorClass,
  RuntimeErrorReason,
  RuntimeErrorReasonProvenance,
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
  const runtimeErrorAction = classifyRuntimeErrorAction(runtimeErrorClass);
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

export function isRuntimeInputTooLargeErrorText(message: string): boolean {
  const rawMessage = String(message || "");
  return classifyRuntimeError(rawMessage, extractHttpStatus(rawMessage)) === "InputTooLargeError";
}

export function buildRuntimeErrorActivityDiagnostic(
  message: string,
  metadata: {
    nativeReasonPresent?: boolean;
    reasonProvenance?: RuntimeErrorReasonProvenance;
  } = {},
): RuntimeErrorActivityDiagnostic {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
  return {
    errorClass: normalizeRuntimeErrorClass(envelope.spanAttrs.runtime_error_class),
    errorReason: normalizeRuntimeErrorReason(envelope.spanAttrs.turn_reason),
    fingerprint: String(envelope.spanAttrs.runtime_error_fingerprint),
    reasonProvenance: metadata.reasonProvenance ?? "runtime_error_event",
    ...(typeof metadata.nativeReasonPresent === "boolean"
      ? { nativeReasonPresent: metadata.nativeReasonPresent }
      : {}),
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
      return value;
    default:
      return "unclassified_runtime_error";
  }
}

export function formatRuntimeLoginRequiredMessage(runtimeId: string): string {
  if (runtimeId === "builtin") {
    return "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.";
  }
  const runtimeLabel = runtimeDisplayName(runtimeId);
  return `${runtimeLabel} is not logged in on this machine. Please log in to ${runtimeLabel} locally, then retry starting this agent.`;
}

export function formatRuntimeStartTimeoutMessage(runtimeId: string): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  return `${runtimeLabel} did not finish starting on this machine. Check that ${runtimeLabel} is installed, logged in, and can run non-interactively, then retry starting this agent.`;
}

export function formatRuntimeInputTooLargeMessage(runtimeId: string): string {
  const runtimeLabel = runtimeDisplayName(runtimeId);
  return `${runtimeLabel} reported input that is too large for the selected model. Reduce the current prompt or injected startup context. For a resumed session, compact it or start a new session before retrying.`;
}

// Env/field-assignment redaction (§#688 load-bearing): a value assigned to a
// secret-shaped key (ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, *_TOKEN, etc.) is
// a credential leak vector if it reaches a user-visible surface. Redact only the
// assigned value; keep the key label for diagnostics. The KEY names that match are
// restricted to explicit secret-signal words so we do not over-redact benign
// assignments (e.g. `NODE_ENV=production` must survive).
const SECRET_ASSIGNMENT_KEY_PATTERN =
  /\b([A-Za-z0-9._-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|PRIVKEY|CREDENTIAL)[A-Za-z0-9._-]*)\s*(?:=|:)\s*("[^"]*"|'[^']*'|[^\s;,"'<>]+)/gi;
// GitHub token family (ghp/gho/ghs/ghu/ghr), bare and not caught by the URL/
// path redactors. Also npx/npm-style auth tokens and the common `github_pat_`
// personal-access-token prefix, all of which are credential-shaped bare text.
const GITHUB_TOKEN_FAMILY_PATTERN =
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/g;
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:password|passwd|secret|token)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;,]+)/gi;

export function scrubRuntimeErrorDiagnosticText(value: string): string {
  let scrubbed = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlQuery(url))
    .replace(/\/Users\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/\/home\/[^\s"'<>:]+(?:\/[^\s"'<>:]+)*/g, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*/g, "[REDACTED_PATH]");
  // Env/field assignments with a secret-shaped key: keep the key label, redact value.
  scrubbed = scrubbed.replace(SECRET_ASSIGNMENT_KEY_PATTERN, (match, key: string) => {
    const keyLabel = String(key).trim();
    return `${keyLabel}=[REDACTED_TOKEN]`;
  });
  // Generic credential assignment (password/secret/token = value): redact value.
  scrubbed = scrubbed.replace(GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, (_m, prefix: string) => {
    return `${prefix}[REDACTED_TOKEN]`;
  });
  // GitHub token family + github_pat_.
  scrubbed = scrubbed.replace(GITHUB_TOKEN_FAMILY_PATTERN, "[REDACTED_TOKEN]");
  return scrubbed;
}

/** #688 bounded-diagnostic half: redact + cap a user-visible error string (decision-
 * package ~512B bound). Never return raw or unbounded lastRuntimeError/stderr to a
 * user-visible surface; the typed carrier keeps the full scrubbed fingerprint. */
export const MAX_VISIBLE_CRASH_DETAIL_CHARS = 512;
export function buildBoundedVisibleCrashDetail(raw: string): string {
  const scrubbed = scrubRuntimeErrorDiagnosticText(raw);
  return scrubbed.length <= MAX_VISIBLE_CRASH_DETAIL_CHARS ? scrubbed : scrubbed.slice(0, MAX_VISIBLE_CRASH_DETAIL_CHARS);
}

function truncateDiagnosticText(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function extractHttpStatus(message: string): number | null {
  const match = /\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b/i.exec(message)
    ?? /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b/i.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

function classifyRuntimeError(message: string, httpStatus: number | null): string {
  if (RUNTIME_LAUNCHER_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) {
    return "LauncherError";
  }
  const explicit = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/.exec(message);
  if (explicit && /InputTooLargeError/i.test(explicit[1])) return "InputTooLargeError";
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
  if (
    /\b(?:ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i.test(message)
    || /\bUnable to connect to API\b/i.test(message)
  ) {
    return "ProviderConnectionError";
  }
  if (/stream closed before response\.completed|error decoding response body/i.test(message)) return "ProviderStreamError";
  if (/\b(?:selected\s+)?model\s+is\s+at\s+capacity\b/i.test(message)) return "RateLimitError";
  if (/\brate.?limit|too many requests\b/i.test(message)) return "RateLimitError";
  if (/\bnot found\b/i.test(message)) return "NotFoundError";
  return "RuntimeError";
}

function classifyRuntimeErrorAction(runtimeErrorClass: string): "none" | "user_reauth" {
  if (runtimeErrorClass === "AuthError") {
    return "user_reauth";
  }
  return "none";
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

function fingerprintRuntimeError(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[0-9a-f]{12,}/g, "<hex>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function bucketLength(length: number): string {
  if (length === 0) return "0";
  if (length < 1024) return "<1k";
  if (length < 4096) return "1k-4k";
  if (length < 16384) return "4k-16k";
  return "16k+";
}

function redactUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) url.search = "?[REDACTED_QUERY]";
    if (url.username) url.username = "[REDACTED_USER]";
    if (url.password) url.password = "[REDACTED_PASSWORD]";
    return url.toString();
  } catch {
    return value.replace(/\?.*$/, "?[REDACTED_QUERY]");
  }
}

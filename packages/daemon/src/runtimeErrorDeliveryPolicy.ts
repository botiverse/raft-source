import type { ParsedEvent } from "./drivers/index";
import { buildRuntimeErrorDiagnosticEnvelope, runtimeErrorClassForProcessClose } from "./runtimeErrorDiagnostics";

export interface RuntimeErrorFingerprintFenceSummary {
  fingerprint: string;
  attempts: number;
  lastRuntimeError: string;
}

export interface RuntimeErrorDeliveryFailureSummary {
  actionRequired: boolean;
}

export function runtimeErrorFingerprintFenceResetEvent(eventKind: ParsedEvent["kind"]): boolean {
  switch (eventKind) {
    case "thinking":
    case "text":
    case "tool_call":
    case "tool_output":
    case "compaction_finished":
    case "review_finished":
    case "turn_end":
      return true;
    default:
      return false;
  }
}

export function formatRuntimeErrorFingerprintFenceDetail(state: RuntimeErrorFingerprintFenceSummary): string {
  return [
    `Runtime stopped after ${state.attempts} repeated runtime errors with the same fingerprint (${state.fingerprint}).`,
    `Last error: ${state.lastRuntimeError}`,
    // Reconciler step 12: the server pauses the agent and retries it by itself.
    "Raft retries it later by itself; fix the runtime or tooling issue if it keeps failing.",
  ].join(" ");
}

/** A provider limit as a runtime declares it on an error event (task #379). */
export interface RuntimeProviderLimit {
  kind: "quota_exhausted" | "transient_rate_limit";
  resetsAt?: string;
}

/**
 * A runtime error's provider limit and where it came from: the runtime's
 * structured declaration, or the usage-limit wording of an error from a
 * runtime that declares none (design row C5).
 */
export type RuntimeErrorProviderLimit = RuntimeProviderLimit & { source: "structured" | "text" };

/**
 * Wording that says the account's usage quota or budget is used up. Exactly
 * the phrases the terminal-failure classifier has always recognised as a
 * usage limit; rate-limit and billing wording have their own classes and are
 * deliberately not matched here.
 */
const RUNTIME_USAGE_LIMIT_PHRASES = ["usage limit", "quota exceeded", "quota limit", "budget limit exceeded"] as const;

/**
 * A provider stream failure the error classes do not name (planExit's
 * `providerStreamFailure`: D3's next wake, counted toward the cap). Read by
 * both agent hosts.
 */
export function isProviderStreamFailureText(text: string): boolean {
  return /stream closed before response\.completed|error decoding response body/i.test(text);
}

export function isRuntimeUsageLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return RUNTIME_USAGE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * The provider limit a runtime error event carries (#proj-raft-computer:#46,
 * C5). A runtime that reports no structured limit but says "usage limit" /
 * "quota exceeded" / "budget limit exceeded" has hit the same used-up quota
 * with no reported reset, so it takes the same path: recorded on the
 * credential, shared with the sign-in's other agents, restored and released
 * exactly like a structured `quota_exhausted` without `resetsAt`.
 */
export function runtimeErrorProviderLimit(event: { message: string; providerLimit?: RuntimeProviderLimit }): RuntimeErrorProviderLimit | undefined {
  if (event.providerLimit) return { ...event.providerLimit, source: "structured" };
  if (isRuntimeUsageLimitText(event.message)) return { kind: "quota_exhausted", source: "text" };
  return undefined;
}

/** First wait of the runtime-error delivery backoff; it doubles per attempt up to the max. */
export const RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS = 10_000;
export const RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * The runtime-error delivery backoff for the `attempts`-th error in a row:
 * `baseMs` doubled per attempt, capped at `maxMs`, plus up to `jitterRatio`
 * of it (`jitterUnit` in [0, 1]), never past `maxMs`. Both agent hosts wait
 * by it (the OAR host for a provider limit with no reported reset).
 */
export function runtimeErrorDeliveryBackoffDelayMs(
  attempts: number,
  policy: { baseMs: number; maxMs: number; jitterRatio: number; jitterUnit: number },
): number {
  const exponentialDelayMs = policy.baseMs * (2 ** Math.max(0, attempts - 1));
  const cappedDelayMs = Math.min(policy.maxMs, exponentialDelayMs);
  const boundedJitterUnit = Number.isFinite(policy.jitterUnit) ? Math.max(0, Math.min(1, policy.jitterUnit)) : 0;
  const jitterMs = Math.floor(cappedDelayMs * policy.jitterRatio * boundedJitterUnit);
  return Math.min(policy.maxMs, cappedDelayMs + jitterMs);
}

/** Longest single provider-limit wait (task #379, Huaihuai; #proj-raft-computer:#46 Q3). */
export const QUOTA_RESET_BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Delay for a provider-limit backoff (task #379). A used-up quota whose
 * runtime reported a valid future reset waits until that reset. A missing,
 * unparseable or past reset (a usage limit known only from its wording
 * included), and every transient throttle, keep the existing exponential
 * delay. Any single provider-limit wait is at most QUOTA_RESET_BACKOFF_MAX_MS
 * (hitting the limit again starts another wait).
 */
export function providerLimitBackoffDelayMs(input: {
  providerLimit: RuntimeProviderLimit | undefined;
  exponentialDelayMs: number;
  nowMs: number;
}): number {
  const limit = input.providerLimit;
  if (!limit) return input.exponentialDelayMs;
  const resetMs = limit.kind === "quota_exhausted" && limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
  const delayMs = Number.isFinite(resetMs) && resetMs > input.nowMs ? resetMs - input.nowMs : input.exponentialDelayMs;
  return Math.min(delayMs, QUOTA_RESET_BACKOFF_MAX_MS);
}

export function recoverableRuntimeDeliveryBackoffReason(
  message: string,
  terminalFailure: RuntimeErrorDeliveryFailureSummary | null,
  stickyTerminalFailure: RuntimeErrorDeliveryFailureSummary | null,
  reasonOverride?: string | null,
): string | null {
  if (stickyTerminalFailure || terminalFailure?.actionRequired) return null;
  if (reasonOverride !== undefined) return reasonOverride;
  if (terminalFailure) return "recoverable_terminal_runtime_error";

  const runtimeErrorClass = buildRuntimeErrorDiagnosticEnvelope(message).spanAttrs.runtime_error_class;
  switch (runtimeErrorClass) {
    case "RateLimitError":
      return "rate_limited";
    case "ProviderServerError":
      return "provider_server_error";
    case "ProviderConnectionError":
      return "provider_connection_error";
    case "ProviderStreamError":
      return "provider_stream_error";
    case "TimeoutError":
      return null;
    default:
      return "runtime_error";
  }
}

export function recoverableRuntimeProcessCloseReason(
  message: string,
  terminalFailure: RuntimeErrorDeliveryFailureSummary | null,
  stickyTerminalFailure: RuntimeErrorDeliveryFailureSummary | null,
): string | null {
  if (stickyTerminalFailure || terminalFailure?.actionRequired) return null;

  // task #927: decided on the class without the request-send-failure rule,
  // so a close is recoverable for exactly the inputs it was before; the new
  // diagnosis never adds an automatic restart.
  const runtimeErrorClass = runtimeErrorClassForProcessClose(message);
  switch (runtimeErrorClass) {
    case "RateLimitError":
      return "rate_limited";
    case "ProviderServerError":
      return "provider_server_error";
    case "ProviderConnectionError":
      return "provider_connection_error";
    case "ProviderStreamError":
      return "provider_stream_error";
    default:
      return null;
  }
}

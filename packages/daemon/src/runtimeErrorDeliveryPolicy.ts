import type { ParsedEvent } from "./drivers/index";
import type { ProviderQuotaRateLimitType } from "./drivers/types";
import { buildRuntimeErrorDiagnosticEnvelope, runtimeErrorClassForProcessClose } from "./runtimeErrorDiagnostics";

export interface RuntimeErrorFingerprintFenceSummary {
  fingerprint: string;
  attempts: number;
  lastRuntimeError: string;
}

export interface RuntimeErrorDeliveryFailureSummary {
  actionRequired: boolean;
}

/**
 * Whether a runtime event is progress that resets the same-fingerprint and
 * error-class fences (task #917): model output, tool use, a finished
 * review. A finished compaction is not: Claude Code compacts, then fails the
 * same turn with "Prompt is too long" (a text it does not class as input too
 * large); when compaction counted, that cycle reset the count every turn and
 * the fence never tripped. A `turn_end` counts only when its turn had such
 * progress (`turnHadProgress`): a turn that ended without any output did not
 * get anywhere. Grok's ACP server answers a rejected `session/prompt` (a
 * provider rate limit, say) by ending the turn bare and sending the error a
 * few ms after it; when the bare turn end reset the fence, every rejection was
 * attempt 1 and the 15 s idle redelivery looped forever. Cursor's failed turn
 * (error, then turn_end) is the same: it no longer resets the count it just
 * added to, unless the turn produced output before the error.
 */
export function runtimeErrorFingerprintFenceResetEvent(eventKind: ParsedEvent["kind"], turnHadProgress: boolean): boolean {
  switch (eventKind) {
    case "thinking":
    case "text":
    case "tool_call":
    case "tool_output":
    case "review_finished":
      return true;
    case "turn_end":
      return turnHadProgress;
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
  /** The limiting window, when the runtime named one (Claude Code's `rateLimitType`, e.g. `seven_day`). */
  rateLimitType?: ProviderQuotaRateLimitType;
}

/**
 * A runtime error's provider limit and where it came from: the runtime's
 * structured declaration, or the usage-limit wording of an error from a
 * runtime that declares none (design row C5).
 */
export type RuntimeErrorProviderLimit = RuntimeProviderLimit & { source: "structured" | "text" | "account_usage" };

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

/**
 * Longest single provider-limit wait when the runtime reported no usable
 * reset (task #379, Huaihuai; #proj-raft-computer:#46 Q3). A wait for a
 * reported reset is not capped by it (#proj-runtime:#66).
 */
export const QUOTA_RESET_BACKOFF_MAX_MS = 60 * 60_000;

/**
 * The furthest ahead a reported quota reset is believed (#proj-runtime:#66).
 * Claude's longest window is seven days; a reset later than this (or a value
 * in milliseconds read as seconds) is no reset, and the limit waits as if
 * none was reported. Also keeps every wait well under setTimeout's 24.8-day limit.
 */
export const PROVIDER_LIMIT_RESET_MAX_AHEAD_MS = 8 * 24 * 60 * 60_000;

/** Most jitter added to a wait for a reported reset, so agents on one sign-in do not all start at the same instant. */
export const PROVIDER_LIMIT_RESET_JITTER_MAX_MS = 30_000;

/**
 * How long until a used-up quota's reported reset, when it is one to wait
 * for: a `quota_exhausted` limit whose `resetsAt` parses, is in the future
 * and at most PROVIDER_LIMIT_RESET_MAX_AHEAD_MS away. Undefined otherwise (a
 * missing, unparseable, past or implausibly far reset, and every transient
 * throttle).
 */
export function providerLimitReportedResetInMs(limit: RuntimeProviderLimit | undefined, nowMs: number): number | undefined {
  if (!limit || limit.kind !== "quota_exhausted" || !limit.resetsAt) return undefined;
  const resetMs = Date.parse(limit.resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const inMs = resetMs - nowMs;
  return inMs > 0 && inMs <= PROVIDER_LIMIT_RESET_MAX_AHEAD_MS ? inMs : undefined;
}

/**
 * Delay for a provider-limit backoff (task #379). A used-up quota whose
 * runtime reported a usable reset (`providerLimitReportedResetInMs`) waits
 * until that reset, plus up to `resetJitter.ratio` of the wait (at most
 * PROVIDER_LIMIT_RESET_JITTER_MAX_MS): a weekly limit waits the days until
 * it resets instead of retrying every hour into the same refusal
 * (#proj-runtime:#66). Model output, a credential change or a manual stop
 * still end it early. Anything else (no reset, an unusable one, a usage
 * limit known only from its wording, every transient throttle) keeps the
 * exponential delay, at most QUOTA_RESET_BACKOFF_MAX_MS (hitting the limit
 * again starts another wait).
 */
export function providerLimitBackoffDelayMs(input: {
  providerLimit: RuntimeProviderLimit | undefined;
  exponentialDelayMs: number;
  nowMs: number;
  resetJitter?: { ratio: number; random: () => number };
}): number {
  const limit = input.providerLimit;
  if (!limit) return input.exponentialDelayMs;
  const untilResetMs = providerLimitReportedResetInMs(limit, input.nowMs);
  if (untilResetMs === undefined) return Math.min(input.exponentialDelayMs, QUOTA_RESET_BACKOFF_MAX_MS);
  if (!input.resetJitter || !(input.resetJitter.ratio > 0)) return untilResetMs;
  const unit = input.resetJitter.random();
  const boundedUnit = Number.isFinite(unit) ? Math.max(0, Math.min(1, unit)) : 0;
  const jitterWindowMs = Math.min(PROVIDER_LIMIT_RESET_JITTER_MAX_MS, untilResetMs * Math.min(1, input.resetJitter.ratio));
  return untilResetMs + Math.floor(jitterWindowMs * boundedUnit);
}

const RATE_LIMIT_WINDOW_LABELS: Readonly<Record<ProviderQuotaRateLimitType, string>> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

/**
 * #proj-runtime:#66: what an agent shows while a used-up quota on its
 * credential holds its messages and it has no error of its own to show (an
 * agent on the same shared sign-in, a process restored into the wait): fixed
 * text with the window and the reported reset, as the error path appends it.
 */
export function formatProviderLimitHeldDetail(limit: { resetsAt?: string; rateLimitType?: ProviderQuotaRateLimitType }): string {
  const window = limit.rateLimitType ? `${RATE_LIMIT_WINDOW_LABELS[limit.rateLimitType]} ` : "";
  const base = `The ${window}usage limit of this agent's provider account is used up; its messages wait until it resets`;
  return limit.resetsAt ? `${base} (limit resets at ${limit.resetsAt})` : base;
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

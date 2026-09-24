import type { ParsedEvent } from "./drivers/types.js";
import { formatRuntimeInputTooLargeMessage } from "./runtimeErrorDiagnostics.js";

export type RuntimeCompactionReason = "manual" | "threshold" | "overflow" | "unknown";
export type RuntimeCompactionOutcome = "compaction_failed_or_exhausted" | "aborted" | "unknown";
export type RuntimeCompactionFailureReason = "recovery_exhausted" | "compaction_failed" | "unknown";

export function normalizeRuntimeCompactionReason(value: unknown): RuntimeCompactionReason {
  switch (value) {
    case "manual":
    case "threshold":
    case "overflow":
      return value;
    default:
      return "unknown";
  }
}

function normalizeRuntimeCompactionOutcome(value: unknown): RuntimeCompactionOutcome {
  switch (value) {
    case "compaction_failed_or_exhausted":
    case "aborted":
      return value;
    default:
      return "unknown";
  }
}

function normalizeRuntimeCompactionFailureReason(value: unknown): RuntimeCompactionFailureReason {
  switch (value) {
    case "recovery_exhausted":
    case "compaction_failed":
      return value;
    default:
      return "unknown";
  }
}

export function projectCompactionInterruptionTraceAttrs(
  event: Extract<ParsedEvent, { kind: "compaction_interrupted" }>,
): Record<string, string> {
  return {
    outcome: normalizeRuntimeCompactionOutcome(event.outcome),
    reason: normalizeRuntimeCompactionReason(event.reason),
    ...(event.failureReason !== undefined
      ? { failure_reason: normalizeRuntimeCompactionFailureReason(event.failureReason) }
      : {}),
  };
}

export function projectStructuredRuntimeTerminalFailure(
  event: ParsedEvent,
  runtimeId: string,
): { detail: string; actionRequired: false; entries?: never } | null {
  return event.kind === "error" && event.terminalReason === "compaction_failed_or_exhausted"
    ? {
        detail: formatRuntimeInputTooLargeMessage(runtimeId),
        actionRequired: false,
      }
    : null;
}

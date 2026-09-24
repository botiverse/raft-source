import type { ParsedEvent } from "./drivers/index.js";
import { buildRuntimeErrorDiagnosticEnvelope } from "./runtimeErrorDiagnostics.js";

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
    "Restart after the runtime/tooling issue is fixed.",
  ].join(" ");
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
    default:
      return null;
  }
}

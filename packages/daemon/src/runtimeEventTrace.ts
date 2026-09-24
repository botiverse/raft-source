import type { ParsedEvent } from "./drivers/index.js";

export type RuntimeDiagnosticEvent =
  Extract<ParsedEvent, { kind: "runtime_diagnostic" }>;
export type RuntimeRecoveryEvent =
  Extract<ParsedEvent, { kind: "runtime_recovery" }>;

const AGENT_PROCESS_ERROR_CLASSES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

export function normalizeAgentProcessErrorClass(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "";
  return AGENT_PROCESS_ERROR_CLASSES.has(candidate) ? candidate : "Error";
}

export function runtimeDiagnosticTraceAttrs(
  event: RuntimeDiagnosticEvent,
): Record<string, unknown> {
  return {
    kind: event.kind,
    severity: event.severity,
    source: event.source,
    itemType: event.itemType,
    payloadBytes: event.payloadBytes,
    message_present: Boolean(event.message),
    details_present: Boolean(event.details),
    path_present: Boolean(event.path),
    range_present: event.range !== undefined,
    session_id_present: Boolean(event.sessionId),
    input_evidence: event.inputEvidence,
    reason_present: event.reasonPresent,
  };
}

export function runtimeRecoveryTraceAttrs(
  event: RuntimeRecoveryEvent,
): Record<string, unknown> {
  return {
    kind: event.kind,
    source: event.source,
    resume_error_class: event.resumeErrorClass,
    recovery_action: event.recoveryAction,
    requested_session_id_present: Boolean(event.requestedSessionId),
    message_present: Boolean(event.message),
    details_present: Boolean(event.details),
  };
}

export function runtimeTurnEventTraceAttrs(
  event: ParsedEvent,
): Record<string, unknown> {
  if ((event.kind === "thinking" || event.kind === "text") && event.runtimeTurn) {
    return {
      kind: event.kind,
      runtime_turn_generation: event.runtimeTurn.generation,
      runtime_turn_state: event.runtimeTurn.state,
    };
  }
  return { kind: event.kind };
}

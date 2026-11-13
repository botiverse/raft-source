/**
 * RFC 071 part 2 — daemon side of the terminal-failure breaker wire.
 *
 * Pure helpers for the `agent:runtime:outcome` v1 frame:
 *  - E1 `terminal_failure`: which terminal path ended the launch, and a
 *    fingerprint of the RAW runtime text. The Pi mapper replaces the SDK text
 *    with a display constant on the error event (`"RuntimeError: context
 *    compaction failed"`); every compaction failure would then share one
 *    fingerprint (`8745f170c58c4901`). The raw text survives only as
 *    `compaction.failureDiagnostic`, so that is preferred (RFC test W-2).
 *  - E2 `turn_completed`: per-turn counters, and the rule that decides
 *    whether a turn end is recovery evidence (RFC §4.4).
 *
 * The APM owns the sending (it holds launchId, sessionId and the per-agent
 * clientSeq); nothing here reads daemon state.
 */
import { RUNTIME_ERROR_CLASSES } from "@botiverse/raft-shared";
import type {
  AgentRuntimeOutcome,
  AgentRuntimeTerminalFailureKind,
  RuntimeCompactionInterruption,
  RuntimeErrorClass,
} from "@botiverse/raft-shared";
import type { ParsedEvent } from "./drivers/index";
import { buildRuntimeErrorActivityDiagnostic } from "./runtimeErrorDiagnostics";

/** The required failure argument of `releaseFailedProcess` / `actOnStickyFailure` (RFC §7 "Where E1 is emitted"). */
export interface TerminalRuntimeFailureEvidence {
  failureKind: AgentRuntimeTerminalFailureKind;
  /** 16 hex, from the raw runtime text. */
  fingerprint: string;
  errorClass: RuntimeErrorClass;
}

/** Fingerprint and class of a raw runtime text (the same normalisation as runtime_error activity). */
export function terminalFailureFromRawText(
  failureKind: AgentRuntimeTerminalFailureKind,
  rawText: string,
  /** The class the error's turn span carries, when it is known (a typed provider error). */
  errorClass?: string,
): TerminalRuntimeFailureEvidence {
  const knownClass = errorClass && (RUNTIME_ERROR_CLASSES as readonly string[]).includes(errorClass) ? errorClass as RuntimeErrorClass : undefined;
  const diagnostic = buildRuntimeErrorActivityDiagnostic(rawText, knownClass ? { errorClass: knownClass } : {});
  return { failureKind, fingerprint: diagnostic.fingerprint, errorClass: diagnostic.errorClass };
}

function compactionFailureKind(
  event: { message: string },
  compaction: RuntimeCompactionInterruption | undefined,
): AgentRuntimeTerminalFailureKind {
  if (compaction?.failureReason === "recovery_exhausted") return "compaction_recovery_exhausted";
  if (compaction?.failureReason === "input_too_large") return "compaction_input_too_large";
  // Older structured events carry no compaction facts; keep their classifier
  // (same rule as projectStructuredRuntimeTerminalFailure).
  if (compaction === undefined && event.message === "InputTooLargeError") return "compaction_input_too_large";
  return "compaction_failed";
}

/**
 * E1 evidence for the sticky branch of the runtime `error` handler: the
 * compaction failure diagnostic (built from the raw SDK text) when present,
 * else the raw `event.message`. When the SDK supplied no error text at all,
 * `event.message` is the only text there is.
 */
export function terminalFailureFromRuntimeErrorEvent(
  event: { message: string; terminalReason?: string },
  compaction: RuntimeCompactionInterruption | undefined,
): TerminalRuntimeFailureEvidence {
  const failureKind: AgentRuntimeTerminalFailureKind = event.terminalReason === "compaction_failed_or_exhausted"
    ? compactionFailureKind(event, compaction)
    : "sticky_runtime_error";
  const diagnostic = compaction?.failureDiagnostic;
  if (diagnostic) {
    return { failureKind, fingerprint: diagnostic.fingerprint, errorClass: diagnostic.errorClass };
  }
  return terminalFailureFromRawText(failureKind, event.message);
}

/**
 * Per-turn facts for E2. Unlike `runtimeTraceCounters` (reset whenever a turn
 * span opens, and a runtime `error` closes the span, so output after an error
 * opens a fresh span and forgets the error), these are reset only at
 * `turn_end`: an error anywhere since the previous turn end disqualifies the
 * turn. That can delay recovery evidence by a turn; it never produces a false one.
 */
export interface TurnOutcomeCounters {
  textEvents: number;
  toolCalls: number;
  runtimeErrors: number;
}

export function createTurnOutcomeCounters(): TurnOutcomeCounters {
  return { textEvents: 0, toolCalls: 0, runtimeErrors: 0 };
}

export function noteTurnOutcomeEvent(counters: TurnOutcomeCounters, event: ParsedEvent): void {
  switch (event.kind) {
    case "text":
      counters.textEvents++;
      break;
    case "tool_call":
      counters.toolCalls++;
      break;
    case "error":
      counters.runtimeErrors++;
      break;
  }
}

/**
 * RFC §4.4 conditions 2 and 3 (condition 1, a registered launch, is the
 * caller's): no sticky terminal failure, zero runtime errors in the turn, and
 * model output. Returns the E2 outcome or null. `catchupBatch` is the batch
 * armed for this turn, if any; it is echoed only on a clean turn, and only
 * when it rendered at least one row.
 */
export function turnCompletedOutcome(
  counters: TurnOutcomeCounters,
  stickyTerminalFailure: boolean,
  catchupBatch: { batchId: string; renderedRows: number } | null,
): Extract<AgentRuntimeOutcome, { kind: "turn_completed" }> | null {
  if (stickyTerminalFailure || counters.runtimeErrors > 0) return null;
  if (counters.textEvents + counters.toolCalls === 0) return null;
  return {
    kind: "turn_completed",
    textEvents: counters.textEvents,
    toolCalls: counters.toolCalls,
    // Only a real input batch (rows rendered) is echoed, with its row count.
    ...(catchupBatch && catchupBatch.renderedRows > 0
      ? { catchupBatchId: catchupBatch.batchId, catchupRenderedRows: catchupBatch.renderedRows }
      : {}),
  };
}

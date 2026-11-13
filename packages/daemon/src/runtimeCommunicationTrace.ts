import type { ActiveSpan } from "@botiverse/raft-shared";
import type { ParsedEvent } from "./drivers/index";
import { createTurnTokenAccumulator, turnTokenTraceAttrs, type TurnTokenAccumulator } from "./runtimeTurnTokens";

export interface RuntimeTraceCounters {
  events: number;
  toolCalls: number;
  toolOutputs: number;
  raftMessageSendAttempts: number;
  /** Sends the daemon's Raft proxy saw the Server accept or hold. Unlike the
   * attempt count, this does not depend on recognizing the runtime's tool names. */
  raftMessagesSent: number;
  raftMessageSendsHeld: number;
  tokens: TurnTokenAccumulator;
  compactionStarts: number;
  compactionFinishes: number;
  textEvents: number;
  thinkingEvents: number;
  /** What the turn span carries: estimated bytes of the events kept, and the events left off it. */
  spanEventBytes: number;
  spanEventsDropped: number;
  spanEventBytesDropped: number;
  /** Set once an event did not fit: the span then takes no more, so what it keeps is the turn's first part. */
  spanEventBudgetSpent: boolean;
}

export function createRuntimeTraceCounters(): RuntimeTraceCounters {
  return {
    events: 0,
    toolCalls: 0,
    toolOutputs: 0,
    raftMessageSendAttempts: 0,
    raftMessagesSent: 0,
    raftMessageSendsHeld: 0,
    tokens: createTurnTokenAccumulator(),
    compactionStarts: 0,
    compactionFinishes: 0,
    textEvents: 0,
    thinkingEvents: 0,
    spanEventBytes: 0,
    spanEventsDropped: 0,
    spanEventBytesDropped: 0,
    spanEventBudgetSpent: false,
  };
}

/**
 * The most event bytes one `daemon.runtime.turn` span carries. TeleScope drops
 * a whole trace row over 8 MiB (`delivery.max_bytes`, the most it allows), and
 * a long turn used to carry ~12 MB of events (#botiverse-raft-deployment:#208).
 * Half the cap leaves room for the span's own attributes and the row mapping.
 */
export const TURN_SPAN_EVENT_BYTES_BUDGET = 4 * 1024 * 1024;
/** One event bigger than this is left off the span on its own. */
export const TURN_SPAN_EVENT_MAX_BYTES = 256 * 1024;

/** The turn span's event cap: the budget for all its events, and the most one event may take. */
export interface TurnSpanEventLimits {
  budgetBytes: number;
  maxEventBytes: number;
}

export const TURN_SPAN_EVENT_LIMITS: TurnSpanEventLimits = {
  budgetBytes: TURN_SPAN_EVENT_BYTES_BUDGET,
  maxEventBytes: TURN_SPAN_EVENT_MAX_BYTES,
};

function estimatedEventBytes(name: string, attrs: Record<string, unknown> | undefined): number {
  let json: string;
  try {
    json = JSON.stringify(attrs ?? {}) ?? "";
  } catch {
    json = "";
  }
  return Buffer.byteLength(name) + Buffer.byteLength(json);
}

/**
 * Whether an event still fits on the open turn span. Once the budget is spent
 * every later event, and any one oversized event, is counted as dropped instead, and
 * the span's end says how many and how big (`runtime_span_events_dropped_*`).
 * The turn's counts and outcome stay on the span either way.
 */
export function admitTurnSpanEvent(
  counters: RuntimeTraceCounters,
  name: string,
  attrs: Record<string, unknown> | undefined,
  limits: TurnSpanEventLimits = TURN_SPAN_EVENT_LIMITS,
): boolean {
  const bytes = estimatedEventBytes(name, attrs);
  if (!counters.spanEventBudgetSpent && bytes <= limits.maxEventBytes && counters.spanEventBytes + bytes > limits.budgetBytes) {
    counters.spanEventBudgetSpent = true;
  }
  if (counters.spanEventBudgetSpent || bytes > limits.maxEventBytes) {
    counters.spanEventsDropped++;
    counters.spanEventBytesDropped += bytes;
    return false;
  }
  counters.spanEventBytes += bytes;
  return true;
}

/**
 * Adds an event to an open `daemon.runtime.turn` span when it fits the span's
 * cap (`admitTurnSpanEvent`). Both hosts add turn span events only through
 * here, so a turn span carries the same bounded events whichever host ran it.
 */
export function addTurnSpanEvent(
  span: Pick<ActiveSpan, "addEvent">,
  counters: RuntimeTraceCounters,
  name: string,
  attrs: Record<string, unknown>,
  limits?: TurnSpanEventLimits,
): void {
  if (admitTurnSpanEvent(counters, name, attrs, limits)) span.addEvent(name, attrs);
}

export function runtimeTraceCounterAttrs(
  holder: { runtimeTraceCounters: RuntimeTraceCounters },
): Record<string, unknown> {
  const counters = holder.runtimeTraceCounters;
  return {
    runtime_events_count: counters.events,
    runtime_tool_calls_count: counters.toolCalls,
    runtime_tool_outputs_count: counters.toolOutputs,
    runtime_raft_message_send_attempts_count: counters.raftMessageSendAttempts,
    runtime_raft_messages_sent_count: counters.raftMessagesSent,
    runtime_raft_message_sends_held_count: counters.raftMessageSendsHeld,
    runtime_compaction_starts_count: counters.compactionStarts,
    runtime_compaction_finishes_count: counters.compactionFinishes,
    runtime_text_events_count: counters.textEvents,
    runtime_thinking_events_count: counters.thinkingEvents,
    runtime_span_events_dropped_count: counters.spanEventsDropped,
    ...(counters.spanEventsDropped > 0 ? { runtime_span_event_bytes_dropped: counters.spanEventBytesDropped } : {}),
    ...turnTokenTraceAttrs(counters.tokens),
  };
}

/**
 * Counts one runtime event on the open turn. Reads only its kind, named as a
 * `ParsedEvent` kind (`tool_call`, `text`, ...): the OAR host, which never
 * sees a `ParsedEvent`, passes the kinds its events stand for
 * (`oarTurnTrace.ts`), and an event with no counterpart under its own kind,
 * so it counts toward `events` only.
 */
export function noteRuntimeTraceCounter(counters: RuntimeTraceCounters, event: { readonly kind: ParsedEvent["kind"] | (string & {}) }): void {
  counters.events++;
  switch (event.kind) {
    case "tool_call":
      counters.toolCalls++;
      break;
    case "tool_output":
      counters.toolOutputs++;
      break;
    case "compaction_started":
      counters.compactionStarts++;
      break;
    case "compaction_finished":
      counters.compactionFinishes++;
      break;
    case "text":
      counters.textEvents++;
      break;
    case "thinking":
      counters.thinkingEvents++;
      break;
  }
}

export function noteRaftMessageSendOutcome(counters: RuntimeTraceCounters, state: "sent" | "held"): void {
  if (state === "sent") counters.raftMessagesSent++;
  else counters.raftMessageSendsHeld++;
}

export function noteRaftMessageSendAttempt(counters: RuntimeTraceCounters, toolName: string): void {
  if (toolName === "send_message") counters.raftMessageSendAttempts++;
}

export function runtimeToolingObservationAttrs(
  event: Extract<ParsedEvent, { kind: "runtime_tooling" }>,
): Record<string, unknown> {
  return {
    source: event.source,
    session_request_method: event.sessionRequestMethod,
    native_tool_inventory_observation: event.nativeToolInventoryObservation,
    cli_transport_configured: event.cliTransportConfigured,
    managed_mcp_configured: event.managedMcpConfigured,
    managed_mcp_status: event.managedMcpStatus,
  };
}

export function codexCommunicationGapAttrs(
  driverId: string,
  counters: Pick<RuntimeTraceCounters, "textEvents" | "toolCalls" | "raftMessageSendAttempts" | "thinkingEvents">,
): Record<string, unknown> | null {
  if (
    driverId !== "codex"
    || counters.textEvents === 0
    || counters.toolCalls !== 0
    || counters.raftMessageSendAttempts !== 0
  ) {
    return null;
  }
  return {
    classification: "final_without_tool_or_raft_send",
    severity: "warning",
    final_text_observed: true,
    zero_tool_zero_send: true,
    runtime_tool_calls_count: counters.toolCalls,
    runtime_raft_message_send_attempts_count: counters.raftMessageSendAttempts,
    runtime_text_events_count: counters.textEvents,
    runtime_thinking_events_count: counters.thinkingEvents,
  };
}

import type { ParsedEvent } from "./drivers/index.js";

export interface RuntimeTraceCounters {
  events: number;
  toolCalls: number;
  toolOutputs: number;
  raftMessageSendAttempts: number;
  compactionStarts: number;
  compactionFinishes: number;
  textEvents: number;
  thinkingEvents: number;
}

export function createRuntimeTraceCounters(): RuntimeTraceCounters {
  return {
    events: 0,
    toolCalls: 0,
    toolOutputs: 0,
    raftMessageSendAttempts: 0,
    compactionStarts: 0,
    compactionFinishes: 0,
    textEvents: 0,
    thinkingEvents: 0,
  };
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
    runtime_compaction_starts_count: counters.compactionStarts,
    runtime_compaction_finishes_count: counters.compactionFinishes,
    runtime_text_events_count: counters.textEvents,
    runtime_thinking_events_count: counters.thinkingEvents,
  };
}

export function noteRuntimeTraceCounter(counters: RuntimeTraceCounters, event: ParsedEvent): void {
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
  counters: RuntimeTraceCounters,
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

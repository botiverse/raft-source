// How an OAR session's events become Raft activity facts (RFC 060).
//
// One OAR `Event` in, the activity facts it carries out, in the shapes the
// legacy process manager publishes for the same runtime facts (detail text,
// detail kind, trajectory entries), so the server and the web read an agent
// the same way whichever host runs it. Only the root agent's events drive
// activity; a sub-agent's events stay in OAR's record stream. A runtime whose
// events read differently from its legacy driver's (codex: item types for
// tool names, commentary as text) supplies an `OarActivityReading`.

import { scrubRuntimeErrorDiagnosticText } from "../runtimeErrorDiagnostics";
import type { Event } from "@botiverse/oar";
import type { ToolAction } from "@botiverse/oar/observe";
import {
  getToolActivityLabel,
  normalizeToolDisplayInvocation,
  resolveToolSemantic,
  summarizeToolInput,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type ToolCallOutcome,
  type TrajectoryEntry,
} from "@botiverse/raft-shared";
import { finishToolCall, noteToolCallStart } from "../toolCallOutcome";

export interface OarActivityFact {
  activityKind: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  entries: TrajectoryEntry[];
}

export type OarToolStarted = Extract<Event, { kind: "tool_call_started" }>;
export type OarToolEnded = Extract<Event, { kind: "tool_call_ended" }>;
export type OarTextDelta = Extract<Event, { kind: "text_delta" }>;

/** One tool call as the legacy driver names it (`shell {command}`, `mcp_<server>_<tool>`). */
export interface OarToolCall {
  name: string;
  input: unknown;
  callId: string;
}

/** OAR's `classifyTool` for one runtime. */
export type OarToolClassifier = (tool: string, input: string | undefined) => ToolAction;

/** A runtime's reading of the events whose OAR form differs from what its legacy driver reported. Each returns null to read the event as is. */
export interface OarActivityReading {
  /** The activity line for a `retry` event, where the runtime has its own wording. */
  readonly retryDetail?: string;
  /** The tool calls a started item stands for (a codex file change: one per changed file). */
  toolCalls?(event: OarToolStarted): OarToolCall[] | null;
  /**
   * The calls an ended item closes, matching `toolCalls`; `late` are calls no
   * start announced (a codex file change whose start listed no files yet),
   * announced now so each end has its own start.
   */
  toolEnds?(event: OarToolEnded): { late: OarToolCall[]; callIds: string[] } | null;
  /** The text of this delta the user may see; "" keeps it out of the log. */
  visibleText?(event: OarTextDelta): string | null;
}

/** Same cap the process manager applies to one trajectory text row. */
const MAX_TRAJECTORY_TEXT = 2_000;

/** OAR hands tool input over as text (JSON for ACP runtimes); Raft's display helpers read an object. */
function toolInputObject(input: string | undefined): unknown {
  if (!input) return {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return {};
  }
}

/**
 * A call as Raft's display names it, from OAR's cross-runtime classification, so
 * a command, a file read or edit, or a search reads the same on every runtime.
 * Other kinds, and a tool OAR doesn't know (`other`), keep the runtime's own name.
 */
function classifiedCall(action: ToolAction, callId: string): OarToolCall | null {
  if (action.kind === "run_command" && action.command) return { name: "bash", input: { command: action.command }, callId };
  if (action.kind === "edit_file" && action.detail) return { name: "edit_file", input: { file_path: action.detail }, callId };
  if (action.kind === "read_file" && action.detail) return { name: "read_file", input: { file_path: action.detail }, callId };
  // Since OAR 0.94 a search's detail is its pattern or query, not its path.
  if (action.kind === "search" && action.detail) return { name: "grep", input: { pattern: action.detail }, callId };
  return null;
}

function toolDetailKind(toolName: string): AgentActivityDetailKind {
  switch (resolveToolSemantic(toolName) ?? toolName) {
    case "bash":
      return "running_command";
    case "check_messages":
    case "receive_message":
      return "checking_messages";
    default:
      return "tool_started";
  }
}

function capped(text: string): string {
  return text.length > MAX_TRAJECTORY_TEXT ? `${text.slice(0, MAX_TRAJECTORY_TEXT)}…` : text;
}

/**
 * Reads one session's events into activity facts. Holds what a fact needs
 * from an earlier event: when each open tool call started, so its end
 * carries a duration as the process manager's does.
 */
export class OarActivityProjector {
  /** Bounded (MAX_OPEN_TOOL_CALLS): a runtime that never ends a call must not grow it. */
  private readonly toolStarts = new Map<string, number>();

  constructor(
    private readonly reading: OarActivityReading = {},
    private readonly classify?: OarToolClassifier,
  ) {}

  /**
   * The activity facts for one event; none for events that carry no activity
   * (usage, model, control facts the host reports itself). Turn ends are not
   * mapped here: the host decides between idle and error with the outcome.
   */
  facts(event: Event): OarActivityFact[] {
    if (event.agentPath.length > 0) return [];
    switch (event.kind) {
      case "reasoning":
        return event.content.kind === "text" && event.content.text
          ? [fact("thinking", "", "thinking_started", [{ kind: "thinking", text: capped(event.content.text) }])]
          : [];
      case "text_delta": {
        const text = this.reading.visibleText?.(event) ?? event.text;
        return text ? [fact("working", "", "model_response_started", [{ kind: "text", text: capped(text) }])] : [];
      }
      case "tool_call_started": {
        const calls = this.reading.toolCalls?.(event) ?? [this.classifiedOrOwn(event)];
        return calls.map((call) => this.toolStart(call, event.receivedAt));
      }
      case "tool_call_ended": {
        const ends = this.reading.toolEnds?.(event) ?? { late: [], callIds: [event.callId] };
        return [
          ...ends.late.map((call) => this.toolStart(call, event.receivedAt)),
          ...ends.callIds.map((callId) => fact("working", "Tool finished", "tool_end", [{ kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: this.toolOutcome(callId, event) }])),
        ];
      }
      case "retry": {
        const detail = this.reading.retryDetail ?? "Retrying model request";
        return [fact("working", detail, "runtime_reconnecting", [
          ...(event.reason ? [{ kind: "text" as const, text: capped(scrubRuntimeErrorDiagnosticText(event.reason)) }] : []),
          { kind: "status", activity: "working", detail, detailKind: "runtime_reconnecting" },
        ])];
      }
      case "compaction_started":
        return [fact("working", "Compacting context", "compacting_context", [{ kind: "compaction_started" }])];
      case "compaction_ended":
        return [event.outcome === "completed"
          ? fact("working", "Context compaction finished", "compaction_finished", [{ kind: "compaction_finished" }])
          : fact(event.outcome === "aborted" ? "working" : "error", `Context compaction ${event.outcome}${event.reason ? `: ${event.reason}` : ""}`, event.outcome === "aborted" ? "system_message" : "runtime_error")];
      default:
        return [];
    }
  }

  private classifiedOrOwn(event: OarToolStarted): OarToolCall {
    const classified = this.classify ? classifiedCall(this.classify(event.tool, event.input), event.callId) : null;
    return classified ?? { name: event.tool, input: toolInputObject(event.input), callId: event.callId };
  }

  private toolStart(call: OarToolCall, receivedAt: number): OarActivityFact {
    noteToolCallStart(this.toolStarts, call.callId, receivedAt);
    const invocation = normalizeToolDisplayInvocation(call.name, call.input);
    return fact("working", getToolActivityLabel(invocation.toolName), toolDetailKind(invocation.toolName), [{
      kind: "tool_start",
      toolName: invocation.toolName,
      // OAR hands over the whole input: a query or a path is whatever length the model sent.
      toolInput: capped(summarizeToolInput(invocation.toolName, invocation.input)),
      callId: call.callId,
    }]);
  }

  /** What the runtime reported for a finished call. A command that ran is `ok` whatever its exit status (`ToolCallOutcome`). */
  private toolOutcome(callId: string, event: OarToolEnded): ToolCallOutcome {
    const exitCode = typeof event.exitCode === "number" ? event.exitCode : undefined;
    const ok = exitCode !== undefined ? true : event.result === undefined ? undefined : event.result === "ok";
    return finishToolCall(this.toolStarts, { callId, ok, exitCode }, event.receivedAt) ?? { callId };
  }
}

function fact(
  activityKind: AgentActivityKind,
  detail: string,
  detailKind: AgentActivityDetailKind,
  entries: TrajectoryEntry[] = [],
): OarActivityFact {
  return { activityKind, detail, detailKind, entries };
}

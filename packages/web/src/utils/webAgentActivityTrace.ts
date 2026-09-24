import type { AgentActivity } from "@botiverse/raft-shared";
import { emitWebTrace } from "./webAuthTrace";
import type { WebAgentActivityTraceEventName } from "./webAuthTrace";

type ActivityTraceOutcome = "received" | "applied" | "stale_server_seq" | "invalid_activity";
type StatusDotSurface = "sidebar" | "detail" | "member_list" | "message_input" | "search" | "unknown";
const AGENT_ACTIVITY_VALUES = new Set<AgentActivity>(["offline", "online", "working", "thinking", "error"]);

interface ActivityTraceBase {
  agentId?: string | null;
  activity?: AgentActivity | string | null;
  activityKind?: AgentActivity | string | null;
  hasEntries?: boolean;
  detail?: string | null;
  detailKind?: string | null;
  launchId?: string | null;
  clientSeq?: number | null;
  probeId?: string | null;
  serverSeq?: number | null;
  timestamp?: number | null;
  isHeartbeat?: boolean | null;
  isRefreshOnly?: boolean | null;
  join?: AgentActivityTraceJoin;
}

interface StoreDecisionTrace extends ActivityTraceBase {
  outcome: ActivityTraceOutcome;
  previousActivity?: AgentActivity | null;
  nextActivity?: AgentActivity | null;
  lastServerSeq?: number | null;
  /**
   * launchId under which the agent's serverSeq baseline was last applied.
   * Used only to derive the closed-set `launch_changed` / `same_launch`
   * relation below — never emitted as a raw value (Q8 scrub). Lets a trace
   * reader tell whether a `stale_server_seq` drop coincided with a launch
   * change, distinguishing a launch-scoped counter reset from an ordinary
   * within-launch out-of-order drop, without exposing any ids/seqs.
   * (#161 provability instrumentation)
   */
  lastLaunchId?: string | null;
}

/**
 * Closed-set decision-relation attrs for the store-decision trace. Pure and
 * value-free (Q8): every field is a bounded enum/boolean derived from presence
 * and ordering, never a raw id or seq number. Lets a reader tell whether a
 * `stale_server_seq` drop coincided with a launch change and how the incoming
 * seq related to the baseline — enough to distinguish a launch-scoped counter
 * reset from within-launch reorder. (#161 provability instrumentation)
 */
export interface ActivityDecisionRelation {
  last_launch_id_present: boolean;
  launch_changed: "true" | "false" | "unknown";
  same_launch: "true" | "false" | "unknown";
  seq_relation: "gt" | "lte" | "absent";
  dedup_scope: "server_seq" | "none";
}

export function deriveActivityDecisionRelation(input: {
  launchId?: string | null;
  lastLaunchId?: string | null;
  serverSeq?: number | null;
  lastServerSeq?: number | null;
}): ActivityDecisionRelation {
  const launchChanged: "true" | "false" | "unknown" =
    input.launchId == null || input.lastLaunchId == null
      ? "unknown"
      : input.launchId === input.lastLaunchId
        ? "false"
        : "true";
  const seqRelation: "gt" | "lte" | "absent" =
    typeof input.serverSeq !== "number" || typeof input.lastServerSeq !== "number"
      ? "absent"
      : input.serverSeq > input.lastServerSeq
        ? "gt"
        : "lte";
  return {
    last_launch_id_present: input.lastLaunchId != null,
    launch_changed: launchChanged,
    same_launch: launchChanged === "unknown" ? "unknown" : launchChanged === "true" ? "false" : "true",
    seq_relation: seqRelation,
    dedup_scope: typeof input.serverSeq === "number" ? "server_seq" : "none",
  };
}

interface StatusDotTrace extends ActivityTraceBase {
  surface?: StatusDotSurface;
  isOnline?: boolean;
  isExternal?: boolean;
}

export interface AgentActivityTraceJoin {
  clientEventId?: string;
}

function detailLengthBucket(detail: string | null | undefined): "absent" | "empty" | "short" | "medium" | "long" {
  if (detail == null) return "absent";
  if (detail.length === 0) return "empty";
  if (detail.length <= 32) return "short";
  if (detail.length <= 128) return "medium";
  return "long";
}

function activityAttr(activity: AgentActivity | string | null | undefined): AgentActivity | "unknown" {
  return typeof activity === "string" && AGENT_ACTIVITY_VALUES.has(activity as AgentActivity)
    ? (activity as AgentActivity)
    : "unknown";
}

function baseAttrs(input: ActivityTraceBase): Record<string, unknown> {
  return {
    agent_id_present: Boolean(input.agentId),
    activity: activityAttr(input.activity),
    activity_kind: activityAttr(input.activityKind ?? input.activity),
    has_entries: Boolean(input.hasEntries),
    detail_present: input.detail != null && input.detail.length > 0,
    detail_length_bucket: detailLengthBucket(input.detail),
    detail_kind: input.detailKind ?? "unknown",
    launch_id_present: Boolean(input.launchId),
    client_seq_present: typeof input.clientSeq === "number",
    probe_id_present: Boolean(input.probeId),
    server_seq_present: typeof input.serverSeq === "number",
    timestamp_present: typeof input.timestamp === "number",
    // Stryker disable next-line ConditionalExpression: forcing the branch true only adds `undefined`, which the trace serializer strips; tests pin true/false/absent output.
    ...(typeof input.isHeartbeat === "boolean" ? { is_heartbeat: input.isHeartbeat } : {}),
    // Stryker disable next-line ConditionalExpression: forcing the branch true only adds `undefined`, which the trace serializer strips; tests pin true/absent output.
    ...(typeof input.isRefreshOnly === "boolean" ? { is_refresh_only: input.isRefreshOnly } : {}),
    join: buildTraceJoin(input.join),
  };
}

function buildTraceJoin(input: AgentActivityTraceJoin | undefined): { clientEventId: string } | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator,OptionalChaining: wrapper tests cover non-empty-only join emission; generated guard mutants hang the focused command runner.
  if (typeof input?.clientEventId !== "string" || input.clientEventId.length === 0) return undefined;
  return { clientEventId: input.clientEventId };
}

function emitAgentActivityTrace(name: WebAgentActivityTraceEventName, attrs: Record<string, unknown>): void {
  emitWebTrace(name, attrs);
}

export function traceAgentActivitySocketReceived(input: ActivityTraceBase): void {
  emitAgentActivityTrace("slock.agent_activity.socket_received", {
    ...baseAttrs(input),
    outcome: "received",
  });
}

export function traceAgentActivityStoreDecision(input: StoreDecisionTrace): void {
  emitAgentActivityTrace("slock.agent_activity.store_decision", {
    ...baseAttrs(input),
    outcome: input.outcome,
    previous_activity: activityAttr(input.previousActivity),
    next_activity: activityAttr(input.nextActivity),
    last_server_seq_present: typeof input.lastServerSeq === "number",
    // Closed-set decision-relation attrs (#161 provability). No raw ids/seqs.
    ...deriveActivityDecisionRelation(input),
  });
}

export function traceAgentActivityStatusDotApplied(input: StatusDotTrace): void {
  emitAgentActivityTrace("slock.agent_activity.status_dot_applied", {
    ...baseAttrs(input),
    surface: input.surface ?? "unknown",
    is_online: Boolean(input.isOnline),
    is_external: Boolean(input.isExternal),
  });
}

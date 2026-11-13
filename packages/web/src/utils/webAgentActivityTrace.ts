import type { AgentActivity } from "@botiverse/raft-shared";
import { emitWebEvent } from "./webAuthTrace";
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
  // Client clock (Date.now()) when the socket event arrived. Only used to
  // compute arrival_to_applied_ms at apply time; never stored or emitted raw.
  arrivedAtMs?: number;
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

/**
 * Routine agent activity (a heartbeat, a refresh-only push, an applied push
 * that leaves the agent's activity as it was, a detail-only change included)
 * is traced at this rate, with
 * `sample_rate` on the event so counts can be weighted back (1 / rate). On a
 * server with many agents these arrive several times a second on every
 * member's tab, and tracing each one was most of the tab's idle memory growth
 * (#proj-frontend:#8). A change of activity (online, working, thinking,
 * error, offline) is always traced, with its join id, so a status change can
 * still be followed from push to dot. The trace carries only a length bucket
 * of the detail, so a detail-only change adds nothing a sample doesn't.
 */
export const ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE = 0.01;

let sampleRandom: () => number = Math.random;

/** The activity of each agent's last received push (agent ids are unique across servers). */
const lastReceivedActivity = new Map<string, string>();

/** Tests only: the sampler's random source (null restores Math.random); also forgets received pushes. */
export function setAgentActivityTraceRandomForTests(random: (() => number) | null): void {
  sampleRandom = random ?? Math.random;
  lastReceivedActivity.clear();
}

/** Whether a routine event is traced this time; its attrs then carry the rate. */
function sampledRoutine(): boolean {
  return sampleRandom() < ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE;
}

function emitAgentActivityTrace(name: WebAgentActivityTraceEventName, attrs: Record<string, unknown>): void {
  emitWebEvent(name, attrs);
}

/**
 * `previousActivity`: the agent's activity in the store before this push is
 * applied (null: none known). A push that leaves it as it was (a detail-only
 * change, most of real traffic) is routine. With nothing in the store, the
 * agent's last received push stands in for it; an agent's first push is traced in full.
 */
export function traceAgentActivitySocketReceived(input: ActivityTraceBase & { previousActivity?: string | null }): void {
  const agentId = input.agentId ?? null;
  const lastReceived = agentId ? lastReceivedActivity.get(agentId) : undefined;
  if (agentId && typeof input.activity === "string") lastReceivedActivity.set(agentId, input.activity);
  const prior = input.previousActivity ?? lastReceived ?? null;
  const unchanged = typeof input.activity === "string" && prior === input.activity;
  const routine = input.isHeartbeat === true || input.isRefreshOnly === true || unchanged;
  if (routine && !sampledRoutine()) return;
  emitAgentActivityTrace("slock.agent_activity.socket_received", {
    ...baseAttrs(input),
    outcome: "received",
    ...(routine ? { sample_rate: ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE } : {}),
  });
}

export function traceAgentActivityStoreDecision(input: StoreDecisionTrace): void {
  // Applied without changing the activity (a detail-only change included): routine. Stale and
  // invalid pushes are rare anomalies and stay traced in full.
  const routine = input.outcome === "applied" && (input.previousActivity ?? null) === (input.nextActivity ?? null);
  if (routine && !sampledRoutine()) return;
  emitAgentActivityTrace("slock.agent_activity.store_decision", {
    ...(routine ? { sample_rate: ROUTINE_AGENT_ACTIVITY_TRACE_SAMPLE_RATE } : {}),
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

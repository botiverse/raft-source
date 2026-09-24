/**
 * Agents activity events + reducer.
 *
 * The reducer owns the current activity materialization and the activity /
 * trajectory log projections. Comparable producer events use serverSeq for
 * adjudication; timestamps are log metadata only and must not decide current.
 */

import { getToolActivityLabel, isAgentActivity, normalizeActivityDetailKind } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, TrajectoryEntry } from "@botiverse/raft-shared";

export const MAX_ACTIVITY_LOG_ENTRIES = 200;
export const MAX_TRAJECTORY_ENTRIES = 500;

export interface AgentActivityState {
  activity: AgentActivity;
  activityDetail: string;
  detailKind: AgentActivityDetailKind;
}

type AgentActivityDetailBucket =
  | "none"
  | "command"
  | "compaction"
  | "runtime"
  | "lifecycle"
  | "message"
  | "review"
  | "external"
  | "generic";

const ACTIVITY_DETAIL_BUCKET_BY_KIND = {
  none: "none",
  message_received: "message",
  freshness_hold: "lifecycle",
  starting: "lifecycle",
  runtime_starting: "runtime",
  idle: "none",
  running_command: "command",
  checking_messages: "command",
  compacting_context: "compaction",
  compaction_finished: "compaction",
  compaction_stale: "compaction",
  reviewing_changes: "review",
  review_finished: "review",
  review_stale: "review",
  runtime_reconnecting: "runtime",
  runtime_error: "runtime",
  runtime_crashed: "runtime",
  runtime_unavailable: "runtime",
  runtime_stalled: "runtime",
  stalled_recovery: "lifecycle",
  stopped: "lifecycle",
  computer_started: "lifecycle",
  computer_restarted: "lifecycle",
  computer_upgraded: "lifecycle",
  computer_operation_failed: "lifecycle",
  ready: "lifecycle",
  runtime_interrupted: "runtime",
  machine_disconnected: "generic",
  daemon_activity: "external",
  external_activity: "external",
  synthetic_repair: "lifecycle",
  slock_action: "message",
  system_message: "message",
  runtime_progress: "runtime",
  model_request_started: "runtime",
  model_response_started: "runtime",
  tool_started: "command",
  tool_end: "command",
  thinking_started: "runtime",
  thinking_end: "runtime",
  subagent_activity: "external",
  other: "generic",
} as const satisfies Record<AgentActivityDetailKind, AgentActivityDetailBucket>;

export interface AgentActivityViolationBasis {
  same_activity: boolean;
  same_detail_kind: boolean;
  same_detail_presence: boolean;
  same_detail_bucket: boolean;
  currentActivity?: AgentActivity;
  projectedActivity?: AgentActivity;
  currentDetailKind?: AgentActivityDetailKind;
  projectedDetailKind?: AgentActivityDetailKind;
}

interface AgentActivitySemanticProjection {
  activity: AgentActivity;
  detailKind: AgentActivityDetailKind;
  detailPresent: boolean;
  detailBucket: AgentActivityDetailBucket;
}

export interface AgentActivityJoinKeys {
  launchId?: string;
  clientSeq?: number;
  probeId?: string;
}

export interface AgentActivityTraceJoin {
  clientEventId?: string;
}

export interface ActivityLogEntry {
  timestamp: number;
  activity: AgentActivity;
  detail: string;
  detailKind: AgentActivityDetailKind;
  /** Server-side per-agent producer sequence, when present. */
  serverSeq?: number;
  /** Daemon launch scope for this activity update, when provided by the server. */
  launchId?: string;
  /** Daemon-side per-agent monotonic sequence for this activity update, when provided by the server. */
  clientSeq?: number;
  /** Server-issued probe id if this activity is a probe response. */
  probeId?: string;
}

export interface TrajectoryLogEntry {
  timestamp: number;
  entry: TrajectoryEntry;
  /** Server-side per-agent producer sequence shared with agent:activity pushes, when present. */
  serverSeq?: number;
  /** Daemon launch scope for the trajectory entries, when provided by the server. */
  launchId?: string;
  /** Daemon-side per-agent monotonic sequence for the trajectory entries, when provided by the server. */
  clientSeq?: number;
  /** Server-issued probe id if these entries are from a probe response. */
  probeId?: string;
}

export interface AgentActivityDomainState {
  agentActivities: Record<string, AgentActivityState>;
  agentActivityTraceJoins: Record<string, AgentActivityTraceJoin>;
  agentActivityObservedAt: Record<string, number>;
  agentActivityVersions: Record<string, number>;
  agentActivitySeq: Record<string, number>;
  agentActivityLaunchId: Record<string, string>;
  activityLogs: Record<string, ActivityLogEntry[]>;
  trajectoryLogs: Record<string, TrajectoryLogEntry[]>;
}

export type AgentActivityEvent =
  | {
      kind: "patch:socket-activity";
      agentId: string;
      activity: string | undefined;
      activityDetail: string;
      serverSeq?: number;
      timestamp: number;
      joinKeys?: AgentActivityJoinKeys;
      traceJoin?: AgentActivityTraceJoin;
      activityKind?: string;
      detailKind?: string;
      isHeartbeat?: boolean;
      isRefreshOnly?: boolean;
    }
  | {
      kind: "patch:trajectory-append";
      agentId: string;
      entries: TrajectoryEntry[];
      timestamp: number;
      serverSeq?: number;
      joinKeys?: AgentActivityJoinKeys;
      traceJoin?: AgentActivityTraceJoin;
    }
  | {
      kind: "hydrate:trajectory-log";
      agentId: string;
      entries: TrajectoryLogEntry[];
    }
  | { kind: "reset-seq" };

export interface AgentActivityTransition {
  event: AgentActivityEvent["kind"];
  touched: number;
  currentTouched: number;
  logTouched: number;
  reconcileSuggested: boolean;
  outcome: "applied" | "stale_server_seq" | "producer_seq_conflict" | "invalid_activity" | "logged" | "no_op";
  agentId?: string;
  previousActivity?: AgentActivity | null;
  nextActivity?: AgentActivity | null;
  serverSeq?: number;
  timestamp?: number;
  violationBasis?: AgentActivityViolationBasis;
}

export interface AgentActivityApplyResult {
  state: AgentActivityDomainState;
  transition: AgentActivityTransition;
}

export function makeActivityState(
  activity: AgentActivity,
  activityDetail = "",
  detailKind: AgentActivityDetailKind = "other",
): AgentActivityState {
  return { activity, activityDetail, detailKind };
}

export function deriveActivityFromTrajectoryEntry(entry: TrajectoryEntry): AgentActivityState | null {
  switch (entry.kind) {
    case "thinking":
      return makeActivityState("thinking", entry.text || "Thinking…", "none");
    case "tool_start":
      return makeActivityState("working", getToolActivityLabel(entry.toolName), entry.toolName === "bash" ? "running_command" : "other");
    case "compaction_started":
      return makeActivityState("working", "", "compacting_context");
    case "compaction_finished":
      return makeActivityState("online", "", "compaction_finished");
    case "status":
      return makeActivityState(entry.activityKind ?? entry.activity, entry.detail || "", normalizeActivityDetailKind(entry.detailKind));
    default:
      return null;
  }
}

export function deriveLatestActivityFromTrajectory(entries: TrajectoryLogEntry[]): { state: AgentActivityState; timestamp: number; serverSeq?: number } | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    const projected = deriveActivityFromTrajectoryEntry(item.entry);
    if (projected) return { state: projected, timestamp: item.timestamp, serverSeq: item.serverSeq };
  }
  return null;
}

export function applyAgentActivityEvent(
  state: AgentActivityDomainState,
  event: AgentActivityEvent,
): AgentActivityApplyResult {
  switch (event.kind) {
    case "patch:socket-activity":
      return applySocketActivity(state, event);
    case "patch:trajectory-append":
      return applyTrajectoryAppend(state, event);
    case "hydrate:trajectory-log":
      return applyTrajectoryHydrate(state, event);
    case "reset-seq": {
      if (
        Object.keys(state.agentActivitySeq).length === 0
        && Object.keys(state.agentActivityLaunchId).length === 0
        && Object.keys(state.agentActivityTraceJoins).length === 0
      ) {
        return noop(state, event.kind);
      }
      return {
        state: { ...state, agentActivitySeq: {}, agentActivityLaunchId: {}, agentActivityTraceJoins: {} },
        transition: baseTransition(event.kind, { touched: 1, currentTouched: 0, logTouched: 0, outcome: "applied" }),
      };
    }
  }
}

function applySocketActivity(
  state: AgentActivityDomainState,
  event: Extract<AgentActivityEvent, { kind: "patch:socket-activity" }>,
): AgentActivityApplyResult {
  const previousActivity = state.agentActivities[event.agentId]?.activity ?? null;
  const normalized = parsePushedActivity(event.activityKind ?? event.activity);
  if (!normalized) {
    return {
      state,
      transition: baseTransition(event.kind, {
        agentId: event.agentId,
        outcome: "invalid_activity",
        serverSeq: event.serverSeq,
        timestamp: event.timestamp,
        previousActivity,
      }),
    };
  }
  const detailKind = normalizeActivityDetailKind(event.detailKind);
  const nextActivity = makeActivityState(normalized, event.activityDetail, detailKind);
  if (typeof event.serverSeq === "number") {
    const lastSeq = state.agentActivitySeq[event.agentId] ?? Number.NEGATIVE_INFINITY;
    const shouldUpgradeFallbackCurrent = event.serverSeq === lastSeq
      && shouldApplySocketDetailKindAuthority(state.agentActivities[event.agentId], nextActivity);
    if (event.serverSeq <= lastSeq && !shouldUpgradeFallbackCurrent) {
      const violationBasis = event.serverSeq === lastSeq
        ? producerSeqConflictBasis(state.agentActivities[event.agentId], nextActivity)
        : undefined;
      const isSameSeqConflict = !!violationBasis;
      return {
        state,
        transition: baseTransition(event.kind, {
          agentId: event.agentId,
          outcome: isSameSeqConflict ? "producer_seq_conflict" : "stale_server_seq",
          reconcileSuggested: isSameSeqConflict,
          serverSeq: event.serverSeq,
          timestamp: event.timestamp,
          previousActivity,
          violationBasis,
        }),
      };
    }
  }

  const existingLog = state.activityLogs[event.agentId] || [];
  let updatedLog = existingLog;
  // Replay-only frames refresh the current snapshot/observed timestamp only.
  // New servers declare this generically for heartbeats and activity probes;
  // the heartbeat fallback keeps compatibility with older servers.
  const isRefreshOnly = event.isRefreshOnly === true || event.isHeartbeat === true;
  if (!isRefreshOnly) {
    const entry: ActivityLogEntry = {
      timestamp: event.timestamp,
      activity: normalized,
      detail: event.activityDetail,
      detailKind,
    };
    assignSeqAndJoinKeys(entry, event.serverSeq, event.joinKeys);
    updatedLog = appendActivityLog(existingLog, entry);
  }
  const logTouched = updatedLog === existingLog ? 0 : 1;
  return applyCurrentActivity(state, {
    event: event.kind,
    agentId: event.agentId,
    state: nextActivity,
    timestamp: event.timestamp,
    serverSeq: event.serverSeq,
    joinKeys: event.joinKeys,
    traceJoin: event.traceJoin,
    activityLogs: logTouched ? updatedLog : undefined,
    logTouched,
    previousActivity,
    outcome: "applied",
  });
}

function applyTrajectoryAppend(
  state: AgentActivityDomainState,
  event: Extract<AgentActivityEvent, { kind: "patch:trajectory-append" }>,
): AgentActivityApplyResult {
  const newEntries = event.entries.map((entry) => {
    const item: TrajectoryLogEntry = { timestamp: event.timestamp, entry };
    assignSeqAndJoinKeys(item, event.serverSeq, event.joinKeys);
    return item;
  });
  return applyTrajectoryEntries(state, {
    event: event.kind,
    agentId: event.agentId,
    entries: newEntries,
    eventServerSeq: event.serverSeq,
    timestamp: event.timestamp,
    traceJoin: event.traceJoin,
  });
}

function applyTrajectoryHydrate(
  state: AgentActivityDomainState,
  event: Extract<AgentActivityEvent, { kind: "hydrate:trajectory-log" }>,
): AgentActivityApplyResult {
  return applyTrajectoryEntries(state, {
    event: event.kind,
    agentId: event.agentId,
    entries: event.entries,
  });
}

function applyTrajectoryEntries(
  state: AgentActivityDomainState,
  args: {
    event: AgentActivityTransition["event"];
    agentId: string;
    entries: TrajectoryLogEntry[];
    eventServerSeq?: number;
    timestamp?: number;
    traceJoin?: AgentActivityTraceJoin;
  },
): AgentActivityApplyResult {
  const existing = state.trajectoryLogs[args.agentId] || [];
  const combined = mergeTrajectoryLogs(existing, args.entries);
  const logTouched = combined === existing ? 0 : 1;
  const selection = selectComparableTrajectoryActivity(args.entries, state.agentActivitySeq[args.agentId], state.agentActivities[args.agentId]);
  const previousActivity = state.agentActivities[args.agentId]?.activity ?? null;
  if (selection.conflict) {
    const nextState = logTouched
      ? {
          ...state,
          trajectoryLogs: { ...state.trajectoryLogs, [args.agentId]: combined },
        }
      : state;
    return {
      state: nextState,
      transition: baseTransition(args.event, {
        agentId: args.agentId,
        touched: logTouched,
        logTouched,
        outcome: "producer_seq_conflict",
        reconcileSuggested: true,
        previousActivity,
        serverSeq: selection.conflict.serverSeq,
        timestamp: selection.conflict.timestamp ?? args.timestamp,
        violationBasis: selection.conflict.violationBasis,
      }),
    };
  }
  const bestComparable = selection.best;
  const nextProjected = bestComparable?.state ?? null;
  if (!bestComparable || !nextProjected) {
    const nextState = logTouched
      ? {
          ...state,
          trajectoryLogs: { ...state.trajectoryLogs, [args.agentId]: combined },
        }
      : state;
    return {
      state: nextState,
      transition: baseTransition(args.event, {
        agentId: args.agentId,
        touched: logTouched,
        logTouched,
        outcome: logTouched ? "logged" : "no_op",
        reconcileSuggested: hasNonComparableActivity(args.entries),
        previousActivity,
        serverSeq: args.eventServerSeq,
        timestamp: args.timestamp,
      }),
    };
  }
  return applyCurrentActivity(state, {
    event: args.event,
    agentId: args.agentId,
    state: nextProjected,
    timestamp: bestComparable.timestamp,
    serverSeq: bestComparable.serverSeq,
    trajectoryLogs: logTouched ? combined : undefined,
    traceJoin: args.traceJoin,
    logTouched,
    previousActivity,
    outcome: "applied",
  });
}

function selectComparableTrajectoryActivity(
  entries: TrajectoryLogEntry[],
  lastSeq: number | undefined,
  current: AgentActivityState | undefined,
): {
  best: { state: AgentActivityState; timestamp: number; serverSeq: number } | null;
  conflict: { serverSeq: number; timestamp: number; violationBasis: AgentActivityViolationBasis } | null;
} {
  let best: { state: AgentActivityState; timestamp: number; serverSeq: number } | null = null;
  let conflict: { serverSeq: number; timestamp: number; violationBasis: AgentActivityViolationBasis } | null = null;
  const seenBySeq = new Map<number, AgentActivityState>();
  for (const entry of entries) {
    if (typeof entry.serverSeq !== "number") continue;
    const projected = deriveActivityFromTrajectoryEntry(entry.entry);
    if (!projected) continue;
    if (lastSeq !== undefined && entry.serverSeq < lastSeq) continue;
    if (lastSeq !== undefined && entry.serverSeq === lastSeq) {
      const violationBasis = producerSeqConflictBasis(current, projected, { trajectoryProjectionMayUseFallbackDetailKind: true });
      if (violationBasis) {
        conflict ??= { serverSeq: entry.serverSeq, timestamp: entry.timestamp, violationBasis };
      }
      continue;
    }
    const seen = seenBySeq.get(entry.serverSeq);
    const seenConflictBasis = seen ? producerSeqConflictBasis(seen, projected) : undefined;
    if (seenConflictBasis) {
      conflict ??= { serverSeq: entry.serverSeq, timestamp: entry.timestamp, violationBasis: seenConflictBasis };
      continue;
    }
    if (!seen) seenBySeq.set(entry.serverSeq, projected);
    if (!best || entry.serverSeq > best.serverSeq) {
      best = { state: projected, timestamp: entry.timestamp, serverSeq: entry.serverSeq };
    }
  }
  return { best: conflict ? null : best, conflict };
}

function hasNonComparableActivity(entries: TrajectoryLogEntry[]): boolean {
  return entries.some((entry) => typeof entry.serverSeq !== "number" && entry.entry.kind === "status" && deriveActivityFromTrajectoryEntry(entry.entry));
}

function applyCurrentActivity(
  state: AgentActivityDomainState,
  args: {
    event: AgentActivityTransition["event"];
    agentId: string;
    state: AgentActivityState;
    timestamp: number;
    serverSeq?: number;
    joinKeys?: AgentActivityJoinKeys;
    traceJoin?: AgentActivityTraceJoin;
    activityLogs?: ActivityLogEntry[];
    trajectoryLogs?: TrajectoryLogEntry[];
    logTouched: number;
    previousActivity: AgentActivity | null;
    outcome: AgentActivityTransition["outcome"];
  },
): AgentActivityApplyResult {
  const current = state.agentActivities[args.agentId];
  const currentTouched = activityStateEqual(current, args.state) ? 0 : 1;
  const nextServerSeq = args.serverSeq;
  const shouldWriteSeq = typeof nextServerSeq === "number";
  const sameSeq = !shouldWriteSeq || state.agentActivitySeq[args.agentId] === nextServerSeq;
  const sameLaunch = args.joinKeys?.launchId === undefined || state.agentActivityLaunchId[args.agentId] === args.joinKeys.launchId;
  const touched = currentTouched || args.logTouched || !sameSeq || !sameLaunch ? 1 : 0;
  if (!touched) {
    return {
      state,
      transition: baseTransition(args.event, {
        agentId: args.agentId,
        outcome: "no_op",
        previousActivity: args.previousActivity,
        nextActivity: args.state.activity,
        serverSeq: args.serverSeq,
        timestamp: args.timestamp,
      }),
    };
  }

  const next: AgentActivityDomainState = {
    ...state,
    agentActivities: currentTouched
      ? { ...state.agentActivities, [args.agentId]: args.state }
      : state.agentActivities,
    agentActivityTraceJoins: currentTouched
      ? writeTraceJoin(state.agentActivityTraceJoins, args.agentId, args.traceJoin)
      : state.agentActivityTraceJoins,
    agentActivityObservedAt: currentTouched || state.agentActivityObservedAt[args.agentId] !== args.timestamp
      ? { ...state.agentActivityObservedAt, [args.agentId]: args.timestamp }
      : state.agentActivityObservedAt,
    agentActivityVersions: currentTouched
      ? { ...state.agentActivityVersions, [args.agentId]: nextActivityVersion(state, args.agentId) }
      : state.agentActivityVersions,
    agentActivitySeq: shouldWriteSeq && state.agentActivitySeq[args.agentId] !== nextServerSeq
      ? { ...state.agentActivitySeq, [args.agentId]: nextServerSeq }
      : state.agentActivitySeq,
    agentActivityLaunchId:
      args.joinKeys?.launchId !== undefined && state.agentActivityLaunchId[args.agentId] !== args.joinKeys.launchId
        ? { ...state.agentActivityLaunchId, [args.agentId]: args.joinKeys.launchId }
        : state.agentActivityLaunchId,
    activityLogs: args.activityLogs
      ? { ...state.activityLogs, [args.agentId]: args.activityLogs }
      : state.activityLogs,
    trajectoryLogs: args.trajectoryLogs
      ? { ...state.trajectoryLogs, [args.agentId]: args.trajectoryLogs }
      : state.trajectoryLogs,
  };
  return {
    state: next,
    transition: baseTransition(args.event, {
      agentId: args.agentId,
      touched,
      currentTouched,
      logTouched: args.logTouched,
      outcome: args.outcome,
      previousActivity: args.previousActivity,
      nextActivity: args.state.activity,
      serverSeq: args.serverSeq,
      timestamp: args.timestamp,
    }),
  };
}

function writeTraceJoin(
  current: Record<string, AgentActivityTraceJoin>,
  agentId: string,
  traceJoin: AgentActivityTraceJoin | undefined,
): Record<string, AgentActivityTraceJoin> {
  // Stryker disable next-line ConditionalExpression,OptionalChaining: reducer tests cover write/clear/reference semantics; generated guard mutants hang the focused command runner.
  if (traceJoin?.clientEventId) {
    // Stryker disable next-line OptionalChaining: same-id preservation is covered by reducer behavior; generated optional-chain mutant hangs the focused command runner.
    if (current[agentId]?.clientEventId === traceJoin.clientEventId) return current;
    return { ...current, [agentId]: { clientEventId: traceJoin.clientEventId } };
  }
  if (current[agentId] === undefined) return current;
  const { [agentId]: _cleared, ...rest } = current;
  return rest;
}

function parsePushedActivity(raw: string | undefined): AgentActivity | null {
  return isAgentActivity(raw) ? raw : null;
}

function nextActivityVersion(state: AgentActivityDomainState, agentId: string): number {
  return (state.agentActivityVersions[agentId] ?? 0) + 1;
}

function activityStateEqual(a: AgentActivityState | undefined, b: AgentActivityState): boolean {
  return a?.activity === b.activity && a.activityDetail === b.activityDetail && a.detailKind === b.detailKind;
}

function producerSeqConflictBasis(
  current: AgentActivityState | undefined,
  projected: AgentActivityState,
  options: { trajectoryProjectionMayUseFallbackDetailKind?: boolean } = {},
): AgentActivityViolationBasis | undefined {
  if (!current) return undefined;
  const currentProjection = semanticActivityProjection(current);
  const projectedProjection = semanticActivityProjection(projected);
  if (
    options.trajectoryProjectionMayUseFallbackDetailKind
    && isFallbackDetailKindProjection(currentProjection, projectedProjection)
  ) {
    return undefined;
  }
  const basis: AgentActivityViolationBasis = {
    same_activity: currentProjection.activity === projectedProjection.activity,
    same_detail_kind: currentProjection.detailKind === projectedProjection.detailKind,
    same_detail_presence: currentProjection.detailPresent === projectedProjection.detailPresent,
    same_detail_bucket: currentProjection.detailBucket === projectedProjection.detailBucket,
    currentActivity: currentProjection.activity,
    projectedActivity: projectedProjection.activity,
    currentDetailKind: currentProjection.detailKind,
    projectedDetailKind: projectedProjection.detailKind,
  };

  return basis.same_activity && basis.same_detail_kind && basis.same_detail_presence && basis.same_detail_bucket
    ? undefined
    : basis;
}

function shouldApplySocketDetailKindAuthority(
  current: AgentActivityState | undefined,
  next: AgentActivityState,
): boolean {
  if (!current) return false;
  const currentProjection = semanticActivityProjection(current);
  const nextProjection = semanticActivityProjection(next);
  return isFallbackDetailKindProjection(nextProjection, currentProjection);
}

function isFallbackDetailKindProjection(
  authoritativeProjection: AgentActivitySemanticProjection,
  fallbackProjection: AgentActivitySemanticProjection,
): boolean {
  return authoritativeProjection.activity === fallbackProjection.activity
    && authoritativeProjection.detailPresent === fallbackProjection.detailPresent
    && authoritativeProjection.detailKind !== "other"
    && fallbackProjection.detailKind === "other";
}

function semanticActivityProjection(state: AgentActivityState): AgentActivitySemanticProjection {
  const detailPresent = state.activityDetail.trim().length > 0;
  return {
    activity: state.activity,
    detailKind: state.detailKind,
    detailPresent,
    detailBucket: activityDetailBucket(state.detailKind, detailPresent),
  };
}

function activityDetailBucket(
  detailKind: AgentActivityDetailKind,
  detailPresent: boolean,
): AgentActivityDetailBucket {
  // Stryker disable next-line StringLiteral,ConditionalExpression: absent/none/idle all intentionally collapse to the internal none bucket; present-bucket distinctness is covered by reducer behavior tests.
  if (!detailPresent || detailKind === "none" || detailKind === "idle") return "none";
  return ACTIVITY_DETAIL_BUCKET_BY_KIND[detailKind];
}

function appendActivityLog(existing: ActivityLogEntry[], entry: ActivityLogEntry): ActivityLogEntry[] {
  if (existing.some((item) => activityLogKey(item) === activityLogKey(entry))) return existing;
  return [...existing, entry].sort(compareActivityLogs).slice(-MAX_ACTIVITY_LOG_ENTRIES);
}

function compareActivityLogs(a: ActivityLogEntry, b: ActivityLogEntry): number {
  return a.timestamp - b.timestamp || (a.serverSeq ?? -1) - (b.serverSeq ?? -1);
}

function activityLogKey(item: ActivityLogEntry): string {
  return [
    item.timestamp,
    item.serverSeq ?? "na",
    item.launchId ?? "",
    item.clientSeq ?? "",
    item.probeId ?? "",
    item.activity,
    item.detail,
    item.detailKind,
  ].join(":");
}

function mergeTrajectoryLogs(existing: TrajectoryLogEntry[], incoming: TrajectoryLogEntry[]): TrajectoryLogEntry[] {
  if (incoming.length === 0) return existing;
  let changed = false;
  const merged = [...existing];
  for (const item of incoming) {
    const key = trajectoryLogKey(item);
    if (merged.some((existingItem) => trajectoryLogKey(existingItem) === key)) continue;
    // Hydrated durable rows do not carry the live socket source identity, so
    // the exact key can differ even when both rows render the same fact.
    const visibleDuplicateIndex = merged.findIndex((existingItem) => shouldDedupeTrajectoryLogEntries(existingItem, item));
    if (visibleDuplicateIndex >= 0) {
      const preferred = preferTrajectoryLogEntry(merged[visibleDuplicateIndex]!, item);
      if (preferred !== merged[visibleDuplicateIndex]) {
        merged[visibleDuplicateIndex] = preferred;
        changed = true;
      }
      continue;
    }
    merged.push(item);
    changed = true;
  }
  if (!changed) return existing;
  return merged.sort(compareTrajectoryLogs).slice(-MAX_TRAJECTORY_ENTRIES);
}

function compareTrajectoryLogs(a: TrajectoryLogEntry, b: TrajectoryLogEntry): number {
  return a.timestamp - b.timestamp || (a.serverSeq ?? -1) - (b.serverSeq ?? -1);
}

function trajectoryLogKey(item: TrajectoryLogEntry): string {
  return [
    item.timestamp,
    item.serverSeq ?? "na",
    item.launchId ?? "",
    item.clientSeq ?? "",
    item.probeId ?? "",
    stableTrajectoryEntryKey(item.entry),
  ].join(":");
}

function trajectoryLogVisibleKey(item: TrajectoryLogEntry): string {
  return `${item.timestamp}:${stableTrajectoryEntryKey(item.entry)}`;
}

function stableTrajectoryEntryKey(entry: TrajectoryEntry): string {
  const normalized = Object.fromEntries(
    Object.entries(entry)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(normalized);
}

function hasTrajectoryLogSourceIdentity(item: TrajectoryLogEntry): boolean {
  return item.serverSeq !== undefined
    || item.launchId !== undefined
    || item.clientSeq !== undefined
    || item.probeId !== undefined;
}

function trajectoryProducerFactId(entry: TrajectoryEntry): string | undefined {
  const value = entry.producerFactId;
  return typeof value === "string" ? value : undefined;
}

function shouldDedupeTrajectoryLogEntries(a: TrajectoryLogEntry, b: TrajectoryLogEntry): boolean {
  if (trajectoryLogVisibleKey(a) !== trajectoryLogVisibleKey(b)) return false;
  if (trajectoryProducerFactId(a.entry)) return true;
  return !hasTrajectoryLogSourceIdentity(a) || !hasTrajectoryLogSourceIdentity(b);
}

function preferTrajectoryLogEntry(existing: TrajectoryLogEntry, incoming: TrajectoryLogEntry): TrajectoryLogEntry {
  return !hasTrajectoryLogSourceIdentity(existing) && hasTrajectoryLogSourceIdentity(incoming)
    ? incoming
    : existing;
}

function assignSeqAndJoinKeys<T extends { serverSeq?: number; launchId?: string; clientSeq?: number; probeId?: string }>(
  target: T,
  serverSeq?: number,
  joinKeys?: AgentActivityJoinKeys,
): void {
  if (serverSeq !== undefined) target.serverSeq = serverSeq;
  if (joinKeys?.launchId !== undefined) target.launchId = joinKeys.launchId;
  if (joinKeys?.clientSeq !== undefined) target.clientSeq = joinKeys.clientSeq;
  if (joinKeys?.probeId !== undefined) target.probeId = joinKeys.probeId;
}

function noop(state: AgentActivityDomainState, event: AgentActivityTransition["event"]): AgentActivityApplyResult {
  return {
    state,
    transition: baseTransition(event),
  };
}

function baseTransition(
  event: AgentActivityTransition["event"],
  fields: Partial<AgentActivityTransition> = {},
): AgentActivityTransition {
  return {
    event,
    touched: 0,
    currentTouched: 0,
    logTouched: 0,
    reconcileSuggested: false,
    outcome: "no_op",
    ...fields,
  };
}

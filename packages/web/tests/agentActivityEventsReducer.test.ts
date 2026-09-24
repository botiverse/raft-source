import assert from "node:assert/strict";
import test from "node:test";
import * as fc from "fast-check";
import type { AgentActivity, AgentActivityDetailKind, TrajectoryEntry } from "@botiverse/raft-shared";
import { createAgentActivityDomain } from "../src/store/agentActivityDomain.js";
import {
  MAX_TRAJECTORY_ENTRIES,
} from "../src/store/events/agentActivityEvents.js";
import type {
  AgentActivityDomainState,
  AgentActivityEvent,
  AgentActivityState,
  AgentActivityViolationBasis,
} from "../src/store/events/agentActivityEvents.js";

function emptyState(): AgentActivityDomainState {
  return {
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    activityLogs: {},
    trajectoryLogs: {},
  };
}

function socketEvent(
  seq: number,
  activity: AgentActivity,
  detail = activity,
  timestamp = seq,
  detailKind: AgentActivityDetailKind = activity === "online" ? "idle" : "other",
  traceJoin?: { clientEventId?: string },
): AgentActivityEvent {
  return {
    kind: "patch:socket-activity",
    agentId: "agent-1",
    activity,
    activityKind: activity,
    activityDetail: detail,
    detailKind,
    serverSeq: seq,
    timestamp,
    traceJoin,
  };
}

function trajectoryEvent(seq: number | undefined, activity: AgentActivity, detail = "", timestamp = seq ?? 0): AgentActivityEvent {
  const entry: TrajectoryEntry = {
    kind: "status",
    activity,
    activityKind: activity,
    detail,
    detailKind: activity === "online" ? "idle" : "other",
  };
  return {
    kind: "patch:trajectory-append",
    agentId: "agent-1",
    entries: [entry],
    serverSeq: seq,
    timestamp,
  };
}

function trajectoryStatusEvent(
  seq: number | undefined,
  activity: AgentActivity,
  detail: string,
  timestamp = seq ?? 0,
  detailKind: AgentActivityDetailKind = activity === "online" ? "idle" : "other",
): AgentActivityEvent {
  const entry: TrajectoryEntry = {
    kind: "status",
    activity,
    activityKind: activity,
    detail,
    detailKind,
  };
  return {
    kind: "patch:trajectory-append",
    agentId: "agent-1",
    entries: [entry],
    serverSeq: seq,
    timestamp,
  };
}

function trajectoryAppendEvent(
  entry: TrajectoryEntry,
  {
    timestamp,
    serverSeq,
    joinKeys,
  }: {
    timestamp: number;
    serverSeq?: number;
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string };
  },
): AgentActivityEvent {
  return {
    kind: "patch:trajectory-append",
    agentId: "agent-1",
    entries: [entry],
    timestamp,
    serverSeq,
    joinKeys,
  };
}

function trajectoryLogEntry(seq: number, activity: AgentActivity, detail = "", timestamp = seq): AgentActivityDomainState["trajectoryLogs"][string][number] {
  const event = trajectoryEvent(seq, activity, detail, timestamp);
  return {
    timestamp,
    serverSeq: seq,
    entry: event.kind === "patch:trajectory-append" ? event.entries[0]! : { kind: "status", activity, detail },
  };
}

function fold(events: AgentActivityEvent[], initial = emptyState()): AgentActivityDomainState {
  const domain = createAgentActivityDomain({ initialState: initial });
  for (const event of events) domain.store.dispatch(event);
  return domain.store.getState();
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
  );
}

function eventSeq(event: AgentActivityEvent): number | undefined {
  if (event.kind === "patch:socket-activity") return event.serverSeq;
  if (event.kind === "patch:trajectory-append") return event.serverSeq;
  return undefined;
}

function eventRank(event: AgentActivityEvent): number {
  if (event.kind === "reset-seq") return 0;
  if (event.kind === "patch:socket-activity") return 1;
  if (event.kind === "patch:trajectory-append") return 2;
  return 3;
}

function canonicalOrder(events: AgentActivityEvent[]): AgentActivityEvent[] {
  return [...events].sort((a, b) => {
    const aSeq = eventSeq(a);
    const bSeq = eventSeq(b);
    if (aSeq == null && bSeq == null) return eventRank(a) - eventRank(b);
    if (aSeq == null) return -1;
    if (bSeq == null) return 1;
    return aSeq - bSeq || eventRank(a) - eventRank(b) || JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
}

function splitEpochs(events: AgentActivityEvent[]): AgentActivityEvent[][] {
  const epochs: AgentActivityEvent[][] = [[]];
  for (const event of events) {
    if (event.kind === "reset-seq") {
      epochs.push([]);
    } else {
      epochs[epochs.length - 1]!.push(event);
    }
  }
  return epochs;
}

function flattenEpochs(epochs: AgentActivityEvent[][]): AgentActivityEvent[] {
  return epochs.flatMap((events, index) => (index === 0 ? events : [{ kind: "reset-seq" } satisfies AgentActivityEvent, ...events]));
}

function canonicalEpochFold(epochs: AgentActivityEvent[][]): AgentActivityEvent[] {
  return flattenEpochs(epochs.map(canonicalOrder));
}

function comparableCurrentState(event: AgentActivityEvent): { seq: number; state: AgentActivityState } | null {
  const seq = eventSeq(event);
  if (seq == null) return null;
  if (event.kind === "patch:socket-activity") {
    return {
      seq,
      state: {
        activity: event.activityKind as AgentActivity,
        activityDetail: event.activityDetail,
        detailKind: event.detailKind === "idle" ? "idle" : "other",
      },
    };
  }
  if (event.kind === "patch:trajectory-append") {
    const status = event.entries.find((entry): entry is Extract<TrajectoryEntry, { kind: "status" }> => entry.kind === "status");
    if (!status) return null;
    return {
      seq,
      state: {
        activity: status.activityKind ?? status.activity,
        activityDetail: status.detail || "",
        detailKind: status.detailKind ?? "other",
      },
    };
  }
  return null;
}

function canonicalCurrent(events: AgentActivityEvent[]): AgentActivityState | undefined {
  let current: AgentActivityState | undefined;
  for (const epoch of splitEpochs(events)) {
    let epochSeq = -Infinity;
    for (const event of canonicalOrder(epoch)) {
      const comparable = comparableCurrentState(event);
      if (!comparable || comparable.seq <= epochSeq) continue;
      epochSeq = comparable.seq;
      current = comparable.state;
    }
  }
  return current;
}

function currentProjection(state: AgentActivityDomainState): Pick<AgentActivityDomainState, "agentActivities" | "agentActivitySeq"> {
  // Trajectory logs are intentionally excluded from producer-order convergence:
  // they are a display/log projection and can retain arrival-order detail.
  return {
    agentActivities: state.agentActivities,
    agentActivitySeq: state.agentActivitySeq,
  };
}

test("M-15: newer comparable trajectory writeback mechanically materializes idle regardless of timestamp", () => {
  const state = fold([
    socketEvent(12, "working", "Running tests", 999),
    trajectoryEvent(13, "online", "", 100),
  ]);

  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "online",
    activityDetail: "",
    detailKind: "idle",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 13);
});

test("M-15: older comparable trajectory replay logs but cannot cover newer socket state", () => {
  const state = fold([
    socketEvent(12, "thinking", "Planning fix", 100),
    trajectoryEvent(11, "online", "", 999),
  ]);

  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "Planning fix",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1, "stale replay still stays available for log readouts");
});

test("equal producer seq conflicting trajectory enriches log without rewriting current", () => {
  const state = fold([
    socketEvent(12, "working", "Socket fact", 100),
    trajectoryEvent(12, "online", "Durable twin must not win by timestamp", 999),
  ]);

  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Socket fact",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1);
});

test("same producer seq conflicting trajectory keeps current and requests reconcile", () => {
  const initial = fold([socketEvent(12, "working", "Socket fact", 100)]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(trajectoryEvent(12, "online", "conflicting durable fact", 999));
  const state = domain.store.getState();

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.equal(transition.reconcileSuggested, true);
  assert.equal(transition.logTouched, 1);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Socket fact",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1);
});

test("same producer seq conflicting socket event reports producer conflict with basis", () => {
  const initial = fold([socketEvent(12, "working", "Current command", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(socketEvent(12, "online", "Idle", 101, "idle"));

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.equal(transition.reconcileSuggested, true);
  assert.deepEqual(transition.violationBasis, {
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: true,
    same_detail_bucket: false,
    currentActivity: "working",
    projectedActivity: "online",
    currentDetailKind: "running_command",
    projectedDetailKind: "idle",
  });
});

test("older producer seq socket event stays stale even when content differs", () => {
  const initial = fold([socketEvent(12, "working", "Current command", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(socketEvent(11, "online", "Older idle", 101, "idle"));

  assert.equal(transition.outcome, "stale_server_seq");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
});

test("same producer seq presence mismatch reports producer conflict", () => {
  const initial = fold([socketEvent(12, "working", "Current command", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "", 101, "running_command"),
  );

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.equal(transition.violationBasis?.same_activity, true);
  assert.equal(transition.violationBasis?.same_detail_kind, true);
  assert.equal(transition.violationBasis?.same_detail_presence, false);
  assert.equal(transition.violationBasis?.same_detail_bucket, false);
});

test("same producer seq whitespace detail canonicalizes to absent detail", () => {
  const initial = fold([socketEvent(12, "working", "   ", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "", 101, "running_command"),
  );

  assert.equal(transition.outcome, "logged");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
});

test("same producer seq dual representation does not report producer conflict", () => {
  const initial = fold([socketEvent(12, "working", "npm test -- --runInBand", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "Running command", 999, "running_command"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "logged");
  assert.equal(transition.reconcileSuggested, false);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "npm test -- --runInBand",
    detailKind: "running_command",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1);
});

test("same producer seq trajectory fallback detail kind inherits socket strong classification", () => {
  const initial = fold([socketEvent(12, "working", "npm test -- --runInBand", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "Running command", 999, "other"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "logged");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "npm test -- --runInBand",
    detailKind: "running_command",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1);
});

test("same producer seq socket strong detail kind upgrades trajectory fallback current", () => {
  const initial = fold([trajectoryStatusEvent(12, "working", "Running command", 100, "other")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    socketEvent(12, "working", "npm test -- --runInBand", 101, "running_command"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "applied");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "npm test -- --runInBand",
    detailKind: "running_command",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
  assert.equal(state.activityLogs["agent-1"]?.length, 1);
  assert.equal(state.trajectoryLogs["agent-1"]?.length, 1);
});

test("trajectory fallback detail kind still conflicts on activity mismatch", () => {
  const initial = fold([socketEvent(12, "working", "npm test -- --runInBand", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "online", "Running command", 101, "other"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.equal(transition.reconcileSuggested, true);
  assert.equal(transition.violationBasis?.same_activity, false);
  assert.equal(transition.violationBasis?.same_detail_presence, true);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "npm test -- --runInBand",
    detailKind: "running_command",
  });
});

test("trajectory fallback detail kind still conflicts on detail presence mismatch", () => {
  const initial = fold([socketEvent(12, "working", "npm test -- --runInBand", 100, "running_command")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "", 101, "other"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.equal(transition.reconcileSuggested, true);
  assert.equal(transition.violationBasis?.same_activity, true);
  assert.equal(transition.violationBasis?.same_detail_presence, false);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "npm test -- --runInBand",
    detailKind: "running_command",
  });
});

test("older socket strong detail kind cannot upgrade trajectory fallback current", () => {
  const initial = fold([trajectoryStatusEvent(12, "working", "Running command", 100, "other")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    socketEvent(11, "working", "npm test -- --runInBand", 101, "running_command"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "stale_server_seq");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running command",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
});

test("same producer seq socket fallback detail kind cannot upgrade trajectory fallback current", () => {
  const initial = fold([trajectoryStatusEvent(12, "working", "Running command", 100, "other")]);
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch(
    socketEvent(12, "working", "Running command", 101, "other"),
  );
  const state = domain.store.getState();

  assert.equal(transition.outcome, "stale_server_seq");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running command",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 12);
});

const DETAIL_BUCKET_PEERS: Array<{
  kind: AgentActivityDetailKind;
  sameBucketPeer: AgentActivityDetailKind;
  differentBucketPeer: AgentActivityDetailKind;
}> = [
  { kind: "none", sameBucketPeer: "idle", differentBucketPeer: "running_command" },
  { kind: "message_received", sameBucketPeer: "system_message", differentBucketPeer: "running_command" },
  { kind: "starting", sameBucketPeer: "ready", differentBucketPeer: "running_command" },
  { kind: "runtime_starting", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "idle", sameBucketPeer: "none", differentBucketPeer: "running_command" },
  { kind: "running_command", sameBucketPeer: "checking_messages", differentBucketPeer: "other" },
  { kind: "checking_messages", sameBucketPeer: "running_command", differentBucketPeer: "other" },
  { kind: "compacting_context", sameBucketPeer: "compaction_stale", differentBucketPeer: "other" },
  { kind: "compaction_finished", sameBucketPeer: "compacting_context", differentBucketPeer: "other" },
  { kind: "compaction_stale", sameBucketPeer: "compacting_context", differentBucketPeer: "other" },
  { kind: "reviewing_changes", sameBucketPeer: "review_stale", differentBucketPeer: "other" },
  { kind: "review_finished", sameBucketPeer: "reviewing_changes", differentBucketPeer: "other" },
  { kind: "review_stale", sameBucketPeer: "reviewing_changes", differentBucketPeer: "other" },
  { kind: "runtime_reconnecting", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "runtime_error", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "runtime_crashed", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "runtime_unavailable", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "runtime_stalled", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "stalled_recovery", sameBucketPeer: "ready", differentBucketPeer: "running_command" },
  { kind: "stopped", sameBucketPeer: "ready", differentBucketPeer: "running_command" },
  { kind: "ready", sameBucketPeer: "stopped", differentBucketPeer: "running_command" },
  { kind: "runtime_interrupted", sameBucketPeer: "runtime_progress", differentBucketPeer: "running_command" },
  { kind: "machine_disconnected", sameBucketPeer: "other", differentBucketPeer: "running_command" },
  { kind: "daemon_activity", sameBucketPeer: "external_activity", differentBucketPeer: "running_command" },
  { kind: "external_activity", sameBucketPeer: "daemon_activity", differentBucketPeer: "running_command" },
  { kind: "synthetic_repair", sameBucketPeer: "ready", differentBucketPeer: "running_command" },
  { kind: "slock_action", sameBucketPeer: "system_message", differentBucketPeer: "running_command" },
  { kind: "system_message", sameBucketPeer: "slock_action", differentBucketPeer: "running_command" },
  { kind: "runtime_progress", sameBucketPeer: "runtime_error", differentBucketPeer: "running_command" },
  { kind: "subagent_activity", sameBucketPeer: "external_activity", differentBucketPeer: "running_command" },
  { kind: "other", sameBucketPeer: "machine_disconnected", differentBucketPeer: "running_command" },
];

function sameSeqBasisForDetailKinds(
  kind: AgentActivityDetailKind,
  projectedKind: AgentActivityDetailKind,
): AgentActivityViolationBasis {
  // Incoming trajectory `other` is a projection fallback. Put `other` on the
  // current side for this classifier table so the incoming event still carries
  // a strong kind and exercises the verdict-basis conflict path.
  const currentKind = projectedKind === "other" && kind !== "other" ? projectedKind : kind;
  const incomingKind = projectedKind === "other" && kind !== "other" ? kind : projectedKind;
  const initial = fold([socketEvent(12, "working", "current detail", 100, currentKind)]);
  const domain = createAgentActivityDomain({ initialState: initial });
  const transition = domain.store.dispatch(
    trajectoryStatusEvent(12, "working", "projected detail", 101, incomingKind),
  );

  assert.equal(transition.outcome, "producer_seq_conflict");
  assert.ok(transition.violationBasis);
  assert.equal(transition.violationBasis.same_activity, true);
  assert.equal(transition.violationBasis.same_detail_kind, false);
  assert.equal(transition.violationBasis.same_detail_presence, true);
  return transition.violationBasis;
}

test("same producer seq verdict basis classifies every detail-kind bucket", () => {
  for (const { kind, sameBucketPeer, differentBucketPeer } of DETAIL_BUCKET_PEERS) {
    assert.equal(
      sameSeqBasisForDetailKinds(kind, sameBucketPeer).same_detail_bucket,
      true,
      `${kind} should share a bucket with ${sameBucketPeer}`,
    );
    assert.equal(
      sameSeqBasisForDetailKinds(kind, differentBucketPeer).same_detail_bucket,
      false,
      `${kind} should not share a bucket with ${differentBucketPeer}`,
    );
  }
});

test("same producer seq conflicting hydrate does not guess current from input order", () => {
  const hydrate = (entries: AgentActivityDomainState["trajectoryLogs"][string]): AgentActivityEvent => ({
    kind: "hydrate:trajectory-log",
    agentId: "agent-1",
    entries,
  });
  const working = trajectoryLogEntry(12, "working", "working fact", 100);
  const online = trajectoryLogEntry(12, "online", "online fact", 999);
  const a = createAgentActivityDomain({ initialState: emptyState() });
  const b = createAgentActivityDomain({ initialState: emptyState() });

  const transitionA = a.store.dispatch(hydrate([working, online]));
  const transitionB = b.store.dispatch(hydrate([online, working]));

  assert.equal(transitionA.outcome, "producer_seq_conflict");
  assert.equal(transitionB.outcome, "producer_seq_conflict");
  assert.equal(transitionA.reconcileSuggested, true);
  assert.equal(transitionB.reconcileSuggested, true);
  assert.deepEqual(transitionA.violationBasis, {
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: true,
    same_detail_bucket: false,
    currentActivity: "working",
    projectedActivity: "online",
    currentDetailKind: "other",
    projectedDetailKind: "idle",
  });
  assert.equal(transitionA.serverSeq, 12);
  assert.equal(transitionA.timestamp, 999);
  assert.equal(a.store.getState().agentActivities["agent-1"], undefined);
  assert.equal(b.store.getState().agentActivities["agent-1"], undefined);
  assert.equal(a.store.getState().agentActivitySeq["agent-1"], undefined);
  assert.equal(b.store.getState().agentActivitySeq["agent-1"], undefined);
  assert.equal(a.store.getState().trajectoryLogs["agent-1"]?.length, 2);
  assert.equal(b.store.getState().trajectoryLogs["agent-1"]?.length, 2);
});

test("same producer seq without current activity cannot report producer conflict", () => {
  const domain = createAgentActivityDomain({
    initialState: {
      ...emptyState(),
      agentActivitySeq: { "agent-1": 12 },
    },
  });

  const transition = domain.store.dispatch(socketEvent(12, "working", "projected detail", 101, "running_command"));

  assert.equal(transition.outcome, "stale_server_seq");
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(transition.violationBasis, undefined);
});

test("re-baseline resets the comparable sequence space", () => {
  const state = fold([
    socketEvent(12, "working", "Old epoch"),
    { kind: "reset-seq" },
    socketEvent(1, "thinking", "New epoch"),
  ]);

  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "New epoch",
    detailKind: "other",
  });
  assert.equal(state.agentActivitySeq["agent-1"], 1);
});

test("reset-seq clears launch, seq, and clientEventId join state, but empty reset is a no-op", () => {
  const empty = createAgentActivityDomain({ initialState: emptyState() });
  const emptyBefore = empty.store.getState();
  const emptyTransition = empty.store.dispatch({ kind: "reset-seq" });
  assert.equal(empty.store.getState(), emptyBefore);
  assert.equal(emptyTransition.touched, 0);

  const initial = {
    ...emptyState(),
    agentActivitySeq: { "agent-1": 12 },
    agentActivityLaunchId: { "agent-1": "launch-1" },
    agentActivityTraceJoins: { "agent-1": { clientEventId: "client-event-1" } },
  };
  const domain = createAgentActivityDomain({ initialState: initial });

  const transition = domain.store.dispatch({ kind: "reset-seq" });
  assert.equal(transition.touched, 1);
  assert.deepEqual(domain.store.getState().agentActivitySeq, {});
  assert.deepEqual(domain.store.getState().agentActivityLaunchId, {});
  assert.deepEqual(domain.store.getState().agentActivityTraceJoins, {});

  for (const state of [
    { ...emptyState(), agentActivityLaunchId: { "agent-1": "launch-only" } },
    { ...emptyState(), agentActivityTraceJoins: { "agent-1": { clientEventId: "client-event-only" } } },
  ]) {
    const singleFieldDomain = createAgentActivityDomain({ initialState: state });
    const singleFieldTransition = singleFieldDomain.store.dispatch({ kind: "reset-seq" });
    assert.equal(singleFieldTransition.touched, 1);
    assert.deepEqual(singleFieldDomain.store.getState().agentActivitySeq, {});
    assert.deepEqual(singleFieldDomain.store.getState().agentActivityLaunchId, {});
    assert.deepEqual(singleFieldDomain.store.getState().agentActivityTraceJoins, {});
  }
});

test("clientEventId join state updates only on current activity writes", () => {
  const join = { clientEventId: "client-event-1" };
  const domain = createAgentActivityDomain({ initialState: emptyState() });

  domain.store.dispatch(socketEvent(1, "working", "first", 1, undefined, join));
  const firstTraceJoins = domain.store.getState().agentActivityTraceJoins;
  assert.deepEqual(firstTraceJoins["agent-1"], join);

  domain.store.dispatch(socketEvent(2, "thinking", "second", 2, undefined, join));
  assert.equal(
    domain.store.getState().agentActivityTraceJoins,
    firstTraceJoins,
    "same clientEventId should preserve the join map reference",
  );

  domain.store.dispatch(socketEvent(3, "online", "", 3));
  assert.deepEqual(domain.store.getState().agentActivityTraceJoins, {});

  const noJoinMap = domain.store.getState().agentActivityTraceJoins;
  domain.store.dispatch(socketEvent(4, "working", "no join", 4));
  assert.equal(
    domain.store.getState().agentActivityTraceJoins,
    noJoinMap,
    "missing join should not allocate a fresh empty join map",
  );
});

test("non-comparable trajectory events are log-side only and do not enter seq space", () => {
  const a = fold([
    socketEvent(5, "working", "Current"),
    trajectoryEvent(undefined, "online", "legacy idle", 1_000),
  ]);
  const b = fold([
    trajectoryEvent(undefined, "online", "legacy idle", 1_000),
    socketEvent(5, "working", "Current"),
  ]);

  assert.deepEqual(a.agentActivities, b.agentActivities);
  assert.equal(a.agentActivities["agent-1"]?.activity, "working");
  assert.equal(a.agentActivitySeq["agent-1"], 5);
  assert.equal(a.trajectoryLogs["agent-1"]?.length, 1);
});

test("hydrate snapshot and live socket trajectory overlap dedupe the same visible fact", () => {
  const hydrateEntry = {
    kind: "slock_action",
    title: "Send held by freshness check",
    text: "target: #proj-o11y:6a8771cd\nnew messages: 1 newer message",
  } satisfies TrajectoryEntry;
  const socketEntry = {
    text: "target: #proj-o11y:6a8771cd\nnew messages: 1 newer message",
    title: "Send held by freshness check",
    kind: "slock_action",
  } as TrajectoryEntry;
  const hydrate: AgentActivityEvent = {
    kind: "hydrate:trajectory-log",
    agentId: "agent-1",
    entries: [{ timestamp: 1_000, entry: hydrateEntry }],
  };
  const socketAppend: AgentActivityEvent = {
    kind: "patch:trajectory-append",
    agentId: "agent-1",
    entries: [socketEntry],
    timestamp: 1_000,
    serverSeq: 12,
    joinKeys: { launchId: "launch-1", clientSeq: 7, probeId: "probe-1" },
  };

  for (const events of [[hydrate, socketAppend], [socketAppend, hydrate]]) {
    const state = fold(events);

    assert.deepEqual(state.trajectoryLogs["agent-1"], [{
      timestamp: 1_000,
      entry: socketEntry,
      serverSeq: 12,
      launchId: "launch-1",
      clientSeq: 7,
      probeId: "probe-1",
    }]);
  }
});

test("source-identical trajectory duplicate is a no-op", () => {
  const entry = {
    kind: "slock_action",
    title: "Send held by freshness check",
    text: "target: #proj-o11y:6a8771cd",
  } satisfies TrajectoryEntry;
  const event = trajectoryAppendEvent(entry, {
    timestamp: 1_000,
    serverSeq: 12,
    joinKeys: { launchId: "launch-1", clientSeq: 7, probeId: "probe-1" },
  });
  const domain = createAgentActivityDomain({ initialState: emptyState() });

  domain.store.dispatch(event);
  const before = domain.store.getState();
  const beforeLog = before.trajectoryLogs["agent-1"];
  const transition = domain.store.dispatch(event);

  assert.equal(transition.outcome, "no_op");
  assert.equal(transition.logTouched, 0);
  assert.equal(domain.store.getState(), before);
  assert.equal(domain.store.getState().trajectoryLogs["agent-1"], beforeLog);
  assert.equal(beforeLog?.length, 1);
});

test("hydrated overlap after live trajectory is a no-op by reference", () => {
  const socketEntry = {
    kind: "slock_action",
    title: "Send held by freshness check",
    text: "target: #proj-o11y:6a8771cd",
  } satisfies TrajectoryEntry;
  const hydrateEntry = {
    text: "target: #proj-o11y:6a8771cd",
    title: "Send held by freshness check",
    kind: "slock_action",
  } as TrajectoryEntry;
  const socketAppend = trajectoryAppendEvent(socketEntry, {
    timestamp: 1_000,
    serverSeq: 12,
    joinKeys: { launchId: "launch-1", clientSeq: 7, probeId: "probe-1" },
  });
  const hydrate: AgentActivityEvent = {
    kind: "hydrate:trajectory-log",
    agentId: "agent-1",
    entries: [{ timestamp: 1_000, entry: hydrateEntry }],
  };
  const domain = createAgentActivityDomain({ initialState: emptyState() });

  domain.store.dispatch(socketAppend);
  const before = domain.store.getState();
  const beforeLog = before.trajectoryLogs["agent-1"];
  const transition = domain.store.dispatch(hydrate);

  assert.equal(transition.outcome, "no_op");
  assert.equal(transition.logTouched, 0);
  assert.equal(domain.store.getState(), before);
  assert.equal(domain.store.getState().trajectoryLogs["agent-1"], beforeLog);
  assert.deepEqual(beforeLog, [{
    timestamp: 1_000,
    entry: socketEntry,
    serverSeq: 12,
    launchId: "launch-1",
    clientSeq: 7,
    probeId: "probe-1",
  }]);
});

test("source-identifiable same visible trajectory rows without producer fact remain distinct", () => {
  const entry = {
    kind: "slock_action",
    title: "Same visible action",
    text: "same text",
  } satisfies TrajectoryEntry;
  const variants: Array<{
    label: string;
    first: Parameters<typeof trajectoryAppendEvent>[1];
    second: Parameters<typeof trajectoryAppendEvent>[1];
  }> = [
    {
      label: "serverSeq",
      first: { timestamp: 1_000, serverSeq: 11 },
      second: { timestamp: 1_000, serverSeq: 12 },
    },
    {
      label: "launchId",
      first: { timestamp: 1_000, joinKeys: { launchId: "launch-a" } },
      second: { timestamp: 1_000, joinKeys: { launchId: "launch-b" } },
    },
    {
      label: "clientSeq",
      first: { timestamp: 1_000, joinKeys: { clientSeq: 1 } },
      second: { timestamp: 1_000, joinKeys: { clientSeq: 2 } },
    },
    {
      label: "probeId",
      first: { timestamp: 1_000, joinKeys: { probeId: "probe-a" } },
      second: { timestamp: 1_000, joinKeys: { probeId: "probe-b" } },
    },
  ];

  for (const variant of variants) {
    const state = fold([
      trajectoryAppendEvent(entry, variant.first),
      trajectoryAppendEvent(entry, variant.second),
    ]);

    assert.equal(state.trajectoryLogs["agent-1"]?.length, 2, variant.label);
  }
});

test("same producer fact trajectory rows dedupe and keep the first source identity", () => {
  const entry = {
    kind: "text",
    text: "shared producer fact",
    producerFactId: "producer-fact-1",
  } satisfies TrajectoryEntry;

  const state = fold([
    trajectoryAppendEvent(entry, { timestamp: 1_000, serverSeq: 11 }),
    trajectoryAppendEvent(entry, { timestamp: 1_000, serverSeq: 12 }),
  ]);

  assert.deepEqual(state.trajectoryLogs["agent-1"], [{
    timestamp: 1_000,
    entry,
    serverSeq: 11,
  }]);
});

test("mismatched or invalid producer fact ids do not dedupe source-identifiable trajectory rows", () => {
  const variants: Array<{ label: string; first: TrajectoryEntry; second: TrajectoryEntry }> = [
    {
      label: "different producer fact ids",
      first: { kind: "text", text: "same text", producerFactId: "producer-fact-1" },
      second: { kind: "text", text: "same text", producerFactId: "producer-fact-2" },
    },
    {
      label: "empty producer fact id",
      first: { kind: "text", text: "same text", producerFactId: "" },
      second: { kind: "text", text: "same text", producerFactId: "" },
    },
    {
      label: "non-string producer fact id",
      first: { kind: "text", text: "same text", producerFactId: 123 } as unknown as TrajectoryEntry,
      second: { kind: "text", text: "same text", producerFactId: 123 } as unknown as TrajectoryEntry,
    },
  ];

  for (const variant of variants) {
    const state = fold([
      trajectoryAppendEvent(variant.first, { timestamp: 1_000, serverSeq: 11 }),
      trajectoryAppendEvent(variant.second, { timestamp: 1_000, serverSeq: 12 }),
    ]);

    assert.equal(state.trajectoryLogs["agent-1"]?.length, 2, variant.label);
  }
});

test("trajectory visible keys normalize top-level entry order and undefined fields without collapsing distinct facts", () => {
  const withUndefined = {
    kind: "text",
    text: "same text",
    producerFactId: undefined,
  } as unknown as TrajectoryEntry;
  const withoutUndefined = {
    text: "same text",
    kind: "text",
  } as TrajectoryEntry;
  const sameFact = fold([
    {
      kind: "hydrate:trajectory-log",
      agentId: "agent-1",
      entries: [{ timestamp: 1_000, entry: withUndefined }],
    },
    trajectoryAppendEvent(withoutUndefined, { timestamp: 1_000, serverSeq: 12 }),
  ]);

  assert.deepEqual(sameFact.trajectoryLogs["agent-1"], [{
    timestamp: 1_000,
    entry: withoutUndefined,
    serverSeq: 12,
  }]);

  const distinctFacts = fold([{
    kind: "hydrate:trajectory-log",
    agentId: "agent-1",
    entries: [
      { timestamp: 1_000, entry: { kind: "text", text: "first text" } },
      { timestamp: 1_000, entry: { kind: "text", text: "second text" } },
    ],
  }]);

  assert.deepEqual(
    distinctFacts.trajectoryLogs["agent-1"]?.map((item) => item.entry),
    [
      { kind: "text", text: "first text" },
      { kind: "text", text: "second text" },
    ],
  );
});

test("merged trajectory log remains sorted and capped to the latest rows", () => {
  const entries = Array.from({ length: MAX_TRAJECTORY_ENTRIES + 2 }, (_, index) => ({
    timestamp: MAX_TRAJECTORY_ENTRIES + 1 - index,
    entry: { kind: "text", text: `row-${index}` } satisfies TrajectoryEntry,
  }));

  const state = fold([{
    kind: "hydrate:trajectory-log",
    agentId: "agent-1",
    entries,
  }]);
  const log = state.trajectoryLogs["agent-1"] ?? [];

  assert.equal(log.length, MAX_TRAJECTORY_ENTRIES);
  assert.equal(log[0]?.timestamp, 2);
  assert.equal(log.at(-1)?.timestamp, MAX_TRAJECTORY_ENTRIES + 1);
  for (let index = 1; index < log.length; index += 1) {
    assert.ok(log[index - 1]!.timestamp < log[index]!.timestamp);
  }
});

test("non-comparable trajectory activity suggests reconcile instead of hard-writing current", () => {
  const domain = createAgentActivityDomain({ initialState: emptyState() });

  const transition = domain.store.dispatch(trajectoryEvent(undefined, "thinking", "legacy frame", 100));

  assert.equal(transition.reconcileSuggested, true);
  assert.equal(domain.store.getState().agentActivities["agent-1"], undefined);
  assert.equal(domain.store.getState().agentActivitySeq["agent-1"], undefined);
});

test("stale producer event is a createEventStore no-op by reference", () => {
  const initial = fold([socketEvent(5, "working", "Current")]);
  const domain = createAgentActivityDomain({ initialState: initial });
  const before = domain.store.getState();

  domain.store.dispatch(socketEvent(4, "thinking", "Old event"));

  assert.equal(domain.store.getState(), before);
});

test("small-N comparable events converge across all arrival orders and anchor to canonical fold", () => {
  const events = [
    socketEvent(10, "working", "Working twin"),
    trajectoryEvent(10, "working", "Working twin"),
    trajectoryEvent(11, "online", ""),
    trajectoryEvent(9, "thinking", "Old replay"),
    trajectoryEvent(undefined, "working", "Legacy log"),
  ];
  const anchor = fold(canonicalOrder(events));
  const expectedCurrent = canonicalCurrent(events);

  assert.deepEqual(anchor.agentActivities["agent-1"], expectedCurrent);
  for (const order of permutations(events)) {
    assert.deepEqual(currentProjection(fold(order)), currentProjection(anchor));
  }
});

test("fixed-seed property: producer-order fold converges to the canonical anchor", () => {
  const activityArb = fc.constantFrom<AgentActivity>("online", "thinking", "working");
  const comparableGroupArb = fc.record({
    seq: fc.integer({ min: 1, max: 40 }),
    source: fc.constantFrom("socket", "trajectory", "twin"),
    activity: activityArb,
    duplicate: fc.boolean(),
  });
  const epochArb = fc.record({
    comparable: fc.uniqueArray(comparableGroupArb, { minLength: 1, maxLength: 4, selector: (item) => item.seq }),
    nonComparable: fc.array(activityArb, { minLength: 0, maxLength: 2 }),
  }).map(({ comparable, nonComparable }) => [
    ...comparable.flatMap((item) => {
      const detail = item.activity === "online" ? "" : `fact-${item.seq}`;
      const events = item.source === "twin"
        ? [socketEvent(item.seq, item.activity, detail, item.seq * 10), trajectoryEvent(item.seq, item.activity, detail, item.seq * 10 + 1)]
        : [
            item.source === "socket"
              ? socketEvent(item.seq, item.activity, detail, item.seq * 10)
              : trajectoryEvent(item.seq, item.activity, detail, item.seq * 10 + 1),
          ];
      return item.duplicate ? [...events, ...events] : events;
    }),
    ...nonComparable.map((activity, index) => trajectoryEvent(undefined, activity, `legacy-${index}`, 10_000 + index)),
  ]);
  const scenarioArb = fc.array(epochArb, { minLength: 1, maxLength: 3 }).chain((epochs) => {
    let shuffledEpochsArb: fc.Arbitrary<AgentActivityEvent[][]> = fc.constant([]);
    for (const epoch of epochs) {
      shuffledEpochsArb = fc.tuple(shuffledEpochsArb, shuffledEvents(epoch)).map(([all, shuffled]) => [...all, shuffled]);
    }
    return shuffledEpochsArb.map((shuffledEpochs) => ({ epochs, shuffledEpochs }));
  });
  const scenario = (epochs: AgentActivityEvent[][], shuffledEpochs = epochs) => ({ epochs, shuffledEpochs });
  const twinEvents = [socketEvent(12, "working", "same fact"), trajectoryEvent(12, "working", "same fact", 999)];
  const resetEvents = [[socketEvent(12, "working", "Old epoch")], [socketEvent(1, "thinking", "New epoch")]];

  fc.assert(
    fc.property(scenarioArb, ({ epochs, shuffledEpochs }) => {
      const events = flattenEpochs(epochs);
      const anchor = fold(canonicalEpochFold(epochs));
      const shuffled = fold(flattenEpochs(shuffledEpochs));

      assert.deepEqual(anchor.agentActivities["agent-1"], canonicalCurrent(events));
      assert.deepEqual(currentProjection(shuffled), currentProjection(anchor));
    }),
    {
      numRuns: 250,
      seed: 24075,
      examples: [
        [scenario([twinEvents], [[twinEvents[1]!, twinEvents[0]!]])],
        [scenario(resetEvents)],
      ],
    },
  );
});

test("fixed-seed property: same-fact dual representations never report producer conflicts", () => {
  const semanticDetailKinds = fc.constantFrom<AgentActivityDetailKind>(
    "running_command",
    "checking_messages",
    "compacting_context",
    "reviewing_changes",
    "runtime_progress",
    "other",
  );
  const sameFactPairArb = fc.record({
    seq: fc.integer({ min: 1, max: 40 }),
    activity: fc.constantFrom<AgentActivity>("online", "thinking", "working"),
    detailKind: semanticDetailKinds,
    socketDetail: fc.constantFrom("npm test", "reading inbox", "reviewing diff", "checking status"),
    trajectoryDetail: fc.constantFrom("Running command", "Reading context", "Reviewing changes", "Checking messages"),
    trajectoryFirst: fc.boolean(),
  });

  fc.assert(
    fc.property(sameFactPairArb, ({ seq, activity, detailKind, socketDetail, trajectoryDetail, trajectoryFirst }) => {
      const socket = socketEvent(seq, activity, socketDetail, seq * 10, detailKind);
      const trajectory = trajectoryStatusEvent(seq, activity, trajectoryDetail, seq * 10 + 1, detailKind);
      const domain = createAgentActivityDomain({ initialState: emptyState() });
      const transitions = (trajectoryFirst ? [trajectory, socket] : [socket, trajectory])
        .map((event) => domain.store.dispatch(event));

      assert.equal(
        transitions.some((transition) => transition.outcome === "producer_seq_conflict"),
        false,
      );
    }),
    {
      numRuns: 100,
      seed: 90090,
      examples: [
        [{
          seq: 12,
          activity: "working" as AgentActivity,
          detailKind: "running_command" as AgentActivityDetailKind,
          socketDetail: "npm test",
          trajectoryDetail: "Running command",
          trajectoryFirst: false,
        }],
      ],
    },
  );
});

function shuffledEvents(events: AgentActivityEvent[]): fc.Arbitrary<AgentActivityEvent[]> {
  const indexes = events.map((_, index) => index);
  return fc.shuffledSubarray(indexes, { minLength: indexes.length, maxLength: indexes.length })
    .map((order) => order.map((index) => events[index]!));
}

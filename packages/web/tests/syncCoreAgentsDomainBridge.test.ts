/**
 * RFC 043 web-fold shortest path: the REAL agents-domain reducer runs as a
 * sync-core domain fold. This is the TS-side closure starting point (Tenny's
 * tonight line): a production web fold, mediated by the core, converges to
 * the anchored direct fold — no toy domain.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSyncCore } from "@botiverse/raft-shared";
import type { SyncDomainConfig, SyncFrame } from "@botiverse/raft-shared";
import {
  applyAgentActivityEvent,
} from "../src/store/events/agentActivityEvents.js";
import type {
  AgentActivityDomainState,
  AgentActivityEvent,
} from "../src/store/events/agentActivityEvents.js";

const INITIAL: AgentActivityDomainState = {
  agentActivities: {},
  agentActivityTraceJoins: {},
  agentActivityObservedAt: {},
  agentActivityVersions: {},
  agentActivitySeq: {},
  agentActivityLaunchId: {},
  activityLogs: {},
  trajectoryLogs: {},
};

function agentsDomain(): SyncDomainConfig<AgentActivityDomainState, AgentActivityEvent> {
  return {
    name: "agents",
    // Agent activity is the canonical sparse scope: serverSeq has holes by
    // construction (RFC 038 §9 density correction) — max-advance, no gaps.
    density: "sparse",
    initialState: () => INITIAL,
    fold: (state, event) => applyAgentActivityEvent(state, event).state,
    fromSnapshot: (snapshot) => snapshot.state as AgentActivityDomainState,
  };
}

function socketFrame(agentId: string, seq: number, activity: string): SyncFrame<AgentActivityEvent> {
  return {
    scopeId: agentId,
    seq,
    epoch: null,
    event: {
      kind: "patch:socket-activity",
      agentId,
      activity,
      activityDetail: `detail-${seq}`,
      serverSeq: seq,
      timestamp: 1_000 + seq,
    },
  };
}

test("core-mediated agents fold equals the anchored direct fold", () => {
  const frames = [socketFrame("agent-1", 3, "working"), socketFrame("agent-1", 7, "online"), socketFrame("agent-1", 12, "idle")];

  const core = createSyncCore({ domains: [agentsDomain() as SyncDomainConfig<unknown, unknown>] });
  for (const frame of frames) core.ingestFrame("agents", frame);

  let direct = INITIAL;
  for (const frame of frames) direct = applyAgentActivityEvent(direct, frame.event).state;

  assert.deepEqual(core.state("agents", "agent-1"), direct);
  assert.equal(core.scopeSyncState("agents", "agent-1")?.appliedSeq, 12);
  // Sparse scope: holes are legal, no repair traffic (RFC 038 §9).
  assert.equal(core.pendingRequests().length, 0);
});

test("core watermark shields the web fold from duplicate socket frames", () => {
  const core = createSyncCore({ domains: [agentsDomain() as SyncDomainConfig<unknown, unknown>] });
  core.ingestFrame("agents", socketFrame("agent-1", 5, "working"));
  const before = core.state("agents", "agent-1");
  const outcome = core.ingestFrame("agents", socketFrame("agent-1", 5, "working"));
  assert.equal(outcome.kind, "duplicate_dropped");
  assert.equal(core.state("agents", "agent-1"), before, "duplicate must not re-enter the fold");
});

test("out-of-order arrival converges to the same terminal state (permutation invariance)", () => {
  const frames = [socketFrame("agent-1", 2, "working"), socketFrame("agent-1", 9, "online"), socketFrame("agent-1", 4, "idle")];
  const orders = [
    [frames[0]!, frames[1]!, frames[2]!],
    [frames[2]!, frames[1]!, frames[0]!],
    [frames[1]!, frames[0]!, frames[2]!],
  ];
  const terminals = orders.map((order) => {
    const core = createSyncCore({ domains: [agentsDomain() as SyncDomainConfig<unknown, unknown>] });
    for (const frame of order) core.ingestFrame("agents", frame);
    return core.scopeSyncState("agents", "agent-1")?.appliedSeq;
  });
  // Watermark converges to max seq regardless of arrival order; stale frames
  // below the watermark never re-enter the fold (the M-15/M-18 discipline).
  assert.deepEqual(terminals, [9, 9, 9]);
});

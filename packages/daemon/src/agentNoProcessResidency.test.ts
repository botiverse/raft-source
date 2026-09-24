import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AgentNoProcessResidency,
  AgentNoProcessResidencyTransitions,
  type AgentNoProcessResidencySnapshot,
} from "./agentNoProcessResidency.js";

function snapshot(overrides: Partial<AgentNoProcessResidencySnapshot> = {}): AgentNoProcessResidencySnapshot {
  return {
    runningAgentIds: [],
    queuedAgentIds: [],
    startingAgentIds: [],
    idleAgentIds: [],
    terminalFailureAgentIds: [],
    activeCooldownAgentIds: [],
    fingerprintFenceAgentIds: [],
    pendingDeliveryAgentIds: [],
    ...overrides,
  };
}

test("AgentNoProcessResidency allows pending delivery for queued, starting, terminal, and cooldown-with-idle states", () => {
  const state = snapshot({
    queuedAgentIds: ["queued"],
    startingAgentIds: ["starting"],
    terminalFailureAgentIds: ["terminal"],
    idleAgentIds: ["cooldown"],
    activeCooldownAgentIds: ["cooldown"],
    pendingDeliveryAgentIds: ["queued", "starting", "terminal", "cooldown"],
  });

  AgentNoProcessResidency.assertInvariants("green", state);
  assert.deepEqual(AgentNoProcessResidency.allowedStartPendingSnapshot(state), {
    queuedAgentIds: ["queued"],
    startingAgentIds: ["starting"],
    terminalRecoveryAgentIds: ["terminal"],
    cooldownAgentIds: ["cooldown"],
  });
});

test("AgentNoProcessResidency proof-of-catch: cooldown without restart config is rejected", () => {
  assert.throws(
    () => AgentNoProcessResidency.assertInvariants("red", snapshot({
      activeCooldownAgentIds: ["agent-1"],
    })),
    /active cooldown without restart config/,
  );
});

test("AgentNoProcessResidency proof-of-catch: terminal failure cannot also be auto-restartable", () => {
  assert.throws(
    () => AgentNoProcessResidency.assertInvariants("red", snapshot({
      idleAgentIds: ["agent-1"],
      terminalFailureAgentIds: ["agent-1"],
    })),
    /terminal failure and idle restart config both present/,
  );
});

test("AgentNoProcessResidency proof-of-catch: terminal failure cannot be a stable running state", () => {
  assert.throws(
    () => AgentNoProcessResidency.assertInvariants("red", snapshot({
      runningAgentIds: ["agent-1"],
      terminalFailureAgentIds: ["agent-1"],
    })),
    /terminal failure while process is still registered/,
  );
});

test("AgentNoProcessResidency proof-of-catch: pending delivery needs concrete residency", () => {
  assert.throws(
    () => AgentNoProcessResidency.assertInvariants("red", snapshot({
      pendingDeliveryAgentIds: ["agent-1"],
    })),
    /pending delivery without queued\/starting\/terminal\/cooldown residency/,
  );
});

test("AgentNoProcessResidency allows fingerprint fence tied to wakeable idle retry evidence", () => {
  AgentNoProcessResidency.assertInvariants("green", snapshot({
    idleAgentIds: ["agent-1"],
    fingerprintFenceAgentIds: ["agent-1"],
  }));
});

test("AgentNoProcessResidency proof-of-catch: fingerprint fence alone is stale evidence", () => {
  assert.throws(
    () => AgentNoProcessResidency.assertInvariants("red", snapshot({
      fingerprintFenceAgentIds: ["agent-1"],
    })),
    /fingerprint fence without running process, idle retry config, or terminal failure/,
  );
});

test("AgentNoProcessResidencyTransitions emits stable enter/close pairing rows", () => {
  const transitions = new AgentNoProcessResidencyTransitions();
  const identity = {
    agentId: "agent-1",
    agentLaunchId: "launch-1",
    agentLaunchIdPresent: true,
    serverId: "server-1",
    machineId: "machine-1",
    runtime: "codex",
    driver: "codex",
    launchSource: "wake_message",
  };

  const [queuedEnter] = transitions.enter({
    ...identity,
    state: "queued_start",
    isWaitState: true,
    fenceKind: "start_scheduler",
    deadlineUnixMs: 100,
  });
  assert.equal(queuedEnter?.transition_kind, "enter");
  assert.equal(queuedEnter?.span_name, "launch_residency_transition");
  assert.equal(queuedEnter?.phase, "process_residency");
  assert.equal(queuedEnter?.state_instance_id, queuedEnter?.residency_state_instance_id);
  assert.equal(queuedEnter?.is_wait_state, true);
  assert.equal(queuedEnter?.deadline_unix_ms, 100);

  assert.deepEqual(transitions.enter({
    ...identity,
    state: "queued_start",
    isWaitState: true,
    fenceKind: "start_scheduler",
    deadlineUnixMs: 100,
  }), []);

  const [queuedClose, startingEnter] = transitions.enter({
    ...identity,
    state: "starting_process",
    isWaitState: true,
    fenceKind: "runtime_start_timeout",
    deadlineUnixMs: 200,
  });
  assert.equal(queuedClose?.transition_kind, "close");
  assert.equal(queuedClose?.close_result, "advanced");
  assert.equal(queuedClose?.state_instance_id, queuedEnter?.state_instance_id);
  assert.equal(startingEnter?.transition_kind, "enter");
  assert.notEqual(startingEnter?.state_instance_id, queuedEnter?.state_instance_id);

  const [startingClose] = transitions.close("agent-1", { closeResult: "advanced" });
  assert.equal(startingClose?.transition_kind, "close");
  assert.equal(startingClose?.state_instance_id, startingEnter?.state_instance_id);
  assert.equal(startingClose?.residency_state_instance_id, startingEnter?.residency_state_instance_id);
  assert.deepEqual(
    [queuedEnter, queuedClose, startingEnter, startingClose].map((row) => row?.transition_seq),
    [1, 2, 3, 4],
  );
});

test("AgentNoProcessResidencyTransitions emits closed negative evidence for missing launch id", () => {
  const transitions = new AgentNoProcessResidencyTransitions();
  const [enter] = transitions.enter({
    agentId: "agent-1",
    agentLaunchId: "missing_launch_id",
    agentLaunchIdPresent: false,
    serverId: "server-1",
    machineId: "machine-1",
    runtime: "codex",
    driver: "codex",
    launchSource: "wake_message",
    state: "starting_process",
    isWaitState: true,
    fenceKind: "runtime_start_timeout",
    deadlineUnixMs: 100,
    failureKind: "missing_launch_id",
    negativeEvidenceBucket: "missing_launch_id",
  });

  assert.equal(enter?.agent_launch_id, "missing_launch_id");
  assert.equal(enter?.agent_launch_id_present, false);
  assert.equal(enter?.failure_kind, "missing_launch_id");
  assert.equal(enter?.negative_evidence_bucket, "missing_launch_id");
});

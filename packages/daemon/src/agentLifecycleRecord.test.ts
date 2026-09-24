import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import {
  AgentLifecycleRecords,
  assertAgentLifecycleRecordInvariants,
  buildAgentLifecycleRecords,
  type AgentLifecycleRecordSnapshot,
  type AgentRestartSnapshot,
} from "./agentLifecycleRecord.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    agentCredentialId: "cred-test",
    ...overrides,
  };
}

function restartSnapshot(agentId: string): AgentRestartSnapshot {
  return {
    config: makeConfig({ name: agentId }),
    sessionId: `session-${agentId}`,
    launchId: `launch-${agentId}`,
  };
}

function snapshot(overrides: Partial<AgentLifecycleRecordSnapshot> = {}): AgentLifecycleRecordSnapshot {
  return {
    runningAgentIds: [],
    queuedAgentIds: [],
    startingAgentIds: [],
    idleRestartSnapshots: [],
    terminalFailures: [],
    activeSpawnFailBackoffs: [],
    pendingStartRebinds: [],
    pendingSpawnCauses: [],
    runtimeErrorFingerprintFences: [],
    activityClientSeqs: [],
    ...overrides,
  };
}

test("AgentLifecycleRecord projects running restart cache as running.restartSnapshot", () => {
  const records = buildAgentLifecycleRecords(snapshot({
    runningAgentIds: ["agent-1"],
    idleRestartSnapshots: [["agent-1", restartSnapshot("agent-1")]],
  }));

  assert.equal(records.get("agent-1")?.kind, "running");
  const record = records.get("agent-1");
  assert.equal(record?.kind === "running" ? record.restartSnapshot?.launchId : undefined, "launch-agent-1");
});

test("AgentLifecycleRecord projects restart cache without a process as idle", () => {
  const records = buildAgentLifecycleRecords(snapshot({
    idleRestartSnapshots: [["agent-1", restartSnapshot("agent-1")]],
  }));

  assert.deepEqual(records.get("agent-1"), {
    kind: "idle",
    agentId: "agent-1",
    restartSnapshot: restartSnapshot("agent-1"),
    fingerprintFence: undefined,
    activityClientSeq: undefined,
  });
});

test("AgentLifecycleRecord projects active spawn backoff with restart cache as cooldown", () => {
  const records = buildAgentLifecycleRecords(snapshot({
    idleRestartSnapshots: [["agent-1", restartSnapshot("agent-1")]],
    activeSpawnFailBackoffs: [["agent-1", { untilMs: 123 }]],
  }));

  const record = records.get("agent-1");
  assert.equal(record?.kind, "cooldown");
  assert.equal(record?.kind === "cooldown" ? record.restartSnapshot.launchId : undefined, "launch-agent-1");
});

test("AgentLifecycleRecords snapshots lifecycle owner mutations", () => {
  const records = new AgentLifecycleRecords<{ untilMs: number }, { fenceId: string }>();
  records.idleRestartSnapshots.set("agent-1", restartSnapshot("agent-1"));
  records.activeSpawnFailBackoffs.set("agent-1", { untilMs: 200 });
  records.runtimeErrorFingerprintFences.set("agent-1", { fenceId: "fence-1" });

  assert.equal(records.nextActivityClientSeq("agent-1"), 1);
  assert.equal(records.nextActivityClientSeq("agent-1"), 2);

  const projected = buildAgentLifecycleRecords(records.snapshot({
    runningAgentIds: [],
    queuedAgentIds: [],
    startingAgentIds: [],
    now: 100,
    isSpawnFailBackoffActive: (backoff, now) => backoff.untilMs > now,
  }));

  const record = projected.get("agent-1");
  assert.equal(record?.kind, "cooldown");
  assert.equal(record?.kind === "cooldown" ? record.activityClientSeq : undefined, 2);
  assert.deepEqual(record?.kind === "cooldown" ? record.fingerprintFence : undefined, { fenceId: "fence-1" });
});

test("AgentLifecycleRecord proof-of-catch: terminal failure cannot be a stable running state", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      runningAgentIds: ["agent-1"],
      terminalFailures: [["agent-1", { detail: "runtime error", launchId: "launch-1" }]],
    })),
    /terminal failure while process is still registered/,
  );
});

test("AgentLifecycleRecord proof-of-catch: terminal failure cannot keep a parallel idle restart entry", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      idleRestartSnapshots: [["agent-1", restartSnapshot("agent-1")]],
      terminalFailures: [["agent-1", { detail: "runtime error", launchId: "launch-1" }]],
    })),
    /terminal failure and idle restart config both present/,
  );
});

test("AgentLifecycleRecord proof-of-catch: terminal failure cannot retain pending start rebind", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      terminalFailures: [["agent-1", { detail: "runtime error", launchId: "launch-1" }]],
      pendingStartRebinds: [["agent-1", { config: makeConfig({ name: "agent-1" }) }]],
    })),
    /terminal failure and pending start rebind both present/,
  );
});

test("AgentLifecycleRecord proof-of-catch: cooldown requires restart snapshot", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      activeSpawnFailBackoffs: [["agent-1", { untilMs: 123 }]],
    })),
    /active cooldown without restart config/,
  );
});

test("AgentLifecycleRecord proof-of-catch: cooldown cannot keep a running process", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      runningAgentIds: ["agent-1"],
      idleRestartSnapshots: [["agent-1", restartSnapshot("agent-1")]],
      activeSpawnFailBackoffs: [["agent-1", { untilMs: 123 }]],
    })),
    /running process and active cooldown both present/,
  );
});

test("AgentLifecycleRecord proof-of-catch: queued and starting cannot overlap", () => {
  assert.throws(
    () => assertAgentLifecycleRecordInvariants("red", snapshot({
      queuedAgentIds: ["agent-1"],
      startingAgentIds: ["agent-1"],
    })),
    /queued and starting facts overlap/,
  );
});

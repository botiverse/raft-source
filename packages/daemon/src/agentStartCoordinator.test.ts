import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import { AgentStartCoordinator, type AgentStartQueueItem } from "./agentStartCoordinator.js";

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

function makeItem(agentId: string, launchId = `launch-${agentId}`): AgentStartQueueItem {
  return {
    agentId,
    enqueuedAtMs: 0,
    config: makeConfig({ name: agentId }),
    launchId,
    resolve: () => {},
    reject: () => {},
  };
}

test("AgentStartCoordinator keeps queue and lookup as one conformance boundary", () => {
  const coordinator = new AgentStartCoordinator({ maxConcurrentStarts: 1, minStartIntervalMs: 0 });

  coordinator.enqueue(makeItem("agent-1"));
  assert.deepEqual(coordinator.snapshot().queuedAgentIds, ["agent-1"]);
  assert.equal(coordinator.snapshot().queueDepth, 1);
  assert.equal(coordinator.getQueued("agent-1")?.launchId, "launch-agent-1");

  assert.throws(
    () => coordinator.enqueue(makeItem("agent-1", "launch-duplicate")),
    /already queued/,
    "same agent cannot be queued twice",
  );

  const dequeued = coordinator.dequeue();
  assert.equal(dequeued.kind, "item");
  assert.equal(dequeued.kind === "item" ? dequeued.item.agentId : undefined, "agent-1");
  assert.deepEqual(coordinator.snapshot().queuedAgentIds, []);
  assert.equal(coordinator.snapshot().queueDepth, 0);
});

test("AgentStartCoordinator reports queue age from the immutable enqueue time", () => {
  const coordinator = new AgentStartCoordinator({ maxConcurrentStarts: 1, minStartIntervalMs: 0 });
  coordinator.enqueue({
    ...makeItem("agent-1"),
    enqueuedAtMs: 1_000,
  });

  assert.equal(coordinator.queueAgeMs("agent-1", 1_250), 250);
  assert.equal(coordinator.queueAgeMs("agent-1", 2_000), 1_000);
  assert.equal(coordinator.getQueued("agent-1")?.enqueuedAtMs, 1_000);
  assert.equal(coordinator.queueAgeMs("missing", 2_000), 0);
});

test("AgentStartCoordinator asserts starting-never-queued policy", () => {
  const coordinator = new AgentStartCoordinator({ maxConcurrentStarts: 1, minStartIntervalMs: 0 });

  coordinator.markStarting("agent-1");
  assert.deepEqual(coordinator.snapshot().startingAgentIds, ["agent-1"]);
  assert.throws(
    () => coordinator.enqueue(makeItem("agent-1")),
    /already starting/,
    "starting agents cannot also enter the queued set",
  );

  coordinator.clearStarting("agent-1");
  coordinator.enqueue(makeItem("agent-1"));
  assert.throws(
    () => coordinator.markStarting("agent-1"),
    /still queued/,
    "queued agents must dequeue before entering starting",
  );
});

test("AgentStartCoordinator gates dequeue by capacity and reopens after slot release", () => {
  const coordinator = new AgentStartCoordinator({ maxConcurrentStarts: 1, minStartIntervalMs: 0 });
  coordinator.claimStartSlot("agent-active");
  coordinator.enqueue(makeItem("agent-2"));

  assert.deepEqual(coordinator.getPumpState(), { kind: "blocked", reason: "capacity_full" });

  assert.equal(coordinator.releaseStartSlot(), true);
  const state = coordinator.getPumpState();
  assert.equal(state.kind, "ready");
  assert.equal(state.kind === "ready" ? state.item.agentId : undefined, "agent-2");
});

test("AgentStartCoordinator cancel operations drain queue lookup and preserve pre-clear callback evidence", () => {
  const coordinator = new AgentStartCoordinator({ maxConcurrentStarts: 1, minStartIntervalMs: 0 });
  coordinator.enqueue(makeItem("agent-2"));
  coordinator.enqueue(makeItem("agent-3"));

  const single = coordinator.cancelQueued("agent-2");
  assert.equal(single?.agentId, "agent-2");
  assert.deepEqual(coordinator.snapshot().queuedAgentIds, ["agent-3"]);
  assert.equal(coordinator.snapshot().queueDepth, 1);

  const observedDepths: number[] = [];
  const all = coordinator.cancelAllQueued(() => {
    observedDepths.push(coordinator.snapshot().queueDepth);
  });
  assert.deepEqual(all.map((item) => item.agentId), ["agent-3"]);
  assert.deepEqual(observedDepths, [1], "cancel callbacks observe pre-clear queue state");
  assert.deepEqual(coordinator.snapshot().queuedAgentIds, []);
  assert.equal(coordinator.snapshot().queueDepth, 0);
});

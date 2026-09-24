import assert from "node:assert/strict";
import test from "node:test";
import { useLiveAgentActivityStore } from "../src/store/liveAgentActivityStore.js";
import type { Agent } from "../src/store/agentStore.js";

function resetStore() {
  useLiveAgentActivityStore.setState({ items: [] });
}

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("clear removes live agent progress immediately for server switches", () => {
  resetStore();
  const agents = [agent({ id: "agent-1", name: "runner", displayName: "Runner" })];

  useLiveAgentActivityStore.getState().recordStatusActivity({
    agentId: "agent-1",
    activity: "working",
    detail: "Running tests",
    timestamp: 10_000,
  }, agents);

  assert.equal(useLiveAgentActivityStore.getState().items.length, 1);

  useLiveAgentActivityStore.getState().clear();

  assert.deepEqual(useLiveAgentActivityStore.getState().items, []);
});

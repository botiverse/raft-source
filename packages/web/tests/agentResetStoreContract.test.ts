import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";

const originalPost = api.post.bind(api);

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    displayName: id,
    avatarUrl: null,
    description: null,
    status: "stopped",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    sessionId: `${id}-session`,
    runtimeProfile: null,
    creatorType: "user",
    creatorId: "human-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function seedStore() {
  useAgentStore.setState({
    agents: [agent("agent-1"), agent("agent-2", { status: "inactive" })],
    agentActivities: {
      "agent-1": { activity: "offline", activityDetail: "Stopped", detailKind: "stopped" },
      "agent-2": { activity: "idle", activityDetail: "", detailKind: "none" },
    },
    agentActivityTraceJoins: {
      "agent-1": { clientEventId: "trace-1" },
      "agent-2": { clientEventId: "trace-2" },
    },
    agentActivityObservedAt: { "agent-1": 1, "agent-2": 2 },
    activityLogs: {
      "agent-1": [{ timestamp: 1 }],
      "agent-2": [{ timestamp: 2 }],
    },
    trajectoryLogs: {
      "agent-1": [{ timestamp: 1 }],
      "agent-2": [{ timestamp: 2 }],
    },
  } as never);
}

function installResetPostOracle(mode: "restart" | "session" | "full") {
  let calls = 0;
  api.post = (async (url: string, body?: unknown) => {
    calls += 1;
    assert.equal(url, "/agents/agent-1/reset");
    assert.deepEqual(body, { mode });
    return { data: {} };
  }) as typeof api.post;
  return () => calls;
}

function assertStartingProjection() {
  const state = useAgentStore.getState();
  assert.equal(state.agents.find((item) => item.id === "agent-1")?.status, "active");
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "",
    detailKind: "starting",
  });
  assert.equal(state.agentActivityTraceJoins["agent-1"], undefined);
  assert.ok((state.agentActivityObservedAt["agent-1"] ?? 0) > 2);

  assert.equal(state.agents.find((item) => item.id === "agent-2")?.status, "inactive");
  assert.deepEqual(state.agentActivities["agent-2"], {
    activity: "idle",
    activityDetail: "",
    detailKind: "none",
  });
}

afterEach(() => {
  api.post = originalPost;
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    activityLogs: {},
    trajectoryLogs: {},
  } as never);
});

test("restart posts the reset and immediately projects starting without clearing the session or logs", async () => {
  seedStore();
  const callCount = installResetPostOracle("restart");

  await useAgentStore.getState().resetAgent("agent-1", "restart");

  assert.equal(callCount(), 1);
  assertStartingProjection();
  const state = useAgentStore.getState();
  assert.equal(state.agents.find((item) => item.id === "agent-1")?.sessionId, "agent-1-session");
  assert.deepEqual(state.activityLogs["agent-1"], [{ timestamp: 1 }]);
  assert.deepEqual(state.trajectoryLogs["agent-1"], [{ timestamp: 1 }]);
});

for (const mode of ["session", "full"] as const) {
  test(`${mode} reset clears only the target runtime history and session`, async () => {
    seedStore();
    const callCount = installResetPostOracle(mode);

    await useAgentStore.getState().resetAgent("agent-1", mode);

    assert.equal(callCount(), 1);
    assertStartingProjection();
    const state = useAgentStore.getState();
    assert.equal(state.agents.find((item) => item.id === "agent-1")?.sessionId, null);
    assert.equal(state.activityLogs["agent-1"], undefined);
    assert.equal(state.trajectoryLogs["agent-1"], undefined);
    assert.deepEqual(state.activityLogs["agent-2"], [{ timestamp: 2 }]);
    assert.deepEqual(state.trajectoryLogs["agent-2"], [{ timestamp: 2 }]);
  });
}

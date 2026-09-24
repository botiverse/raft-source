import assert from "node:assert/strict";
import test from "node:test";
import {
  registerActivityTrajectoryLiveReload,
  registerActivityTrajectoryReconnectReload,
} from "../src/utils/activityTrajectoryRecovery.js";
import type { AgentActivityReloadPayload } from "../src/utils/activityTrajectoryRecovery";

class FakeSocket {
  private readonly connectListeners = new Set<() => void>();
  private readonly activityListeners = new Set<(payload: AgentActivityReloadPayload) => void>();

  on(event: "connect", listener: () => void): void;
  on(event: "agent:activity", listener: (payload: AgentActivityReloadPayload) => void): void;
  on(event: "connect" | "agent:activity", listener: (() => void) | ((payload: AgentActivityReloadPayload) => void)) {
    if (event === "connect") {
      this.connectListeners.add(listener as () => void);
      return;
    }
    this.activityListeners.add(listener as (payload: AgentActivityReloadPayload) => void);
  }

  off(event: "connect", listener: () => void): void;
  off(event: "agent:activity", listener: (payload: AgentActivityReloadPayload) => void): void;
  off(event: "connect" | "agent:activity", listener: (() => void) | ((payload: AgentActivityReloadPayload) => void)) {
    if (event === "connect") {
      this.connectListeners.delete(listener as () => void);
      return;
    }
    this.activityListeners.delete(listener as (payload: AgentActivityReloadPayload) => void);
  }

  emitConnect() {
    for (const listener of this.connectListeners) {
      listener();
    }
  }

  emitAgentActivity(payload: AgentActivityReloadPayload) {
    for (const listener of this.activityListeners) {
      listener(payload);
    }
  }
}

test("reconnect reloads the durable trajectory log for the active agent activity tab", async () => {
  const socket = new FakeSocket();
  const calls: Array<{ agentId: string; limit?: number }> = [];

  const cleanup = registerActivityTrajectoryReconnectReload({
    socket,
    agentId: "agent-1",
    limit: 75,
    loadTrajectoryLog: async (agentId, limit) => {
      calls.push({ agentId, limit });
    },
    debounceMs: 5,
  });

  socket.emitConnect();
  socket.emitConnect();
  socket.emitConnect();

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, [{ agentId: "agent-1", limit: 75 }]);

  cleanup();
});

test("first connect is ignored so mount + initial socket connect does not double-fetch", async () => {
  const socket = new FakeSocket();
  const calls: string[] = [];

  const cleanup = registerActivityTrajectoryReconnectReload({
    socket,
    agentId: "agent-3",
    loadTrajectoryLog: async (agentId) => {
      calls.push(agentId);
    },
    debounceMs: 5,
  });

  socket.emitConnect();
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, []);

  cleanup();
});

test("cleanup detaches the reconnect reload listener", async () => {
  const socket = new FakeSocket();
  const calls: string[] = [];

  const cleanup = registerActivityTrajectoryReconnectReload({
    socket,
    agentId: "agent-2",
    loadTrajectoryLog: async (agentId) => {
      calls.push(agentId);
    },
    debounceMs: 5,
  });

  cleanup();
  socket.emitConnect();

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, []);
});

test("live agent activity without trajectory entries reloads the active activity tab", async () => {
  const socket = new FakeSocket();
  const calls: Array<{ agentId: string; limit?: number }> = [];

  const cleanup = registerActivityTrajectoryLiveReload({
    socket,
    agentId: "agent-live",
    limit: 60,
    loadTrajectoryLog: async (agentId, limit) => {
      calls.push({ agentId, limit });
    },
    debounceMs: 5,
  });

  socket.emitAgentActivity({ agentId: "agent-live", entries: [] });
  socket.emitAgentActivity({ agentId: "agent-live" });
  socket.emitAgentActivity({ agentId: "other-agent" });

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, [{ agentId: "agent-live", limit: 60 }]);

  cleanup();
});

test("live agent activity reload ignores frames already handled by append and refresh-only frames", async () => {
  const socket = new FakeSocket();
  const calls: string[] = [];

  const cleanup = registerActivityTrajectoryLiveReload({
    socket,
    agentId: "agent-live",
    loadTrajectoryLog: async (agentId) => {
      calls.push(agentId);
    },
    debounceMs: 5,
  });

  socket.emitAgentActivity({
    agentId: "agent-live",
    entries: [{ kind: "text", text: "already appended by socketBridge" }],
  });
  socket.emitAgentActivity({ agentId: "agent-live", isHeartbeat: true });
  socket.emitAgentActivity({ agentId: "agent-live", isRefreshOnly: true });

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, []);

  cleanup();
});

test("cleanup detaches the live activity reload listener", async () => {
  const socket = new FakeSocket();
  const calls: string[] = [];

  const cleanup = registerActivityTrajectoryLiveReload({
    socket,
    agentId: "agent-live",
    loadTrajectoryLog: async (agentId) => {
      calls.push(agentId);
    },
    debounceMs: 5,
  });

  cleanup();
  socket.emitAgentActivity({ agentId: "agent-live" });

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(calls, []);
});

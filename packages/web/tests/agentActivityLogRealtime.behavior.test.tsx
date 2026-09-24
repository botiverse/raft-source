import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, waitFor } from "@testing-library/react";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import AgentActivityLog from "../src/components/agent/AgentActivityLog";
import { getSocket, resetSocket } from "../src/api/socket";
import { useAgentStore } from "../src/store/agentStore";

const defaultLoadTrajectoryLog = useAgentStore.getState().loadTrajectoryLog;

afterEach(() => {
  cleanup();
  resetSocket();
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    activityLogs: {},
    trajectoryLogs: {},
    loadTrajectoryLog: defaultLoadTrajectoryLog,
  } as never);
});

test("mounted AgentActivityLog reloads durable activity when a live frame has no trajectory entries", async () => {
  const calls: string[] = [];
  useAgentStore.setState({
    trajectoryLogs: {},
    loadTrajectoryLog: async (agentId: string) => {
      calls.push(agentId);
    },
  } as never);

  render(
    <TestIntlProvider>
      <AgentActivityLog agentId="agent-live" />
    </TestIntlProvider>,
  );

  await waitFor(() => assert.deepEqual(calls, ["agent-live"]));
  calls.length = 0;

  const socket = getSocket();
  const listeners = socket.listeners("agent:activity") as Array<(payload: unknown) => void>;
  assert.ok(listeners.length > 0, "AgentActivityLog must subscribe to live agent activity frames");

  for (const listener of listeners) {
    listener({ agentId: "agent-live" });
  }

  await waitFor(() => assert.deepEqual(calls, ["agent-live"]));
});

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
} from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "agent-one",
    displayName: "Agent One",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    runtimeProfile: null,
    creatorType: "user",
    creatorId: "human-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "machine-1",
    name: "Machine One",
    description: null,
    status: "online",
    statusVersion: 10,
    apiKeyPrefix: null,
    runtimes: ["claude"],
    hostname: null,
    os: null,
    daemonVersion: null,
    computerVersion: null,
    lastHeartbeat: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeSocket(): MainLayoutSocketBridgeSocket {
  return {
    connected: true,
    emit: () => undefined,
    on: () => undefined,
    off: () => undefined,
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
}

function installCrypto(): void {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => "client-event-status-truth",
      getRandomValues: (bytes: Uint8Array) => bytes,
    },
  });
}

function getBinding(event: "agent:activity" | "machine:status") {
  const bindings = buildMainLayoutSocketBindings(
    makeSocket(),
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const binding = bindings.find((item) => item.event === event);
  assert.ok(binding);
  return binding.handler;
}

function resetStores() {
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    activityLogs: {},
    trajectoryLogs: {},
    loading: false,
    loadAgents: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [makeMachine()],
    latestDaemonVersion: null,
    latestComputerVersion: null,
    loading: false,
    computerOperationProgress: {},
    loadMachines: async () => undefined,
  } as never);
}

beforeEach(() => {
  installCrypto();
  resetStores();
});

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
});

test("status K1/K3 tygg 039ce7f1: stale machine offline does not override newer agent activity", () => {
  const agentActivity = getBinding("agent:activity");
  const machineStatus = getBinding("machine:status");
  useMachineStore.setState({ machines: [makeMachine({ statusVersion: 12 })] });

  agentActivity({
    agentId: "agent-1",
    activity: "working",
    detail: "Running command",
    serverSeq: 12,
    timestamp: 1200,
  });
  machineStatus({ machineId: "machine-1", status: "offline", statusVersion: 11 });

  assert.equal(useMachineStore.getState().machines[0]?.status, "online");
  assert.equal(useAgentStore.getState().agentActivities["agent-1"]?.activity, "working");
});

test("status K3 xxchan 8890d027: machine offline then agent working resolves to working", () => {
  const machineStatus = getBinding("machine:status");
  const agentActivity = getBinding("agent:activity");

  machineStatus({ machineId: "machine-1", status: "offline", statusVersion: 11 });
  agentActivity({
    agentId: "agent-1",
    activity: "working",
    detail: "Recovered",
    serverSeq: 13,
    timestamp: 1300,
  });

  assert.equal(useMachineStore.getState().machines[0]?.status, "offline");
  assert.equal(useAgentStore.getState().agentActivities["agent-1"]?.activity, "working");
  assert.equal(useAgentStore.getState().agentActivities["agent-1"]?.activityDetail, "Recovered");
});

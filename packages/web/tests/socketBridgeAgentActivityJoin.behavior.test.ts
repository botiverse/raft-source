import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
} from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useLiveAgentActivityStore } from "../src/store/liveAgentActivityStore";
import {
  __resetAuthTraceForTest,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

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

function resetAgentStore() {
  useLiveAgentActivityStore.getState().clear();
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
  } as never);
}

function installCrypto(value: Pick<Crypto, "getRandomValues"> & { randomUUID?: () => string }): void {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
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

function agentActivityHandler() {
  const bindings = buildMainLayoutSocketBindings(
    makeSocket(),
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const binding = bindings.find((item) => item.event === "agent:activity");
  assert.ok(binding);
  return binding.handler;
}

function captureWebTraceBatches() {
  const values = new Map<string, string>();
  const batches: Array<{ records?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-1");
  setAuthTracePrincipalIdGetter(() => "user-1");
  localStorage.setItem("slock_access_token", "token-1");
  setAuthTraceFetchForTest(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/scope-attestation")) {
      return new Response(JSON.stringify({ attestation: "attestation-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    batches.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  });
  return batches;
}

afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else Reflect.deleteProperty(globalThis, "crypto");
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  __resetAuthTraceForTest();
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTracePrincipalIdGetter(() => undefined);
  resetAgentStore();
});

test("agent:activity socket handler emits a bounded receipt and stores its opaque clientEventId only as trace join", async () => {
  resetAgentStore();
  const batches = captureWebTraceBatches();
  installCrypto({
    randomUUID: () => "client-event-random-1",
    getRandomValues: (bytes) => bytes,
  });

  agentActivityHandler()({
    agentId: "agent-1",
    activity: "working",
    detail: "Running command",
    serverSeq: 1,
    timestamp: 100,
    launchId: "launch-1",
    clientSeq: 7,
    probeId: "probe-1",
    entries: [{ kind: "status", activity: "working", detail: "Running command" }],
  });
  await flushAuthTraces();

  const state = useAgentStore.getState();
  assert.deepEqual(state.agentActivityTraceJoins["agent-1"], {
    clientEventId: "client-event-random-1",
  });
  assert.equal("clientEventId" in (state.activityLogs["agent-1"]?.[0] as Record<string, unknown>), false);
  assert.equal("clientEventId" in (state.trajectoryLogs["agent-1"]?.[0] as Record<string, unknown>), false);
  assert.equal(state.activityLogs["agent-1"]?.[0]?.launchId, "launch-1");
  assert.equal(state.activityLogs["agent-1"]?.[0]?.clientSeq, 7);
  assert.equal(state.activityLogs["agent-1"]?.[0]?.probeId, "probe-1");
  assert.equal(useLiveAgentActivityStore.getState().items[0]?.activity, "working");
  assert.equal(useLiveAgentActivityStore.getState().items[0]?.text, "Running command");

  const receipt = batches
    .flatMap((batch) => batch.records ?? [])
    .find((record) => record.name === "slock.agent_activity.socket_received");
  assert.ok(receipt, "the real socket handler must emit the socket receipt trace");
  assert.deepEqual(receipt.attrs?.join, { clientEventId: "client-event-random-1" });
  for (const rawKey of ["agentId", "detail", "launchId", "probeId", "client_event_id"]) {
    assert.equal(rawKey in (receipt.attrs ?? {}), false, `${rawKey} must not leave the Web trace boundary`);
  }
});

test("agent:activity socket handler falls back to opaque UUIDv4 from getRandomValues", () => {
  resetAgentStore();
  installCrypto({
    getRandomValues: (bytes) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    },
  });

  agentActivityHandler()({
    agentId: "agent-1",
    activity: "thinking",
    detail: "Planning",
    serverSeq: 2,
    timestamp: 200,
  });

  assert.deepEqual(useAgentStore.getState().agentActivityTraceJoins["agent-1"], {
    clientEventId: "00010203-0405-4607-8809-0a0b0c0d0e0f",
  });
});

test("agent:activity socket handler forwards heartbeat provenance without adding a second log row", () => {
  resetAgentStore();
  installCrypto({
    randomUUID: () => "client-event-heartbeat",
    getRandomValues: (bytes) => bytes,
  });
  const handler = agentActivityHandler();

  handler({
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    serverSeq: 1,
    timestamp: 1_000,
  });
  handler({
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    serverSeq: 2,
    timestamp: 61_000,
    isHeartbeat: true,
  });

  const state = useAgentStore.getState();
  assert.equal(state.activityLogs["agent-1"]?.length, 1);
  assert.equal(state.agentActivityObservedAt["agent-1"], 61_000);
  assert.equal(state.agentActivitySeq["agent-1"], 2);
});

test("agent:activity socket handler forwards probe refresh provenance without adding a second log row", () => {
  resetAgentStore();
  installCrypto({
    randomUUID: () => "client-event-probe-refresh",
    getRandomValues: (bytes) => bytes,
  });
  const handler = agentActivityHandler();

  handler({
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    serverSeq: 1,
    timestamp: 1_000,
  });
  handler({
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    serverSeq: 2,
    timestamp: 21_000,
    probeId: "probe-1",
    isRefreshOnly: true,
  });

  const state = useAgentStore.getState();
  assert.equal(state.activityLogs["agent-1"]?.length, 1);
  assert.equal(state.agentActivityObservedAt["agent-1"], 21_000);
  assert.equal(state.agentActivitySeq["agent-1"], 2);
});

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  assertSurfaceProducerFactLineage,
  stripSurfaceProducerFactLineage,
} from "@botiverse/raft-shared";
import api from "../src/api/client.js";
import { selectAgentDisplayState, useAgentStore } from "../src/store/agentStore.js";
import type { Agent, TrajectoryEntry } from "../src/store/agentStore.js";
import { useServerStore } from "../src/store/serverStore.js";
import type { Server } from "../src/store/serverStore.js";
import {
  __resetStateViolationCoalescerForTest,
  __setStateViolationEmitterForTest,
} from "../src/utils/stateViolationTrace.js";
import {
  __setStateTransitionEmitterForTest,
} from "../src/utils/stateTransitionTrace.js";
import {
  __resetAuthTraceForTest,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace.js";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server 1",
    slug: "server-1",
    ownerId: "human-1",
    onboardingAgentId: null,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: new Date(0).toISOString(),
  };
}

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

function resetStores() {
  useServerStore.setState({
    current: makeServer(),
    serverEpoch: 1,
  });
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    trajectoryHydrateGeneration: 0,
    loading: false,
    activityLogs: {},
    trajectoryLogs: {},
  });
}

function captureStateViolations() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __resetStateViolationCoalescerForTest();
  __setStateViolationEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

function captureStateTransitions() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setStateTransitionEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
  __setStateTransitionEmitterForTest(null);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  __resetAuthTraceForTest();
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTracePrincipalIdGetter(() => undefined);
  resetStores();
});

test("agent socket activity transition carries clientEventId join without persisting it to logs", () => {
  resetStores();
  const records = captureStateTransitions();
  const traceJoin = { clientEventId: "client-event-agent-1" };

  useAgentStore.getState().updateActivity(
    "agent-1",
    "working",
    "Running command",
    10,
    500,
    { launchId: "launch-1", clientSeq: 7, probeId: "probe-1" },
    "working",
    "running_command",
    traceJoin,
  );

  __setStateTransitionEmitterForTest(null);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, "slock.state.transition");
  assert.deepEqual(records[0].attrs.join, traceJoin);
  assert.deepEqual(records[0].attrs.key, {
    domain: "agents",
    event: "patch:socket-activity",
    outcome: "applied",
    entityId: "agent-1",
  });
  assert.deepEqual(records[0].attrs.meta, {
    outcomeDetail: "applied",
    touched: 1,
    reconcileSuggested: false,
    seq: 10,
    timestamp: 500,
  });
  assert.equal("clientEventId" in (records[0].attrs.key as Record<string, unknown>), false);
  assert.equal("clientEventId" in (records[0].attrs.meta as Record<string, unknown>), false);

  const state = useAgentStore.getState();
  assert.deepEqual(state.agentActivityTraceJoins["agent-1"], traceJoin);
  const logEntry = state.activityLogs["agent-1"]?.[0] as Record<string, unknown> | undefined;
  assert.ok(logEntry);
  assert.equal("clientEventId" in logEntry, false);
  assert.equal(logEntry.launchId, "launch-1");
  assert.equal(logEntry.clientSeq, 7);
  assert.equal(logEntry.probeId, "probe-1");
});

test("heartbeat socket activity refreshes current state without appending activity history", () => {
  resetStores();

  useAgentStore.getState().updateActivity(
    "agent-1",
    "working",
    "Message received",
    1,
    1_000,
    { launchId: "launch-1", clientSeq: 1 },
    "working",
    "message_received",
  );
  useAgentStore.getState().updateActivity(
    "agent-1",
    "working",
    "Message received",
    2,
    61_000,
    { launchId: "launch-1", clientSeq: 2 },
    "working",
    "message_received",
    undefined,
    true,
  );

  const state = useAgentStore.getState();
  assert.equal(state.activityLogs["agent-1"]?.length, 1);
  assert.equal(state.activityLogs["agent-1"]?.[0]?.timestamp, 1_000);
  assert.equal(state.agentActivityObservedAt["agent-1"], 61_000);
  assert.equal(state.agentActivitySeq["agent-1"], 2);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Message received",
    detailKind: "message_received",
  });
});

test("probe socket activity refreshes current state without appending activity history", () => {
  resetStores();

  useAgentStore.getState().updateActivity(
    "agent-1",
    "working",
    "Message received",
    1,
    1_000,
    { launchId: "launch-1", clientSeq: 1 },
    "working",
    "message_received",
  );
  useAgentStore.getState().updateActivity(
    "agent-1",
    "working",
    "Message received",
    2,
    21_000,
    { launchId: "launch-1", clientSeq: 2, probeId: "probe-1" },
    "working",
    "message_received",
    undefined,
    false,
    true,
  );

  const state = useAgentStore.getState();
  assert.equal(state.activityLogs["agent-1"]?.length, 1);
  assert.equal(state.activityLogs["agent-1"]?.[0]?.timestamp, 1_000);
  assert.equal(state.agentActivityObservedAt["agent-1"], 21_000);
  assert.equal(state.agentActivitySeq["agent-1"], 2);
  assert.deepEqual(state.agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Message received",
    detailKind: "message_received",
  });
});

test("agent state transition trace classifies conflict, logged, stale, and invalid outcomes", async () => {
  resetStores();
  const records = captureStateTransitions();
  const webTraceBatches = captureWebTraceBatches();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return { data: [{ ...makeAgent(), activity: "working", activityDetail: "Running command" }] };
  }) as typeof api.get;

  useAgentStore.getState().updateActivity("agent-1", "working", "Running command", 10, 500);
  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "online", detail: "Idle" }],
    501,
    undefined,
    10,
  );
  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "thinking", detail: "Legacy frame" }],
    502,
  );
  useAgentStore.getState().updateActivity("agent-1", "thinking", "Stale event", 9, 503);
  useAgentStore.getState().updateActivity("agent-1", "bad-activity" as never, "", 11, 504);

  assert.deepEqual(records.map((record) => [record.attrs.key, record.attrs.meta]), [
    [
      { domain: "agents", event: "patch:socket-activity", outcome: "applied", entityId: "agent-1" },
      { outcomeDetail: "applied", touched: 1, reconcileSuggested: false, seq: 10, timestamp: 500 },
    ],
    [
      { domain: "agents", event: "patch:trajectory-append", outcome: "conflict", entityId: "agent-1" },
      { outcomeDetail: "producer_seq_conflict", touched: 1, reconcileSuggested: true, seq: 10, timestamp: 501 },
    ],
    [
      { domain: "agents", event: "patch:trajectory-append", outcome: "applied", entityId: "agent-1" },
      { outcomeDetail: "logged", touched: 1, reconcileSuggested: true, timestamp: 502 },
    ],
    [
      { domain: "agents", event: "patch:socket-activity", outcome: "noop", entityId: "agent-1" },
      { outcomeDetail: "stale_server_seq", touched: 0, reconcileSuggested: false, seq: 9, timestamp: 503 },
    ],
    [
      { domain: "agents", event: "patch:socket-activity", outcome: "noop", entityId: "agent-1" },
      { outcomeDetail: "invalid_activity", touched: 0, reconcileSuggested: false, seq: 11, timestamp: 504 },
    ],
  ]);
  await flushAuthTraces();
  const storeDecisions = webTraceBatches
    .flatMap((batch) => batch.records ?? [])
    .filter((record) => record.name === "slock.agent_activity.store_decision");
  assert.deepEqual(
    storeDecisions.map((record) => record.attrs?.outcome),
    ["applied", "stale_server_seq", "invalid_activity"],
    "the real agent store must emit a bounded decision for every accepted or rejected socket activity",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("agent lifecycle overrides clear stale clientEventId trace joins", async () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "working", activityDetail: "Running tests", detailKind: "other" },
    },
    agentActivityTraceJoins: { "agent-1": { clientEventId: "client-event-stale" } },
    agentActivityVersions: { "agent-1": 1 },
  });
  api.post = (async (url: string) => {
    assert.equal(url, "/agents/agent-1/stop");
    return { data: {} };
  }) as typeof api.post;

  await useAgentStore.getState().stopAgent("agent-1");

  assert.equal(useAgentStore.getState().agentActivityTraceJoins["agent-1"], undefined);
  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "offline",
    activityDetail: "Stopped",
    detailKind: "stopped",
  });
});

test("agent lifecycle preserve trace-join map reference when clearing absent join", async () => {
  resetStores();
  const traceJoins = { "other-agent": { clientEventId: "client-event-other" } };
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "working", activityDetail: "Running tests", detailKind: "other" },
    },
    agentActivityTraceJoins: traceJoins,
    agentActivityVersions: { "agent-1": 1 },
  });
  api.post = (async (url: string) => {
    assert.equal(url, "/agents/agent-1/stop");
    return { data: {} };
  }) as typeof api.post;

  await useAgentStore.getState().stopAgent("agent-1");

  assert.equal(useAgentStore.getState().agentActivityTraceJoins, traceJoins);
});

test("in-flight REST agent snapshot does not clobber newer socket activity", async () => {
  resetStores();
  const response = deferred<{ data: Array<Agent & { activity?: string; activityDetail?: string }> }>();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return response.promise;
  }) as typeof api.get;

  const loadPromise = useAgentStore.getState().loadAgents();

  // This push represents the daemon moving from idle online to real work
  // while the reconnect snapshot is still in flight.
  const traceJoin = { clientEventId: "client-event-live" };
  useAgentStore.getState().updateActivity("agent-1", "working", "Compiling prompt", 1, undefined, undefined, undefined, undefined, traceJoin);
  useAgentStore.getState().updateActivity("agent-2", "thinking", "No join", 1);

  response.resolve({
    data: [
      {
        ...makeAgent(),
        activity: "online",
        activityDetail: "",
      },
      {
        ...makeAgent({ id: "agent-2", name: "agent-two", displayName: "Agent Two" }),
        activity: "online",
        activityDetail: "",
      },
    ],
  });
  await loadPromise;

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Compiling prompt",
    detailKind: "other",
  });
  assert.deepEqual(useAgentStore.getState().agentActivityTraceJoins["agent-1"], traceJoin);
  assert.deepEqual(Object.keys(useAgentStore.getState().agentActivityTraceJoins), ["agent-1"]);
});

test("in-flight REST agent snapshot preserves agents created after the request started", async () => {
  resetStores();
  useAgentStore.setState({ agents: [makeAgent()] });
  const response = deferred<{ data: Array<Agent & { activity?: string; activityDetail?: string }> }>();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return response.promise;
  }) as typeof api.get;
  api.post = (async (url: string) => {
    assert.equal(url, "/agents");
    return {
      data: {
        ...makeAgent({ id: "agent-2", name: "agent-two", displayName: "Agent Two" }),
        activity: "online",
        activityDetail: "",
      },
    };
  }) as typeof api.post;

  const loadPromise = useAgentStore.getState().loadAgents();
  await useAgentStore.getState().createAgent("agent-two");

  response.resolve({
    data: [
      {
        ...makeAgent(),
        activity: "online",
        activityDetail: "",
      },
    ],
  });
  await loadPromise;

  assert.deepEqual(
    useAgentStore.getState().agents.map((agent) => agent.id),
    ["agent-1", "agent-2"],
  );
});

test("REST agent snapshot seeds activity when no newer local push arrived", async () => {
  resetStores();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return {
      data: [
        {
          ...makeAgent(),
          activity: "thinking",
          activityDetail: "Reading context",
        },
      ],
    };
  }) as typeof api.get;

  await useAgentStore.getState().loadAgents();

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "Reading context",
    detailKind: "other",
  });
});

test("invalid partial agent activity push is ignored instead of mapped to offline", () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "working", activityDetail: "Running tests", detailKind: "other" },
    },
    agentActivityVersions: { "agent-1": 1 },
  });

  useAgentStore.getState().updateActivity("agent-1", undefined as unknown as string, "", 2);

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running tests",
    detailKind: "other",
  });
  assert.equal(useAgentStore.getState().agentActivitySeq["agent-1"], undefined);
});

test("activity update without detail keeps an empty bounded detail string", () => {
  resetStores();

  useAgentStore.getState().updateActivity("agent-1", "thinking");

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "",
    detailKind: "other",
  });
});

test("re-baseline accepts a lower serverSeq from the new epoch", () => {
  resetStores();
  useAgentStore.getState().updateActivity("agent-1", "working", "Old epoch", 12);

  useAgentStore.getState().resetActivitySeq();
  useAgentStore.getState().updateActivity("agent-1", "thinking", "New epoch", 1);

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "New epoch",
    detailKind: "other",
  });
  assert.equal(useAgentStore.getState().agentActivitySeq["agent-1"], 1);
});

test("late old-epoch trajectory hydrate is dropped after re-baseline", async () => {
  resetStores();
  const response = deferred<{ data: Array<{ timestamp: number; serverSeq: number; entry: TrajectoryEntry }> }>();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents/agent-1/activity-log");
    return response.promise;
  }) as typeof api.get;

  const loadPromise = useAgentStore.getState().loadTrajectoryLog("agent-1");

  useAgentStore.getState().resetActivitySeq();
  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "thinking", detail: "New epoch" }],
    200,
    undefined,
    1,
  );

  response.resolve({
    data: [
      {
        timestamp: 100,
        serverSeq: 12,
        entry: { kind: "status", activity: "online", detail: "Old epoch hydrate" },
      },
    ],
  });
  await loadPromise;

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "New epoch",
    detailKind: "other",
  });
  assert.equal(useAgentStore.getState().agentActivitySeq["agent-1"], 1);
  assert.deepEqual(useAgentStore.getState().getTrajectoryLog("agent-1"), [
    {
      timestamp: 200,
      serverSeq: 1,
      entry: { kind: "status", activity: "thinking", detail: "New epoch" },
    },
  ]);
});

test("producer seq conflict emits state violation with arrival-sensitive fields in meta", async () => {
  resetStores();
  const records = captureStateViolations();
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return {
      data: [
        {
          ...makeAgent(),
          activity: "working",
          activityDetail: "Running command",
        },
      ],
    };
  }) as typeof api.get;

  useAgentStore.getState().updateActivity("agent-1", "working", "Running command", 10, 500);
  const traceJoin = { clientEventId: "client-event-conflict-1" };
  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "online", detail: "Idle" }],
    100,
    undefined,
    10,
    traceJoin,
  );

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running command",
    detailKind: "other",
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "slock.state.violation");
  assert.deepEqual(records[0].attrs, {
    key: {
      domain: "agents",
      entityId: "agent-1",
      violationKind: "producer_seq_conflict",
      epoch: 0,
      same_activity: false,
      same_detail_kind: true,
      same_detail_presence: true,
      same_detail_bucket: true,
    },
    meta: {
      count: 1,
      event: "patch:trajectory-append",
      outcomeDetail: "producer_seq_conflict",
      serverSeq: 10,
      timestamp: 100,
      currentActivity: "working",
      projectedActivity: "online",
      currentDetailKind: "other",
      projectedDetailKind: "other",
    },
    join: traceJoin,
  });
  assert.equal("serverSeq" in (records[0].attrs.key as Record<string, unknown>), false);
  assert.equal("timestamp" in (records[0].attrs.key as Record<string, unknown>), false);
  await Promise.resolve();
  await Promise.resolve();
});

test("live agent session push updates diagnostic session id without a REST reload", () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent({ sessionId: null })],
  });

  useAgentStore.getState().updateAgentSession("agent-1", "session-live");

  assert.equal(useAgentStore.getState().agents[0]?.sessionId, "session-live");
});

test("session reset clears diagnostic session id locally until the next live session", async () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent({ sessionId: "session-old" })],
  });
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/agents/agent-1/reset");
    assert.deepEqual(body, { mode: "session" });
    return { data: {} };
  }) as typeof api.post;

  await useAgentStore.getState().resetAgent("agent-1", "session");

  assert.equal(useAgentStore.getState().agents[0]?.sessionId, null);
});

test("deterministic reconnect order fuzz keeps final activity at latest valid push", async () => {
  resetStores();

  const cases: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [
    {
      name: "snapshot then push",
      run: async () => {
        api.get = (async () => ({
          data: [{ ...makeAgent(), activity: "online", activityDetail: "" }],
        })) as typeof api.get;
        await useAgentStore.getState().loadAgents();
        useAgentStore.getState().updateActivity("agent-1", "working", "After snapshot", 1);
      },
    },
    {
      name: "push while snapshot in flight",
      run: async () => {
        const response = deferred<{ data: Array<Agent & { activity?: string; activityDetail?: string }> }>();
        api.get = (async () => response.promise) as typeof api.get;
        const loadPromise = useAgentStore.getState().loadAgents();
        useAgentStore.getState().updateActivity("agent-1", "working", "During snapshot", 1);
        response.resolve({ data: [{ ...makeAgent(), activity: "online", activityDetail: "" }] });
        await loadPromise;
      },
    },
  ];

  for (const scenario of cases) {
    resetStores();
    await scenario.run();
    assert.equal(
      useAgentStore.getState().agentActivities["agent-1"]?.activity,
      "working",
      scenario.name,
    );
  }
});

test("trajectory tool_start updates the live status badge state", () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "online", activityDetail: "", detailKind: "none" },
    },
    agentActivityObservedAt: { "agent-1": 100 },
    agentActivityVersions: { "agent-1": 1 },
  });

  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "tool_start", toolName: "shell", toolInput: "pnpm test" }],
    200,
    undefined,
    1,
  );

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running command…",
    detailKind: "other",
  });
  assert.deepEqual(selectAgentDisplayState(useAgentStore.getState(), "agent-1"), {
    activity: "working",
    activityDetail: "Running command…",
    activityDetailKind: "other",
    activityText: "Running command…",
    isOnline: true,
  });
});

test("non-comparable trajectory reconcile suggestions coalesce into one agent snapshot pull", async () => {
  resetStores();
  let fetchCount = 0;
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    fetchCount += 1;
    return {
      data: [
        {
          ...makeAgent(),
          activity: "online",
          activityDetail: "",
        },
      ],
    };
  }) as typeof api.get;

  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "working", detail: "legacy one" }],
    200,
  );
  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "thinking", detail: "legacy two" }],
    201,
  );

  assert.equal(useAgentStore.getState().agentActivities["agent-1"], undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fetchCount, 1);
  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "online",
    activityDetail: "",
    detailKind: "other",
  });
});

test("live trajectory append preserves producer fact lineage for UI and feedback readouts", () => {
  resetStores();
  const entries: TrajectoryEntry[] = [
    { kind: "thinking", producerFactId: "fact-live-readout", text: "checking lineage" },
    { kind: "slock_action", producerFactId: "fact-live-readout", title: "Send held", text: "new messages: 1" },
  ];

  useAgentStore.getState().appendTrajectory("agent-1", entries, 250);

  const liveLog = useAgentStore.getState().getTrajectoryLog("agent-1");
  assert.deepEqual(liveLog, entries.map((entry) => ({
    timestamp: 250,
    entry,
  })));
  assertSurfaceProducerFactLineage(liveLog, ["fact-live-readout"], "web live trajectory readout");
  assert.throws(
    () => assertSurfaceProducerFactLineage(
      stripSurfaceProducerFactLineage(liveLog),
      ["fact-live-readout"],
      "web live trajectory readout stripped",
    ),
    /producerFactId mismatch/,
  );
});

test("durable trajectory reload preserves producer fact lineage for hydrated UI readouts", async () => {
  resetStores();
  const entry: TrajectoryEntry = {
    kind: "slock_action",
    producerFactId: "fact-hydrated-readout",
    title: "Task claim held",
    text: "new messages: 2",
  };
  api.get = (async (url: string) => {
    assert.equal(url, "/agents/agent-1/activity-log");
    return {
      data: [{ timestamp: 275, entry }],
    };
  }) as typeof api.get;

  await useAgentStore.getState().loadTrajectoryLog("agent-1");

  const hydratedLog = useAgentStore.getState().getTrajectoryLog("agent-1");
  assert.deepEqual(hydratedLog, [{ timestamp: 275, entry }]);
  assertSurfaceProducerFactLineage(hydratedLog, ["fact-hydrated-readout"], "web hydrated trajectory readout");
});

test("older trajectory replay does not clobber a newer non-idle activity", () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "thinking", activityDetail: "Planning fix", detailKind: "other" },
    },
    agentActivityObservedAt: { "agent-1": 100 },
    agentActivityVersions: { "agent-1": 1 },
    agentActivitySeq: { "agent-1": 12 },
  });

  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "online", detail: "" }],
    999,
    undefined,
    11,
  );

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "thinking",
    activityDetail: "Planning fix",
    detailKind: "other",
  });
});

test("latest idle status trajectory frame maps to the current online display state", () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "working", activityDetail: "Running tests", detailKind: "running_command" },
    },
    agentActivityObservedAt: { "agent-1": 999 },
    agentActivityVersions: { "agent-1": 1 },
    agentActivitySeq: { "agent-1": 12 },
  });

  useAgentStore.getState().appendTrajectory(
    "agent-1",
    [{ kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "idle" }],
    100,
    undefined,
    13,
  );

  assert.deepEqual(selectAgentDisplayState(useAgentStore.getState(), "agent-1"), {
    activity: "online",
    activityDetail: "",
    activityDetailKind: "idle",
    activityText: "Online",
    isOnline: true,
  });
});

test("durable trajectory reload repairs stale idle badge state", async () => {
  resetStores();
  useAgentStore.setState({
    agents: [makeAgent()],
    agentActivities: {
      "agent-1": { activity: "online", activityDetail: "", detailKind: "none" },
    },
    agentActivityObservedAt: { "agent-1": 300 },
    agentActivityVersions: { "agent-1": 1 },
    agentActivitySeq: { "agent-1": 12 },
  });
  api.get = (async (url: string) => {
    assert.equal(url, "/agents/agent-1/activity-log");
    return {
      data: [
        {
          timestamp: 200,
          serverSeq: 13,
          entry: { kind: "tool_start", toolName: "Bash", toolInput: "pnpm test" },
        },
      ],
    };
  }) as typeof api.get;

  await useAgentStore.getState().loadTrajectoryLog("agent-1");

  assert.deepEqual(useAgentStore.getState().agentActivities["agent-1"], {
    activity: "working",
    activityDetail: "Running command…",
    detailKind: "other",
  });
  assert.deepEqual(selectAgentDisplayState(useAgentStore.getState(), "agent-1"), {
    activity: "working",
    activityDetail: "Running command…",
    activityDetailKind: "other",
    activityText: "Running command…",
    isOnline: true,
  });
});

test("agent display state falls back to database status when activity is not seeded", () => {
  resetStores();
  useAgentStore.setState({
    agents: [
      makeAgent({ id: "active-agent", status: "active" }),
      makeAgent({ id: "stopped-agent", status: "stopped" }),
    ],
  });

  assert.deepEqual(selectAgentDisplayState(useAgentStore.getState(), "active-agent"), {
    activity: "online",
    activityDetail: "",
    activityDetailKind: "none",
    activityText: "Online",
    isOnline: true,
  });
  assert.deepEqual(selectAgentDisplayState(useAgentStore.getState(), "stopped-agent"), {
    activity: "offline",
    activityDetail: "Stopped",
    activityDetailKind: "stopped",
    activityText: "Stopped — won't receive messages until restarted",
    isOnline: false,
  });
});

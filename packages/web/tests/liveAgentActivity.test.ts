import assert from "node:assert/strict";
import type { Agent } from "../src/store/agentStore";
import {
  applyStatusActivityEvent,
  appendLiveAgentActivityItem,
  buildStatusActivityItem,
  LIVE_AGENT_ACTIVITY_VISIBLE_MS,
  LIVE_AGENT_IDLE_GRACE_MS,
  nextLiveAgentActivityExpiry,
  pruneExpiredLiveAgentActivityItems,
} from "../src/utils/liveAgentActivity";
import type {
  LiveAgentActivityItem,
} from "../src/utils/liveAgentActivity";

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

test("buildStatusActivityItem only keeps active work status events", () => {
  const agents = [agent({ id: "agent-1", name: "runner" })];

  assert.equal(buildStatusActivityItem({ agentId: "agent-1", activity: "online" }, agents), null);
  assert.equal(buildStatusActivityItem({ agentId: "agent-1", activity: "online", detail: "Connected" }, agents), null);
  assert.equal(buildStatusActivityItem({ agentId: "agent-1", activity: "offline", detail: "Stopped" }, agents), null);
  assert.equal(buildStatusActivityItem({ agentId: "agent-1", activity: "error", detail: "Tool failed" }, agents), null);

  const working = buildStatusActivityItem({
    agentId: "agent-1",
    activity: "working",
    detail: "Running tests",
    timestamp: 123,
  }, agents);

  assert.equal(working?.agentName, "runner");
  assert.equal(working?.text, "Running tests");
  assert.equal(working?.activity, "working");
  assert.equal(working?.createdAt, 123);

  const thinking = buildStatusActivityItem({
    agentId: "agent-1",
    activity: "thinking",
    timestamp: 124,
  }, agents);

  assert.equal(thinking?.text, "Thinking…");
  assert.equal(thinking?.activity, "thinking");
});

test("appendLiveAgentActivityItem keeps one row per agent, in the order they started", () => {
  const first = {
    id: "a",
    kind: "activity" as const,
    agentId: "agent-1",
    agentName: "Agent",
    agentAvatarUrl: null,
    text: "Working…",
    context: null,
    activity: "working" as const,
    createdAt: 1000,
    startedAt: 1000,
    idleSince: null,
  };
  const duplicate = { ...first, id: "b", createdAt: 1500 };
  const next = { ...first, id: "c", text: "Thinking…", activity: "thinking" as const };

  const other = { ...first, id: "d", agentId: "agent-2", createdAt: 1200, startedAt: 1200 };

  assert.deepEqual(appendLiveAgentActivityItem([], first), [first]);
  assert.deepEqual(appendLiveAgentActivityItem([first], duplicate), [first], "an equivalent event within 2s changes nothing");
  const updated = appendLiveAgentActivityItem([first, other], next);
  assert.deepEqual(updated.map((item) => item.id), ["c", "d"], "a new event updates the agent's row where it is");
  assert.equal(updated[0].startedAt, 1000, "and keeps when it started");
  assert.deepEqual(appendLiveAgentActivityItem([other], first).map((item) => item.agentId), ["agent-2", "agent-1"], "a newcomer joins the end");
});

test("applyStatusActivityEvent lists each working agent once however many events it sends", () => {
  // Regression: the store used to keep a 20-event ticker history, so the
  // top bar counted 20 "agents" and its faces, keyed by agent, piled up.
  const agents = [agent({ id: "agent-1", name: "runner" }), agent({ id: "agent-2", name: "writer" })];
  let items: LiveAgentActivityItem[] = [];
  for (let i = 0; i < 30; i += 1) {
    items = applyStatusActivityEvent(items, {
      agentId: i % 3 === 0 ? "agent-2" : "agent-1",
      activity: "working",
      detail: `Step ${i}`,
      timestamp: 10_000 + i * 3_000,
    }, agents);
    // Neither the set nor the order changes while both keep working: agent-2
    // started first and stays first, however busy agent-1 is.
    if (i >= 1) assert.deepEqual(items.map((item) => item.agentId), ["agent-2", "agent-1"], `after event ${i}`);
  }
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
});

test("applyStatusActivityEvent clears an agent's live work when it settles", () => {
  const agents = [agent({ id: "agent-1", name: "runner" }), agent({ id: "agent-2", name: "writer" })];
  const current = [
    buildStatusActivityItem({
      agentId: "agent-1",
      activity: "working",
      detail: "Running tests",
      timestamp: 10_000,
    }, agents),
    buildStatusActivityItem({
      agentId: "agent-2",
      activity: "thinking",
      timestamp: 10_001,
    }, agents),
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  const next = applyStatusActivityEvent(current, {
    agentId: "agent-1",
    activity: "online",
    timestamp: 10_002,
  }, agents);

  // It stays, in its place, for the idle grace, then leaves.
  assert.deepEqual(next.map((item) => [item.agentId, item.idleSince]), [["agent-1", 10_002], ["agent-2", null]]);
  assert.deepEqual(pruneExpiredLiveAgentActivityItems(next, 10_002 + LIVE_AGENT_IDLE_GRACE_MS - 1).map((item) => item.agentId), ["agent-1", "agent-2"]);
  assert.deepEqual(pruneExpiredLiveAgentActivityItems(next, 10_002 + LIVE_AGENT_IDLE_GRACE_MS).map((item) => item.agentId), ["agent-2"]);
});

test("an agent that picks up again within the idle grace keeps its place; after it, it rejoins at the end", () => {
  // Agents go idle between tool calls. Without the grace their faces dropped
  // out of the stack and came back, many times a minute.
  const agents = [agent({ id: "agent-1", name: "runner" }), agent({ id: "agent-2", name: "writer" })];
  let items = applyStatusActivityEvent([], { agentId: "agent-1", activity: "working", detail: "Edit", timestamp: 1_000 }, agents);
  items = applyStatusActivityEvent(items, { agentId: "agent-2", activity: "working", detail: "Test", timestamp: 1_100 }, agents);
  items = applyStatusActivityEvent(items, { agentId: "agent-1", activity: "online", timestamp: 2_000 }, agents);
  const resumed = applyStatusActivityEvent(items, { agentId: "agent-1", activity: "thinking", timestamp: 2_000 + LIVE_AGENT_IDLE_GRACE_MS - 1 }, agents);
  assert.deepEqual(resumed.map((item) => [item.agentId, item.idleSince, item.startedAt]), [["agent-1", null, 1_000], ["agent-2", null, 1_100]]);

  const afterGrace = 2_000 + LIVE_AGENT_IDLE_GRACE_MS;
  const rejoined = applyStatusActivityEvent(items, { agentId: "agent-1", activity: "thinking", timestamp: afterGrace }, agents);
  assert.deepEqual(rejoined.map((item) => [item.agentId, item.startedAt]), [["agent-2", 1_100], ["agent-1", afterGrace]]);
});

test("nextLiveAgentActivityExpiry is the earliest moment a row leaves on its own", () => {
  const agents = [agent({ id: "agent-1", name: "runner" }), agent({ id: "agent-2", name: "writer" })];
  assert.equal(nextLiveAgentActivityExpiry([]), null);
  let items = applyStatusActivityEvent([], { agentId: "agent-1", activity: "working", detail: "Edit", timestamp: 1_000 }, agents);
  items = applyStatusActivityEvent(items, { agentId: "agent-2", activity: "working", detail: "Test", timestamp: 1_100 }, agents);
  assert.equal(nextLiveAgentActivityExpiry(items), 1_000 + LIVE_AGENT_ACTIVITY_VISIBLE_MS, "the safety window of the quietest working agent");
  items = applyStatusActivityEvent(items, { agentId: "agent-2", activity: "online", timestamp: 3_000 }, agents);
  assert.equal(nextLiveAgentActivityExpiry(items), 3_000 + LIVE_AGENT_IDLE_GRACE_MS, "an idle agent's grace ends first");
});

test("applyStatusActivityEvent treats heartbeat as refresh-only", () => {
  const agents = [agent({ id: "agent-1", name: "runner" })];
  const current = applyStatusActivityEvent([], {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 1_000,
  }, agents);

  const refreshed = applyStatusActivityEvent(current, {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 61_000,
    isHeartbeat: true,
  }, agents);

  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, current[0].id);
  assert.equal(refreshed[0].createdAt, 61_000);
  assert.equal(refreshed[0].text, "Message received");

  assert.deepEqual(applyStatusActivityEvent([], {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 61_000,
    isHeartbeat: true,
  }, agents), []);
});

test("applyStatusActivityEvent treats probe response as refresh-only", () => {
  const agents = [agent({ id: "agent-1", name: "runner" })];
  const current = applyStatusActivityEvent([], {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 1_000,
  }, agents);

  const refreshed = applyStatusActivityEvent(current, {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 21_000,
    isRefreshOnly: true,
  }, agents);

  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, current[0].id);
  assert.equal(refreshed[0].createdAt, 21_000);
  assert.equal(refreshed[0].text, "Message received");

  assert.deepEqual(applyStatusActivityEvent([], {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 21_000,
    isRefreshOnly: true,
  }, agents), []);
});

test("refresh-only terminal snapshot settles the existing live-work row", () => {
  const agents = [
    agent({ id: "agent-1", name: "runner" }),
    agent({ id: "agent-2", name: "writer" }),
  ];
  const target = applyStatusActivityEvent([], {
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 1_000,
  }, agents);
  const unrelated = buildStatusActivityItem({
    agentId: "agent-2",
    activity: "working",
    detail: "Writing tests",
    timestamp: 999,
  }, agents)!;

  const refreshed = applyStatusActivityEvent([...target, unrelated], {
    agentId: "agent-1",
    activity: "online",
    detail: "Idle",
    timestamp: 2_000,
    isRefreshOnly: true,
  }, agents);

  assert.deepEqual(refreshed.map((item) => [item.agentId, item.idleSince]), [["agent-1", 2_000], ["agent-2", null]], "settled, in its place, for the grace");
  assert.deepEqual(pruneExpiredLiveAgentActivityItems(refreshed, 2_000 + LIVE_AGENT_IDLE_GRACE_MS), [unrelated]);
});

test("refresh-only work snapshot updates the existing row without appending or reordering", () => {
  const agents = [
    agent({ id: "agent-1", name: "runner" }),
    agent({ id: "agent-2", name: "writer" }),
  ];
  const currentTarget = buildStatusActivityItem({
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    timestamp: 1_000,
  }, agents)!;
  const olderTarget = buildStatusActivityItem({
    agentId: "agent-1",
    activity: "working",
    detail: "Older work",
    timestamp: 998,
  }, agents)!;
  const unrelated = buildStatusActivityItem({
    agentId: "agent-2",
    activity: "working",
    detail: "Writing tests",
    timestamp: 999,
  }, agents)!;
  const messageRow: LiveAgentActivityItem = {
    ...currentTarget,
    id: "message:agent-1",
    kind: "message",
    text: "Message row",
  };
  const current = [
    unrelated,
    messageRow,
    currentTarget,
    olderTarget,
  ];

  const refreshed = applyStatusActivityEvent(current, {
    agentId: "agent-1",
    activity: "thinking",
    detail: "Thinking deeply",
    timestamp: 2_000,
    isRefreshOnly: true,
  }, agents);

  assert.equal(refreshed.length, current.length);
  assert.equal(refreshed[0], unrelated, "unrelated activity keeps identity and position");
  assert.equal(refreshed[1], messageRow, "non-activity row keeps identity and position");
  assert.equal(refreshed[2].id, currentTarget.id);
  assert.equal(refreshed[2].activity, "thinking");
  assert.equal(refreshed[2].text, "Thinking…");
  assert.notEqual(refreshed[2].text, currentTarget.text);
  assert.equal(refreshed[2].createdAt, 2_000);
  assert.equal(refreshed[3], olderTarget, "older activity history remains untouched");
});

test("pruneExpiredLiveAgentActivityItems drops status activity after the visible window", () => {
  const active = {
    id: "active",
    kind: "activity" as const,
    agentId: "agent-1",
    agentName: "Agent",
    agentAvatarUrl: null,
    text: "Running tests",
    context: null,
    activity: "working" as const,
    createdAt: 10_000,
    startedAt: 10_000,
    idleSince: null,
  };
  const expired = { ...active, id: "expired", createdAt: 10_000 - LIVE_AGENT_ACTIVITY_VISIBLE_MS };

  assert.deepEqual(
    pruneExpiredLiveAgentActivityItems([active, expired], 10_000),
    [active],
  );
});

test("live-activity visibility window outlasts the daemon status heartbeat (no mid-work blanking)", () => {
  // The daemon emits a status-only heartbeat every `ACTIVITY_HEARTBEAT_MS = 60_000`
  // (packages/daemon/src/agentProcessManager.ts) for a steadily-working agent that
  // isn't changing its activity text. If the bar's visibility window is shorter
  // than that, the item time-expires between heartbeats and the bar goes blank for
  // most of every minute — looks frozen / "not refreshing". The window is a safety
  // net (the item is normally replaced on new activity and removed on a terminal
  // idle/online activity), so it must comfortably exceed one heartbeat interval.
  const ACTIVITY_HEARTBEAT_MS = 60_000;
  assert.ok(
    LIVE_AGENT_ACTIVITY_VISIBLE_MS > ACTIVITY_HEARTBEAT_MS,
    `LIVE_AGENT_ACTIVITY_VISIBLE_MS (${LIVE_AGENT_ACTIVITY_VISIBLE_MS}) must exceed the daemon heartbeat (${ACTIVITY_HEARTBEAT_MS}) so a steadily-working agent's live activity does not blank between heartbeats`,
  );
});

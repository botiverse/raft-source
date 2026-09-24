import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "../src/store/agentStore.js";
import type { Channel } from "../src/store/channelStore.js";
import {
  applyStatusActivityEvent,
  appendLiveAgentActivityItem,
  buildMessageActivityItem,
  buildStatusActivityItem,
  LIVE_AGENT_ACTIVITY_VISIBLE_MS,
  pruneExpiredLiveAgentActivityItems,
} from "../src/utils/liveAgentActivity.js";
import type {
  LiveAgentActivityItem,
} from "../src/utils/liveAgentActivity.js";

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

function channel(overrides: Partial<Channel> & Pick<Channel, "id" | "name">): Channel {
  return {
    description: null,
    type: "channel",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("buildMessageActivityItem ignores human messages", () => {
  const item = buildMessageActivityItem({
    id: "message-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Alice",
    content: "hello",
    channelId: "channel-1",
    createdAt: "2026-05-12T00:00:00.000Z",
  }, { agents: [], channels: [], dmChannels: [] });

  assert.equal(item, null);
});

test("buildMessageActivityItem does not convert agent messages into ticker rows", () => {
  const agents = [agent({ id: "agent-1", name: "writer", displayName: "Writer" })];
  const channels = [channel({ id: "channel-1", name: "proj-chat" })];
  const threadItem = buildMessageActivityItem({
    id: "message-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "writer",
    content: "I pushed the PR",
    channelId: "thread-1",
    createdAt: "2026-05-12T00:00:00.000Z",
  }, {
    agents,
    channels,
    dmChannels: [],
    threads: [{ threadChannelId: "thread-1", parentChannelName: "proj-chat" }],
  });

  const channelItem = buildMessageActivityItem({
    id: "message-2",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "writer",
    content: "Done",
    channelId: "channel-1",
    createdAt: "2026-05-12T00:00:01.000Z",
  }, { agents, channels, dmChannels: [] });

  assert.equal(threadItem, null);
  assert.equal(channelItem, null);
});

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

test("appendLiveAgentActivityItem dedupes adjacent equivalent events and keeps newest first", () => {
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
  };
  const duplicate = { ...first, id: "b", createdAt: 1500 };
  const next = { ...first, id: "c", text: "Thinking…", activity: "thinking" as const };

  assert.deepEqual(appendLiveAgentActivityItem([], first), [first]);
  assert.deepEqual(appendLiveAgentActivityItem([first], duplicate), [first]);
  assert.deepEqual(appendLiveAgentActivityItem([first], next).map((item) => item.id), ["c", "a"]);
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

  assert.deepEqual(next.map((item) => item.agentId), ["agent-2"]);
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

test("refresh-only terminal snapshot clears the existing live-work row", () => {
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

  assert.deepEqual(refreshed, [unrelated]);
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

import assert from "node:assert/strict";

import { vi } from "vitest";

import api from "../src/api/client";
import {
  __setReconnectReloadJitterMsForTests,
  __setSyncPullJitterMsForTests,
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

/**
 * Activity multi-device sync (spec v2/v3 §4.2): a `conversation` change that
 * carries the row's current state is applied in place; only what the web
 * can't patch reads the lists again. Driven through the real socket bindings.
 */

const SERIAL = {};
const SERVER_ID = "srv-patch";
// One channel per test: the read ledger is module state.
let CHANNEL = "ch-patch";
let channelSeq = 0;

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  emit() { return undefined; }
  on() { return undefined; }
  off() { return undefined; }
  onAny() { return undefined; }
  offAny() { return undefined; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
}

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

/** `loaded`: the frontiers as the list served them; `latest` may have moved on since (a live message). */
function channelRow(latest: string, unreadCount: number, loaded = latest): ChannelItem {
  return {
    kind: "channel",
    channelId: CHANNEL,
    channelName: "general",
    channelType: "channel",
    lastMessageId: "m-1",
    latestActivitySeq: latest,
    firstUnreadMessageId: unreadCount > 0 ? "m-1" : null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-10-28T03:00:00.000Z",
    lastMessagePreview: "hi",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u-2",
    lastMessageSenderName: "alice",
    senderAvatarUrl: null,
    unreadCount,
    hasMention: false,
    doneFrontierSeq: loaded,
    readStateLatestActivitySeq: loaded,
  } as unknown as ChannelItem;
}

function setup(makeChanges: (channelId: string) => unknown[]) {
  CHANNEL = `ch-patch-${++channelSeq}`;
  const changes = makeChanges(CHANNEL);
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const restorePull = __setSyncPullJitterMsForTests(2_000);
  const responses = [{ cursor: "c0", hasMore: false, changes: [], reset: null }, { cursor: "c1", hasMore: false, changes, reset: null }];
  const sinces: Array<string | null> = [];
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { params?: { since?: string } }) => {
    if (url !== "/sync/changes") throw new Error(`unexpected GET ${url}`);
    sinces.push(config?.params?.since ?? null);
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return { data: next } as never;
  });
  const saved = {
    server: useServerStore.getState().current,
    inbox: useInboxStore.getState(),
    message: useMessageStore.getState(),
    thread: useThreadStore.getState(),
    server_: useServerStore.getState(),
    machine: useMachineStore.getState(),
    agent: useAgentStore.getState(),
    channel: useChannelStore.getState(),
  };
  const calls = { inbox: 0, unread: 0, followed: 0 };
  const noop = async () => undefined;
  useServerStore.setState({
    current: { id: SERVER_ID, slug: "s", name: "S", role: "member", plan: "free" },
    loadSidebarOrder: noop, loadServers: noop, loadMembers: noop,
  } as never);
  useInboxStore.setState({ loadInbox: async () => { calls.inbox += 1; } } as never);
  useMessageStore.setState({ loadUnreadCounts: async () => { calls.unread += 1; } } as never);
  useThreadStore.setState({ loadFollowedThreads: async () => { calls.followed += 1; } } as never);
  useMachineStore.setState({ loadMachines: noop } as never);
  useAgentStore.setState({ loadAgents: noop, resetActivitySeq: () => undefined } as never);
  useChannelStore.setState({ loadChannels: noop, loadDMChannels: noop } as never);

  const bindings = buildMainLayoutSocketBindings(new FakeSocket(), () => undefined, async () => undefined, () => undefined, () => undefined);
  const byEvent = new Map<string, SocketBinding["handler"]>(bindings.map((b) => [b.event, b.handler]));
  return {
    calls, sinces,
    fire: (event: string, payload?: unknown) => byEvent.get(event)!(payload),
    restore() {
      useInboxStore.setState(saved.inbox, true);
      useMessageStore.setState(saved.message, true);
      useThreadStore.setState(saved.thread, true);
      useServerStore.setState(saved.server_, true);
      useMachineStore.setState(saved.machine, true);
      useAgentStore.setState(saved.agent, true);
      useChannelStore.setState(saved.channel, true);
      get.mockRestore();
      restorePull();
      restoreJitter();
      vi.useRealTimers();
    },
  };
}

async function settle() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

/** Connect, reconnect (takes the cursor), seed the rows, then `sync:changed` pulls the change. */
async function pullOnSyncChanged(t: ReturnType<typeof setup>, rows: InboxItem[], unread: Record<string, number>) {
  t.fire("connect");
  t.fire("rooms:joined");
  await settle();
  t.fire("connect");
  t.fire("rooms:joined");
  await settle();
  vi.advanceTimersByTime(25_000);
  await settle();
  const before = { ...t.calls };
  useInboxStore.setState({ items: rows, totalCount: rows.length, totalUnreadCount: rows.reduce((n, r) => n + r.unreadCount, 0), activeUnreadCount: rows.reduce((n, r) => n + r.unreadCount, 0) } as never);
  useMessageStore.setState({ unreadCounts: unread } as never);
  t.fire("sync:changed", { seq: 1 });
  await settle();
  vi.advanceTimersByTime(0);
  await settle();
  return before;
}

test("sync:changed pulls at once; a read that covers the row clears it without reading the lists", SERIAL, async () => {
  const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: 100, read: { readSeq: 100, readStateVersion: 5 } }]);
  try {
    const before = await pullOnSyncChanged(t, [channelRow("100", 3)], { [CHANNEL]: 3 });
    assert.deepEqual(t.sinces, [null, "c0"], "pulled on sync:changed with no spread");
    const row = useInboxStore.getState().items[0];
    assert.equal(row?.unreadCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
    assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], undefined, "sidebar unread cleared");
    assert.deepEqual(t.calls, before, "no list read again");
  } finally {
    t.restore();
  }
});

test("a read short of the row's newest activity, with no messages loaded, reads the lists again", SERIAL, async () => {
  const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: 90, read: { readSeq: 90, readStateVersion: 5 } }]);
  try {
    const before = await pullOnSyncChanged(t, [channelRow("100", 3)], { [CHANNEL]: 3 });
    assert.equal(useInboxStore.getState().items[0]?.unreadCount, 3, "not guessed");
    assert.deepEqual(t.calls, { inbox: before.inbox + 1, unread: before.unread + 1, followed: before.followed + 1 });
  } finally {
    t.restore();
  }
});

test("Done on another device drops a covered row; a row with newer activity stays; neither reads the lists", SERIAL, async () => {
  for (const [rowLatest, expectedRows] of [["100", 0], ["120", 1]] as const) {
    const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: null, done: { done: true, doneFrontierSeq: "100" } }]);
    try {
      const before = await pullOnSyncChanged(t, [channelRow(rowLatest, 1)], {});
      assert.equal(useInboxStore.getState().items.length, expectedRows, `row at ${rowLatest}`);
      assert.deepEqual(t.calls, before);
    } finally {
      t.restore();
    }
  }
});

test("the Done comparison uses the row's latestActivitySeq, not its doneFrontierSeq (absent or stale on the RisingWave path)", SERIAL, async () => {
  const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: null, done: { done: true, doneFrontierSeq: "100" } }]);
  try {
    const row = { ...channelRow("100", 1), doneFrontierSeq: null } as unknown as InboxItem;
    const before = await pullOnSyncChanged(t, [row], {});
    assert.equal(useInboxStore.getState().items.length, 0, "removed without the row's own frontier");
    assert.deepEqual(t.calls, before);
  } finally {
    t.restore();
  }
});

test("undone and follow changes read the lists again (single-row read comes later)", SERIAL, async () => {
  for (const change of [
    { done: { done: false, doneFrontierSeq: "100" } },
    { follow: { followed: true, threadDone: false } },
  ]) {
    const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: null, ...change }]);
    try {
      const before = await pullOnSyncChanged(t, [channelRow("100", 0)], {});
      assert.deepEqual(t.calls, { inbox: before.inbox + 1, unread: before.unread + 1, followed: before.followed + 1 });
    } finally {
      t.restore();
    }
  }
});

test("a live message after the list loaded: a read up to the loaded row doesn't clear it; a Done up to it keeps it", SERIAL, async () => {
  {
    const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: null, read: { readSeq: 100, readStateVersion: 5 } }]);
    try {
      const before = await pullOnSyncChanged(t, [channelRow("105", 2, "100")], { [CHANNEL]: 2 });
      assert.equal(useInboxStore.getState().items[0]?.unreadCount, 2, "the message at 105 stays unread");
      assert.equal(useMessageStore.getState().unreadCounts[CHANNEL], 2);
      assert.deepEqual(t.calls, { inbox: before.inbox + 1, unread: before.unread + 1, followed: before.followed + 1 }, "reads the lists instead");
    } finally {
      t.restore();
    }
  }
  {
    const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: null, done: { done: true, doneFrontierSeq: "100" } }]);
    try {
      const before = await pullOnSyncChanged(t, [channelRow("105", 2, "100")], { [CHANNEL]: 2 });
      assert.equal(useInboxStore.getState().items.length, 1, "newer activity keeps the row (reopen rule)");
      assert.equal(useInboxStore.getState().items[0]?.unreadCount, 2);
      assert.deepEqual(t.calls, before);
    } finally {
      t.restore();
    }
  }
});

test("mark as unread on another device (lower read, newer version) with no messages loaded reads the lists", SERIAL, async () => {
  const t = setup((id) => [{ seq: 1, entity: "conversation", id, op: "stale", refSeq: 40, read: { readSeq: 40, readStateVersion: 9 } }]);
  try {
    const before = await pullOnSyncChanged(t, [channelRow("100", 0)], {});
    assert.deepEqual(t.calls, { inbox: before.inbox + 1, unread: before.unread + 1, followed: before.followed + 1 });
  } finally {
    t.restore();
  }
});

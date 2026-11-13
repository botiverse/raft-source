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
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

/**
 * First load and the start of incremental sync. The first connect takes no
 * cursor: it reuses the lists the boot path loaded moments ago (a cursor would
 * have every list read again after it, a second GET /channels per page load).
 * Sync starts at the first reconnect: cursor first, then every list after it.
 *
 * Each loader stands for its endpoint(s) (SYNC_SNAPSHOT_ENDPOINTS):
 * unread GET /channels/unread, inbox GET /channels/inbox, channels
 * GET /channels, dms GET /channels/dm, members GET /servers/:id/members, ...
 */

const SERIAL = {};
const SERVER_ID = "srv-first-load";

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

function bind() {
  const bindings = buildMainLayoutSocketBindings(new FakeSocket(), () => undefined, async () => undefined, () => undefined, () => undefined);
  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const b of bindings) byEvent.set(b.event, b.handler);
  return { connect: byEvent.get("connect")!, roomsJoined: byEvent.get("rooms:joined")! };
}

const LISTS = ["unread", "inbox", "channels", "dms", "members", "agents", "machines", "sidebarOrder", "servers", "followedThreads"] as const;
type List = (typeof LISTS)[number];

function setup(cursor: () => Promise<unknown>) {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const restorePull = __setSyncPullJitterMsForTests(2_000);
  const calls = Object.fromEntries(LISTS.map((name) => [name, 0])) as Record<List, number>;
  const order: string[] = [];
  const hit = (name: List) => async () => { calls[name] += 1; order.push(name); };
  let cursorRequests = 0;
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url !== "/sync/changes") throw new Error(`unexpected GET ${url}`);
    cursorRequests += 1;
    order.push("cursor-request");
    const data = await cursor();
    order.push("cursor");
    return { data } as never;
  });
  const saved = {
    message: useMessageStore.getState(),
    inbox: useInboxStore.getState(),
    channel: useChannelStore.getState(),
    server: useServerStore.getState(),
    machine: useMachineStore.getState(),
    agent: useAgentStore.getState(),
    thread: useThreadStore.getState(),
  };
  useServerStore.setState({ current: { id: SERVER_ID, slug: "s", name: "S", role: "member", plan: "free" } } as never);
  useMessageStore.setState({ loadUnreadCounts: hit("unread") } as never);
  useInboxStore.setState({ loadInbox: hit("inbox") } as never);
  useChannelStore.setState({ loadChannels: hit("channels"), loadDMChannels: hit("dms") } as never);
  useServerStore.setState({ loadMembers: hit("members"), loadSidebarOrder: hit("sidebarOrder"), loadServers: hit("servers") } as never);
  useMachineStore.setState({ loadMachines: hit("machines") } as never);
  useAgentStore.setState({ loadAgents: hit("agents"), resetActivitySeq: () => undefined } as never);
  useThreadStore.setState({ loadFollowedThreads: hit("followedThreads") } as never);
  return {
    calls, order,
    cursorRequests: () => cursorRequests,
    restore() {
      useMessageStore.setState({ loadUnreadCounts: saved.message.loadUnreadCounts } as never);
      useInboxStore.setState({ loadInbox: saved.inbox.loadInbox } as never);
      useChannelStore.setState({ loadChannels: saved.channel.loadChannels, loadDMChannels: saved.channel.loadDMChannels } as never);
      useServerStore.setState({
        current: saved.server.current, loadMembers: saved.server.loadMembers,
        loadSidebarOrder: saved.server.loadSidebarOrder, loadServers: saved.server.loadServers,
      } as never);
      useMachineStore.setState({ loadMachines: saved.machine.loadMachines } as never);
      useAgentStore.setState({ loadAgents: saved.agent.loadAgents, resetActivitySeq: saved.agent.resetActivitySeq } as never);
      useThreadStore.setState({ loadFollowedThreads: saved.thread.loadFollowedThreads } as never);
      get.mockRestore();
      restorePull();
      restoreJitter();
      vi.useRealTimers();
    },
  };
}

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

const cursorPage = async () => ({ cursor: "c0", hasMore: false, changes: [], reset: null });

/** Runs past the jitter windows and every fallback timer. */
async function drain() {
  await settle();
  vi.advanceTimersByTime(30_000);
  await settle();
}

test("the first load takes no cursor and reads each list once; DMs and members come from the boot path", SERIAL, async () => {
  const t = setup(cursorPage);
  try {
    const { connect, roomsJoined } = bind();
    connect();
    roomsJoined();
    await drain();
    assert.equal(t.cursorRequests(), 0, "no GET /sync/changes on the first connect");
    assert.deepEqual(t.calls, {
      unread: 1, inbox: 1, channels: 1, dms: 0, members: 0, agents: 1,
      machines: 1, sidebarOrder: 1, servers: 1, followedThreads: 1,
    });
  } finally {
    t.restore();
  }
});

test("the first reconnect takes the cursor, then reads every list after it", SERIAL, async () => {
  const t = setup(cursorPage);
  try {
    const { connect, roomsJoined } = bind();
    connect();
    roomsJoined();
    await drain();
    const before = { ...t.calls };
    t.order.length = 0;
    connect();
    roomsJoined();
    await drain();
    assert.equal(t.cursorRequests(), 1);
    const cursorAt = t.order.indexOf("cursor");
    assert.ok(cursorAt >= 0, "a cursor was taken");
    for (const name of ["channels", "dms", "members", "agents", "machines", "sidebarOrder", "servers", "followedThreads"] as const) {
      assert.ok(t.calls[name] > before[name], `${name} read again`);
      assert.ok(t.order.lastIndexOf(name) > cursorAt, `${name} read after the cursor`);
    }
  } finally {
    t.restore();
  }
});

test("a failed start at the first reconnect falls back to the full reloads; the next reconnect tries a cursor again", SERIAL, async () => {
  let fail = true;
  const t = setup(async () => { if (fail) throw new Error("503"); return cursorPage(); });
  try {
    const { connect, roomsJoined } = bind();
    connect();
    roomsJoined();
    await drain();
    const before = { ...t.calls };
    connect();
    roomsJoined();
    await drain();
    assert.equal(t.cursorRequests(), 1);
    assert.ok(t.calls.channels > before.channels, "the channel list is read again");
    assert.ok(t.calls.sidebarOrder > before.sidebarOrder, "the connect snapshot is read again");
    fail = false;
    connect();
    roomsJoined();
    await drain();
    assert.equal(t.cursorRequests(), 2, "the next reconnect takes a cursor");
  } finally {
    t.restore();
  }
});

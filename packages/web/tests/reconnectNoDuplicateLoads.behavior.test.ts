import assert from "node:assert/strict";

import { vi } from "vitest";

import {
  __setReconnectReloadJitterMsForTests,
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
  SocketBinding,
} from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import { subscribeChannelMembersChanged } from "../src/store/channelMemberEvents";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { __setStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace";

/**
 * One reconnect must fetch each thing once.
 *
 * `connect` and `rooms:joined` both fire on every reconnect, and both used to
 * call `loadUnreadCounts()` and `loadInboxReset()`. Unread counts and the inbox
 * belong to the `rooms:joined` leg alone: the server emits that event only
 * after it has finished joining every channel room ("room setup is complete —
 * safe to gap-sync"), so a fetch issued at connect races that window and is
 * already stale when it lands.
 *
 * Counted through the real bindings rather than by reading the source: the
 * request count IS the observable result of this change, so the test asserts
 * the thing the change is for.
 */

const SERIAL = {};

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }
  on() { return undefined; }
  off() { return undefined; }
  onAny() { return undefined; }
  offAny() { return undefined; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
}

function bind(socket: FakeSocket) {
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const b of bindings) byEvent.set(b.event, b.handler);
  return {
    connect: byEvent.get("connect")!,
    roomsJoined: byEvent.get("rooms:joined")!,
  };
}

/** Replaces every loader the reconnect path touches with a counter. */
function countLoaders() {
  const calls: Record<string, number> = {
    unread: 0, inbox: 0, sidebarOrder: 0, machines: 0,
    agents: 0, servers: 0, followedThreads: 0, channels: 0,
  };
  const saved = {
    unread: useMessageStore.getState().loadUnreadCounts,
    inbox: useInboxStore.getState().loadInbox,
    sidebarOrder: useServerStore.getState().loadSidebarOrder,
    machines: useMachineStore.getState().loadMachines,
    agents: useAgentStore.getState().loadAgents,
    resetSeq: useAgentStore.getState().resetActivitySeq,
    servers: useServerStore.getState().loadServers,
    followed: useThreadStore.getState().loadFollowedThreads,
    channels: useChannelStore.getState().loadChannels,
  };
  useMessageStore.setState({ loadUnreadCounts: async () => { calls.unread += 1; } } as never);
  useInboxStore.setState({ loadInbox: async () => { calls.inbox += 1; } } as never);
  useServerStore.setState({
    loadSidebarOrder: async () => { calls.sidebarOrder += 1; },
    loadServers: async () => { calls.servers += 1; },
  } as never);
  useMachineStore.setState({ loadMachines: async () => { calls.machines += 1; } } as never);
  useAgentStore.setState({
    loadAgents: async () => { calls.agents += 1; },
    resetActivitySeq: () => undefined,
  } as never);
  useThreadStore.setState({ loadFollowedThreads: async () => { calls.followedThreads += 1; } } as never);
  useChannelStore.setState({ loadChannels: async () => { calls.channels += 1; } } as never);

  return {
    calls,
    restore() {
      useMessageStore.setState({ loadUnreadCounts: saved.unread } as never);
      useInboxStore.setState({ loadInbox: saved.inbox } as never);
      useServerStore.setState({ loadSidebarOrder: saved.sidebarOrder, loadServers: saved.servers } as never);
      useMachineStore.setState({ loadMachines: saved.machines } as never);
      useAgentStore.setState({ loadAgents: saved.agents, resetActivitySeq: saved.resetSeq } as never);
      useThreadStore.setState({ loadFollowedThreads: saved.followed } as never);
      useChannelStore.setState({ loadChannels: saved.channels } as never);
    },
  };
}

test("one (first) connect fetches unread counts and the inbox exactly once", SERIAL, async () => {
  const socket = new FakeSocket();
  const { connect, roomsJoined } = bind(socket);
  const probe = countLoaders();
  try {
    connect();
    await Promise.resolve();
    assert.equal(probe.calls.unread, 0, "connect must not fetch unread counts — it races the room joins");
    assert.equal(probe.calls.inbox, 0, "connect must not reset the inbox — rooms:joined owns that leg");
    assert.equal(probe.calls.channels, 0, "connect must not reload channels — rooms:joined owns that leg");

    roomsJoined();
    await Promise.resolve();
    assert.equal(probe.calls.unread, 1, "rooms:joined must fetch unread counts exactly once");
    assert.equal(probe.calls.inbox, 1, "rooms:joined must reset the inbox exactly once");
    // A server-side eviction (channel visibility/guest policy/role change) no
    // longer tells non-members which channel they lost; the reload is the only
    // way the sidebar drops it.
    assert.equal(probe.calls.channels, 1, "rooms:joined must reload the channel list exactly once");
  } finally {
    probe.restore();
  }
});

test("the first connect snapshot still refreshes what only it owns", SERIAL, async () => {
  const socket = new FakeSocket();
  const { connect } = bind(socket);
  const probe = countLoaders();
  try {
    connect();
    await Promise.resolve();
    // No rooms:joined counterpart — dropping any of these would lose the
    // refresh rather than dedupe it.
    assert.equal(probe.calls.sidebarOrder, 1, "sidebar order must still refresh on connect");
    assert.equal(probe.calls.machines, 1, "machines must still refresh on connect");
    assert.equal(probe.calls.agents, 1, "agents must still refresh on connect");
    assert.equal(probe.calls.servers, 1, "servers must still refresh on connect");
    assert.equal(probe.calls.followedThreads, 1, "followed threads must still refresh on connect");
  } finally {
    probe.restore();
  }
});

test("a full first connect ends with unread and inbox loaded", SERIAL, async () => {
  const socket = new FakeSocket();
  const { connect, roomsJoined } = bind(socket);
  const probe = countLoaders();
  try {
    connect();
    roomsJoined();
    await Promise.resolve();
    // Removing BOTH copies would also satisfy "not twice"; this pins that the
    // data still arrives.
    assert.equal(probe.calls.unread, 1, "a reconnect must leave unread counts loaded");
    assert.equal(probe.calls.inbox, 1, "a reconnect must leave the inbox loaded");
  } finally {
    probe.restore();
  }
});

test("a reconnect delays the full-list reloads but not unread, inbox or catch-up", SERIAL, async () => {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const probe = countLoaders();
  const socket = new FakeSocket();
  useMessageStore.setState({ lastSeq: 7 } as never);
  try {
    const { connect, roomsJoined } = bind(socket);
    // Boot: the first connect of this bridge loads at once.
    connect();
    roomsJoined();
    await Promise.resolve();
    assert.equal(probe.calls.machines, 1);
    assert.equal(probe.calls.channels, 1);

    // Reconnect on the same socket.
    socket.emitted.length = 0;
    connect();
    roomsJoined();
    await Promise.resolve();
    assert.ok(socket.emitted.some((e) => e.event === "sync:resume"), "message catch-up must not wait");
    assert.equal(probe.calls.unread, 2, "unread counts must not wait");
    assert.equal(probe.calls.inbox, 2, "the inbox must not wait");
    for (const key of ["sidebarOrder", "machines", "agents", "servers", "followedThreads", "channels"]) {
      assert.equal(probe.calls[key], 1, `${key} must wait for the jitter`);
    }

    vi.advanceTimersByTime(9_999);
    assert.equal(probe.calls.machines, 1, "Math.random 0.5 of 20 s is 10 s");
    vi.advanceTimersByTime(1);
    for (const key of ["sidebarOrder", "machines", "agents", "servers", "followedThreads", "channels"]) {
      assert.equal(probe.calls[key], 2, `${key} must load once when the jitter ends`);
    }
  } finally {
    probe.restore();
    restoreJitter();
    random.mockRestore();
    vi.useRealTimers();
    useMessageStore.setState({ lastSeq: 0 } as never);
  }
});

/** A node test has no document: a minimal one whose visibility the test sets. */
function fakeVisibility(initial: DocumentVisibilityState) {
  const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  target.visibilityState = initial;
  Object.defineProperty(globalThis, "document", { configurable: true, value: target });
  return {
    set(next: DocumentVisibilityState) {
      target.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    },
    restore() {
      delete (globalThis as { document?: unknown }).document;
    },
  };
}

test("a hidden reconnect holds the full-list reloads and the inbox until the page shows, then loads each once; catch-up and unread still go", SERIAL, async () => {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const probe = countLoaders();
  const traces: Array<Record<string, unknown>> = [];
  __setStateTransitionEmitterForTest(((_name: string, attrs: Record<string, unknown>) => { traces.push(attrs); }) as never);
  const socket = new FakeSocket();
  useMessageStore.setState({ lastSeq: 7 } as never);
  const page = fakeVisibility("visible");
  try {
    const { connect, roomsJoined } = bind(socket);
    connect();
    roomsJoined();
    await Promise.resolve();
    assert.equal(probe.calls.machines, 1);
    assert.equal(probe.calls.inbox, 1);

    page.set("hidden");
    socket.emitted.length = 0;
    // The OS drops the background socket twice; each comes back.
    connect();
    roomsJoined();
    vi.advanceTimersByTime(30_000);
    connect();
    roomsJoined();
    vi.advanceTimersByTime(30_000);
    assert.ok(socket.emitted.some((e) => e.event === "sync:resume"), "the server catch-up is still asked for");
    assert.equal(probe.calls.unread, 3, "unread counts still load");
    for (const key of ["inbox", "sidebarOrder", "machines", "agents", "servers", "followedThreads", "channels"]) {
      assert.equal(probe.calls[key], 1, `${key}: nothing while hidden`);
    }

    page.set("visible");
    for (const key of ["inbox", "sidebarOrder", "machines", "agents", "servers", "followedThreads", "channels"]) {
      assert.equal(probe.calls[key], 2, `${key}: once on show`);
    }
    page.set("hidden");
    page.set("visible");
    assert.equal(probe.calls.machines, 2, "nothing more owed");

    const reconnects = traces.filter((t) => (t.key as { domain: string; event: string }).domain === "live_session");
    assert.deepEqual(
      reconnects.map((t) => [(t.key as { event: string }).event, (t.key as { entityId: string }).entityId, (t.meta as { outcomeDetail: string }).outcomeDetail, t["tab.visibility"]]),
      [
        ["reconnect", "socket", "reconnected", "hidden"],
        ["hold", "inbox_reset", "held_hidden", "hidden"],
        ["hold", "reload_batch", "held_hidden", "hidden"],
        ["reconnect", "socket", "reconnected", "hidden"],
        ["hold", "inbox_reset", "held_hidden", "hidden"],
      ],
      "each reconnect (not the first connect) is traced with the tab's visibility, and each reload held while hidden",
    );
  } finally {
    page.restore();
    __setStateTransitionEmitterForTest(null);
    probe.restore();
    restoreJitter();
    random.mockRestore();
    vi.useRealTimers();
    useMessageStore.setState({ lastSeq: 0 } as never);
  }
});

test("reconnects inside one jitter window coalesce into one reload", SERIAL, async () => {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const probe = countLoaders();
  const socket = new FakeSocket();
  try {
    const { connect, roomsJoined } = bind(socket);
    connect();
    roomsJoined();
    connect();
    roomsJoined();
    vi.advanceTimersByTime(5_000);
    connect();
    roomsJoined();
    vi.advanceTimersByTime(20_000);
    assert.equal(probe.calls.machines, 2, "boot + one coalesced reconnect reload");
    assert.equal(probe.calls.channels, 2, "boot + one coalesced reconnect reload");
  } finally {
    probe.restore();
    restoreJitter();
    random.mockRestore();
    vi.useRealTimers();
  }
});

test("a reconnect re-reads the mounted channel rosters with the agents (another server's agents' activity, #triage:#95)", SERIAL, async () => {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const probe = countLoaders();
  const rosterReloads: Array<string | null> = [];
  const unsubscribe = subscribeChannelMembersChanged((channelId) => { rosterReloads.push(channelId); });
  try {
    const { connect } = bind(new FakeSocket());
    connect();
    await Promise.resolve();
    assert.deepEqual(rosterReloads, [], "the first connect's roster loads with the channel itself");
    connect();
    vi.advanceTimersByTime(9_999);
    assert.deepEqual(rosterReloads, [], "waits for the reconnect batch");
    vi.advanceTimersByTime(1);
    assert.deepEqual(rosterReloads, [null], "every mounted roster reads again, once");
  } finally {
    unsubscribe();
    probe.restore();
    restoreJitter();
    random.mockRestore();
    vi.useRealTimers();
  }
});

test("the first connect and first join skip lists the boot path loaded moments ago; a reconnect reads them again (web perf)", SERIAL, async () => {
  const { bootListKey, noteFreshLoad } = await import("../src/store/serverStore");
  const savedServer = useServerStore.getState().current;
  const savedEpoch = useServerStore.getState().serverEpoch;
  useServerStore.setState({ current: { id: "srv-fresh", slug: "f", name: "F", role: "member", plan: "free" } } as never);
  const epoch = useServerStore.getState().serverEpoch;
  noteFreshLoad(bootListKey.servers);
  noteFreshLoad(bootListKey.sidebarOrder("srv-fresh", epoch));
  noteFreshLoad(bootListKey.channels("srv-fresh", epoch));
  const socket = new FakeSocket();
  const { connect, roomsJoined } = bind(socket);
  const probe = countLoaders();
  vi.useFakeTimers();
  try {
    connect();
    roomsJoined();
    await Promise.resolve();
    assert.equal(probe.calls.servers, 0, "the boot server list is reused");
    assert.equal(probe.calls.sidebarOrder, 0, "the boot sidebar order is reused");
    assert.equal(probe.calls.machines, 1, "machines always reload (online status)");
    assert.equal(probe.calls.channels, 0, "the boot channel list is reused by the first join");
    assert.equal(probe.calls.agents, 1, "agents still load (no boot copy)");
    assert.equal(probe.calls.followedThreads, 1, "followed threads still load (no boot copy)");
    assert.equal(probe.calls.unread, 1);
    assert.equal(probe.calls.inbox, 1);

    // A reconnect reads them again, whatever the boot loaded.
    connect();
    roomsJoined();
    await vi.advanceTimersByTimeAsync(25_000);
    assert.equal(probe.calls.channels, 1, "a reconnect re-reads the channel list");
    assert.ok(probe.calls.servers >= 1, "a reconnect re-reads the server list");
    assert.ok(probe.calls.machines >= 2, "a reconnect re-reads machines");
  } finally {
    vi.useRealTimers();
    probe.restore();
    useServerStore.setState({ current: savedServer, serverEpoch: savedEpoch } as never);
  }
});

test("a boot list loaded long ago is read again by the first connect", SERIAL, async () => {
  const { noteFreshLoad } = await import("../src/store/serverStore");
  vi.useFakeTimers();
  noteFreshLoad("servers:list");
  vi.advanceTimersByTime(16_000);
  const { connect } = bind(new FakeSocket());
  const probe = countLoaders();
  try {
    connect();
    await Promise.resolve();
    assert.equal(probe.calls.servers, 1);
  } finally {
    vi.useRealTimers();
    probe.restore();
  }
});

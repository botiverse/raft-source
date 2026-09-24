import assert from "node:assert/strict";
import test from "node:test";

import { buildMainLayoutSocketBindings } from "../src/store/socketBridge.js";
import type {
  MainLayoutSocketBridgeSocket,
  SocketBinding,
} from "../src/store/socketBridge.js";
import { useAgentStore } from "../src/store/agentStore.js";
import { useChannelStore } from "../src/store/channelStore.js";
import { useInboxStore } from "../src/store/inboxStore.js";
import { useMachineStore } from "../src/store/machineStore.js";
import { useMessageStore } from "../src/store/messageStore.js";
import { useServerStore } from "../src/store/serverStore.js";
import { useThreadStore } from "../src/store/threadStore.js";

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

const SERIAL = { concurrency: false };

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

test("one reconnect fetches unread counts and the inbox exactly once", SERIAL, async () => {
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

test("the reconnect snapshot still refreshes what only it owns", SERIAL, async () => {
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

test("a full reconnect ends with unread and inbox loaded", SERIAL, async () => {
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

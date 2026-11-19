import assert from "node:assert/strict";

import api from "../src/api/client";

import { __setEmbedModeForTests } from "../src/embed";
import {
  __setBootUnreadFallbackMsForTests,
  buildMainLayoutSocketBindings,
  createMainLayoutRealtimeBridgeDriver,
} from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

/**
 * A host-shell embed shows one settings surface inside a native app. It keeps
 * the socket and the loads those surfaces read (machines, agents, servers) and
 * issues none of the chat-only startup loads.
 *
 * Counted through the real bootstrap and the real socket handlers, in both
 * modes, so the full app's request set is pinned by the same test that pins the
 * embed's.
 */

const SERIAL = {};
const HOST_SHELL = { embedded: true, shell: "host" } as const;
const CHAT_ONLY = ["channels", "dms", "saved", "announcements", "unread", "inbox", "sidebarOrder", "followedThreads"] as const;
const KEPT = ["machines", "agents", "servers"] as const;

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

function handlers() {
  const bindings = buildMainLayoutSocketBindings(
    new FakeSocket(),
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const binding of bindings) byEvent.set(binding.event, binding.handler);
  return { connect: byEvent.get("connect")!, roomsJoined: byEvent.get("rooms:joined")! };
}

/** Replaces every startup loader with a counter. */
function countLoaders() {
  const calls: Record<(typeof CHAT_ONLY)[number] | (typeof KEPT)[number], number> = {
    channels: 0, dms: 0, saved: 0, announcements: 0, unread: 0, inbox: 0,
    sidebarOrder: 0, followedThreads: 0, machines: 0, agents: 0, servers: 0,
  };
  const saved = {
    channels: useChannelStore.getState().loadChannels,
    dms: useChannelStore.getState().loadDMChannels,
    saved: useSavedStore.getState().loadSaved,
    announcements: useAnnouncementStore.getState().load,
    unread: useMessageStore.getState().loadUnreadCounts,
    inbox: useInboxStore.getState().loadInbox,
    sidebarOrder: useServerStore.getState().loadSidebarOrder,
    servers: useServerStore.getState().loadServers,
    followed: useThreadStore.getState().loadFollowedThreads,
    machines: useMachineStore.getState().loadMachines,
    agents: useAgentStore.getState().loadAgents,
    resetSeq: useAgentStore.getState().resetActivitySeq,
  };
  useChannelStore.setState({
    loadChannels: async () => { calls.channels += 1; },
    loadDMChannels: async () => { calls.dms += 1; },
  } as never);
  useSavedStore.setState({ loadSaved: async () => { calls.saved += 1; } } as never);
  useAnnouncementStore.setState({ load: async () => { calls.announcements += 1; } } as never);
  useMessageStore.setState({ loadUnreadCounts: async () => { calls.unread += 1; } } as never);
  useInboxStore.setState({ loadInbox: async () => { calls.inbox += 1; } } as never);
  useServerStore.setState({
    loadSidebarOrder: async () => { calls.sidebarOrder += 1; },
    loadServers: async () => { calls.servers += 1; },
  } as never);
  useThreadStore.setState({ loadFollowedThreads: async () => { calls.followedThreads += 1; } } as never);
  useMachineStore.setState({ loadMachines: async () => { calls.machines += 1; } } as never);
  useAgentStore.setState({ loadAgents: async () => { calls.agents += 1; }, resetActivitySeq: () => undefined } as never);
  return {
    calls,
    restore() {
      useChannelStore.setState({ loadChannels: saved.channels, loadDMChannels: saved.dms } as never);
      useSavedStore.setState({ loadSaved: saved.saved } as never);
      useAnnouncementStore.setState({ load: saved.announcements } as never);
      useMessageStore.setState({ loadUnreadCounts: saved.unread } as never);
      useInboxStore.setState({ loadInbox: saved.inbox } as never);
      useServerStore.setState({ loadSidebarOrder: saved.sidebarOrder, loadServers: saved.servers } as never);
      useThreadStore.setState({ loadFollowedThreads: saved.followed } as never);
      useMachineStore.setState({ loadMachines: saved.machines } as never);
      useAgentStore.setState({ loadAgents: saved.agents, resetActivitySeq: saved.resetSeq } as never);
    },
  };
}

/** One full boot: bootstrap, then the socket connects, then its rooms are joined. */
async function boot() {
  let reconnects = 0;
  const driver = createMainLayoutRealtimeBridgeDriver({
    getSocket: () => new FakeSocket(),
    reconnectSocket: () => { reconnects += 1; },
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  });
  const { connect, roomsJoined } = handlers();
  driver.bootstrap();
  connect();
  roomsJoined();
  await Promise.resolve();
  return reconnects;
}

test("a host-shell embed boots without the chat-only loads", SERIAL, async () => {
  const restoreEmbed = __setEmbedModeForTests(HOST_SHELL);
  const restoreTimers = __setBootUnreadFallbackMsForTests(60_000);
  const probe = countLoaders();
  try {
    const reconnects = await boot();
    assert.equal(reconnects, 1, "the embed keeps its socket: computer status is pushed over it");
    for (const name of CHAT_ONLY) {
      assert.equal(probe.calls[name], 0, `an embed must not load ${name}`);
    }
    for (const name of KEPT) {
      assert.equal(probe.calls[name], 1, `an embed still loads ${name} exactly once`);
    }
  } finally {
    probe.restore();
    restoreTimers();
    restoreEmbed();
  }
});

test("the full app still boots every chat load", SERIAL, async () => {
  const restoreEmbed = __setEmbedModeForTests({ embedded: false, shell: "web" });
  const restoreTimers = __setBootUnreadFallbackMsForTests(60_000);
  const probe = countLoaders();
  try {
    const reconnects = await boot();
    assert.equal(reconnects, 1);
    for (const name of [...CHAT_ONLY, ...KEPT]) {
      assert.ok(probe.calls[name] >= 1, `the full app must still load ${name}`);
    }
    // Bootstrap and rooms:joined each own one channel-list read; every other
    // load has a single owner.
    assert.equal(probe.calls.channels, 2);
    for (const name of [...CHAT_ONLY, ...KEPT]) {
      if (name !== "channels") assert.equal(probe.calls[name], 1, `${name} is loaded exactly once`);
    }
  } finally {
    probe.restore();
    restoreTimers();
    restoreEmbed();
  }
});

test("an embed with a web-drawn header is not treated as chat-less", SERIAL, async () => {
  // `shell=web` embeds are not the native settings host; only host-shell skips.
  const restoreEmbed = __setEmbedModeForTests({ embedded: true, shell: "web" });
  const restoreTimers = __setBootUnreadFallbackMsForTests(60_000);
  const probe = countLoaders();
  try {
    await boot();
    assert.equal(probe.calls.channels, 2);
    assert.equal(probe.calls.inbox, 1);
  } finally {
    probe.restore();
    restoreTimers();
    restoreEmbed();
  }
});

test("the layout's first-screen announcements read reuses the server switch's read of the same server", SERIAL, async () => {
  const restoreEmbed = __setEmbedModeForTests({ embedded: false, shell: "web" });
  const restoreTimers = __setBootUnreadFallbackMsForTests(60_000);
  const realLoad = useAnnouncementStore.getState().load;
  const probe = countLoaders();
  // The real announcements store, its request counted at the API client.
  useAnnouncementStore.setState({ load: realLoad } as never);
  useServerStore.setState({ current: { id: "10000000-0000-4000-8000-0000000000aa" } as Server });
  const get = vi.spyOn(api, "get").mockResolvedValue({ data: { announcements: [] } });
  const announcementReads = () => get.mock.calls.filter(([url]) => url === "/announcements/active").length;
  try {
    // What the server switch runs (announcementStore's server reset).
    await useAnnouncementStore.getState().load();
    assert.equal(announcementReads(), 1);
    await boot();
    await Promise.resolve();
    assert.equal(announcementReads(), 1, "the bootstrap's read joins the one already made: ONE /announcements/active");
  } finally {
    get.mockRestore();
    probe.restore();
    useAnnouncementStore.getState().reset();
    useServerStore.setState({ current: null });
    restoreTimers();
    restoreEmbed();
  }
});

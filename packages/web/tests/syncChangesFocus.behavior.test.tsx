import "./helpers/domSetup";
import assert from "node:assert/strict";

import { vi } from "vitest";

import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useAnnouncementStore } from "../src/store/announcementStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { __setSyncPullJitterMsForTests, createMainLayoutRealtimeBridgeDriver } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useThreadStore } from "../src/store/threadStore";

/**
 * Coming back to the tab with incremental sync on (#triage:458d78f1): pull
 * sync/changes (the socket may never have dropped, so nothing else would) and
 * reload agents for presence; the other lists are not read again.
 */

const SERVER_ID = "srv-focus";

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  emit() { return undefined; }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  off() { return this; }
  onAny() { return this; }
  offAny() { return this; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
  fire(event: string) { for (const handler of this.handlers.get(event) ?? []) handler(); }
}

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function stubLoaders() {
  const calls: Record<string, number> = {};
  const count = (name: string) => async () => { calls[name] = (calls[name] ?? 0) + 1; };
  const saved = {
    message: { ...useMessageStore.getState() },
    server: { ...useServerStore.getState() },
    machine: { ...useMachineStore.getState() },
    agent: { ...useAgentStore.getState() },
    channel: { ...useChannelStore.getState() },
    thread: { ...useThreadStore.getState() },
    inbox: { ...useInboxStore.getState() },
    announcement: { ...useAnnouncementStore.getState() },
  };
  useMessageStore.setState({ loadUnreadCounts: count("unread"), markCurrentChannelRead: () => undefined } as never);
  useServerStore.setState({
    loadSidebarOrder: count("sidebarOrder"),
    loadServers: count("servers"),
    loadMembers: count("members"),
  } as never);
  useMachineStore.setState({ loadMachines: count("machines") } as never);
  useAgentStore.setState({ loadAgents: count("agents"), resetActivitySeq: () => undefined } as never);
  useChannelStore.setState({ loadChannels: count("channels"), loadDMChannels: count("dms") } as never);
  useThreadStore.setState({ loadFollowedThreads: count("followed") } as never);
  useInboxStore.setState({ loadInbox: count("inbox") } as never);
  useAnnouncementStore.setState({ load: count("announcements") } as never);
  return {
    calls,
    restore() {
      useMessageStore.setState(saved.message as never);
      useServerStore.setState(saved.server as never);
      useMachineStore.setState(saved.machine as never);
      useAgentStore.setState(saved.agent as never);
      useChannelStore.setState(saved.channel as never);
      useThreadStore.setState(saved.thread as never);
      useInboxStore.setState(saved.inbox as never);
      useAnnouncementStore.setState(saved.announcement as never);
    },
  };
}

function install() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const restorePull = __setSyncPullJitterMsForTests(2_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const syncCalls: Array<string | null> = [];
  let n = 0;
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { params?: { since?: string } }) => {
    if (url === "/sync/changes") {
      syncCalls.push(config?.params?.since ?? null);
      n += 1;
      return { data: { cursor: `c${n}`, hasMore: false, changes: [], reset: null } } as never;
    }
    return { data: [] } as never;
  });
  const savedCurrent = useServerStore.getState().current;
  useServerStore.setState({ current: { id: SERVER_ID, slug: "f", name: "F", role: "member", plan: "free" } } as never);
  const loaders = stubLoaders();
  localStorage.setItem("slock_access_token", "a");
  localStorage.setItem("slock_refresh_token", "r");
  const socket = new FakeSocket();
  const uninstall = createMainLayoutRealtimeBridgeDriver({
    getSocket: () => socket as never,
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  }).install();
  return {
    socket, syncCalls, calls: loaders.calls,
    restore() {
      uninstall();
      loaders.restore();
      localStorage.clear();
      useServerStore.setState({ current: savedCurrent } as never);
      get.mockRestore();
      random.mockRestore();
      restorePull();
      vi.useRealTimers();
      if (onLine) Object.defineProperty(navigator, "onLine", onLine);
      else delete (navigator as { onLine?: boolean }).onLine;
    },
  };
}

test("with a cursor (taken at the first reconnect): coming back to the tab pulls changes; sidebar order is not read again", async () => {
  const t = install();
  try {
    t.socket.fire("connect");
    await settle();
    t.socket.fire("connect");
    await settle();
    vi.advanceTimersByTime(20_000);
    await settle();
    assert.deepEqual(t.syncCalls, [null], "the cursor");
    const before = { ...t.calls };

    window.dispatchEvent(new window.Event("focus"));
    vi.advanceTimersByTime(2_000);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c1"], "focus pulls since the cursor");
    assert.equal(t.calls.agents, (before.agents ?? 0) + 1, "agents (presence)");
    assert.equal(t.calls.unread, (before.unread ?? 0) + 1, "unread as before");
    assert.equal(t.calls.machines, (before.machines ?? 0) + 1, "machines (online status is not in the log)");
    assert.equal(t.calls.sidebarOrder ?? 0, before.sidebarOrder ?? 0, "sidebar order not read again");
  } finally {
    t.restore();
  }
});

test("before the first reconnect (no cursor yet): coming back to the tab reloads in full", async () => {
  const t = install();
  try {
    t.socket.fire("connect");
    await settle();
    const before = { ...t.calls };
    window.dispatchEvent(new window.Event("focus"));
    vi.advanceTimersByTime(2_000);
    await settle();
    assert.deepEqual(t.syncCalls, []);
    assert.equal(t.calls.machines, (before.machines ?? 0) + 1);
    assert.equal(t.calls.sidebarOrder, (before.sidebarOrder ?? 0) + 1);
    assert.equal(t.calls.agents, (before.agents ?? 0) + 1);
  } finally {
    t.restore();
  }
});

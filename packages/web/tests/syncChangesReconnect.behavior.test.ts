import assert from "node:assert/strict";

import { AxiosError } from "axios";
import { vi } from "vitest";

import api from "../src/api/client";
import {
  __setReconnectReloadJitterMsForTests,
  __setSyncPullJitterMsForTests,
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
  SocketBinding,
} from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

/**
 * Reconnect with incremental sync: the first connect takes no cursor (it
 * reuses the boot lists); the first reconnect takes one before its snapshots;
 * later reconnects pull instead of the full reloads.
 *
 * (Harness copied from reconnectNoDuplicateLoads.behavior.test.ts.)
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
    loadServers: async (options?: { listOnly?: boolean }) => { calls.servers += 1; if (options?.listOnly) calls.serversListOnly = (calls.serversListOnly ?? 0) + 1; },
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


const SERVER_ID = "srv-sync";

function setup(responses: Array<() => unknown>) {
  vi.useFakeTimers();
  const restoreJitter = __setReconnectReloadJitterMsForTests(20_000);
  const restorePull = __setSyncPullJitterMsForTests(2_000);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const order: string[] = [];
  const syncCalls: Array<string | null> = [];
  const get = vi.spyOn(api, "get").mockImplementation(async (url: string, config?: { params?: { since?: string } }) => {
    if (url === "/sync/changes") {
      syncCalls.push(config?.params?.since ?? null);
      order.push("sync");
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return { data: next() } as never;
    }
    throw new Error(`unexpected GET ${url}`);
  });
  const savedServer = useServerStore.getState().current;
  useServerStore.setState({ current: { id: SERVER_ID, slug: "s", name: "S", role: "member", plan: "free" } } as never);
  const saved = {
    channels: useChannelStore.getState().loadChannels,
    dms: useChannelStore.getState().loadDMChannels,
    members: useServerStore.getState().loadMembers,
  };
  const probe = countLoaders();
  useChannelStore.setState({
    loadChannels: async () => { probe.calls.channels += 1; order.push("channels"); },
    loadDMChannels: async () => { probe.calls.dms = (probe.calls.dms ?? 0) + 1; order.push("dms"); },
  } as never);
  useServerStore.setState({ loadMembers: async () => { probe.calls.members = (probe.calls.members ?? 0) + 1; } } as never);
  useMachineStore.setState({ loadMachines: async () => { probe.calls.machines += 1; order.push("machines"); } } as never);
  return {
    probe, order, syncCalls,
    restore() {
      probe.restore();
      useChannelStore.setState({ loadChannels: saved.channels, loadDMChannels: saved.dms } as never);
      useServerStore.setState({ loadMembers: saved.members } as never);
      useServerStore.setState({ current: savedServer } as never);
      get.mockRestore();
      random.mockRestore();
      restorePull();
      restoreJitter();
      vi.useRealTimers();
    },
  };
}

const page = (cursor: string, changes: unknown[] = []) => () => ({ cursor, hasMore: false, changes, reset: null });
/** The client gave up after SYNC_CHANGES_TIMEOUT_MS (no answer). */
const timeout = () => () => { throw new AxiosError("timeout of 5000ms exceeded", "ECONNABORTED"); };
const httpError = (status: number, data: unknown = {}) => () => {
  throw new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, { status, data } as never);
};

async function settle() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/**
 * The first connect and first join (boot path, no cursor), then the first
 * reconnect, which takes the cursor and reads every list after it.
 */
async function startSync(connect: () => void, roomsJoined: () => void) {
  connect();
  roomsJoined();
  await settle();
  connect();
  roomsJoined();
  await settle();
  vi.advanceTimersByTime(20_000);
  await settle();
  await settle();
}

test("the first connect takes no cursor: its lists load at once, without GET /sync/changes", SERIAL, async () => {
  const t = setup([page("c0")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    connect();
    roomsJoined();
    assert.equal(t.probe.calls.machines, 1, "the connect snapshot loads at once");
    assert.equal(t.probe.calls.channels, 1, "the first join reads the channel list at once");
    await settle();
    vi.advanceTimersByTime(60_000);
    await settle();
    assert.deepEqual(t.syncCalls, [], "no cursor before the first reconnect");
  } finally {
    t.restore();
  }
});

test("sync on: a reconnect pulls changes instead of the full reloads; agents and servers still reload", SERIAL, async () => {
  const t = setup([page("c0"), page("c1", [{ seq: 1, entity: "machine", id: "m1", op: "delete" }])]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = { ...t.probe.calls };

    connect();
    roomsJoined();
    await settle();
    vi.advanceTimersByTime(999);
    await settle();
    assert.deepEqual(t.syncCalls, [null], "pull waits for its 0–2 s delay");
    vi.advanceTimersByTime(1);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0"]);
    assert.equal(t.probe.calls.machines, before.machines + 1, "the changed list reloads once");

    vi.advanceTimersByTime(20_000);
    await settle();
    assert.equal(t.probe.calls.agents, before.agents + 1, "agents reload (presence is not in the log)");
    assert.equal(t.probe.calls.servers, before.servers + 1, "servers reload (not in the log yet)");
    assert.equal(t.probe.calls.serversListOnly, (before.serversListOnly ?? 0) + 1, "the list only: members and sidebar order come through sync");
    for (const key of ["channels", "sidebarOrder", "followedThreads"]) {
      assert.equal(t.probe.calls[key], before[key], `${key} is not reloaded without a change`);
    }
    assert.equal(t.probe.calls.machines, before.machines + 2, "the changed list once, plus the online-status reload");
  } finally {
    t.restore();
  }
});

/** One reconnect: its pull (0–2 s) and its jittered reloads (0–20 s) all land. */
async function reconnect(connect: () => void, roomsJoined: () => void) {
  connect();
  roomsJoined();
  vi.advanceTimersByTime(2_000);
  await settle();
  vi.advanceTimersByTime(20_000);
  await settle();
}

/** The full reload a dropped cursor falls back to (the cursor's pull reads neither). */
const fullReloads = (calls: Record<string, number>) => ({ sidebarOrder: calls.sidebarOrder, channels: calls.channels });

test("sync on: one timed-out pull keeps the cursor and does not reload in full; the next reconnect pulls from it", SERIAL, async () => {
  const t = setup([page("c0"), timeout(), page("c1")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = fullReloads(t.probe.calls);
    await reconnect(connect, roomsJoined);
    assert.deepEqual(t.syncCalls, [null, "c0"]);
    assert.deepEqual(fullReloads(t.probe.calls), before, "no full reload after one transient failure");
    await reconnect(connect, roomsJoined);
    assert.deepEqual(t.syncCalls, [null, "c0", "c0"], "the next trigger pulls again from the kept cursor, no new cursor");
    assert.deepEqual(fullReloads(t.probe.calls), before);
    vi.advanceTimersByTime(120_000);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0", "c0"], "the trigger's pull replaced the delayed one");
  } finally {
    t.restore();
  }
});

test("sync on: a kept cursor is pulled once more 30–60 s later; failing there drops it and reloads in full once, no loop", SERIAL, async () => {
  // Math.random is 0.5 here: the delayed pull runs 45 s after the failed one has
  // settled (at 2 s, when the reconnect helper's first step lets promises run).
  const t = setup([page("c0"), timeout(), httpError(503), page("c5")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = fullReloads(t.probe.calls);
    await reconnect(connect, roomsJoined); // t = 22 s; the failure settled at 2 s
    assert.deepEqual(t.syncCalls, [null, "c0"]);
    vi.advanceTimersByTime(24_999);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0"], "not before 30 + 15 s");
    vi.advanceTimersByTime(1);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0", "c0"], "one delayed pull from the kept cursor");
    vi.advanceTimersByTime(20_000);
    await settle();
    assert.deepEqual(fullReloads(t.probe.calls), { sidebarOrder: before.sidebarOrder + 1, channels: before.channels + 1 });
    vi.advanceTimersByTime(300_000);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0", "c0"], "no further pulls");
    assert.deepEqual(fullReloads(t.probe.calls), { sidebarOrder: before.sidebarOrder + 1, channels: before.channels + 1 }, "reloaded once");
  } finally {
    t.restore();
  }
});

test("sync on: two failed pulls in a row on one cursor drop it and reload in full once", SERIAL, async () => {
  const t = setup([page("c0"), timeout(), httpError(503), page("c5")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = fullReloads(t.probe.calls);
    await reconnect(connect, roomsJoined);
    assert.deepEqual(fullReloads(t.probe.calls), before);
    await reconnect(connect, roomsJoined);
    assert.deepEqual(t.syncCalls, [null, "c0", "c0"]);
    assert.deepEqual(fullReloads(t.probe.calls), { sidebarOrder: before.sidebarOrder + 1, channels: before.channels + 1 });
    connect();
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0", "c0", null], "the next connect takes a new cursor");
  } finally {
    t.restore();
  }
});

test("sync on: invalid_cursor drops the cursor at once and falls back to the full jittered reloads", SERIAL, async () => {
  const t = setup([page("c0"), httpError(400, { error: "since must be a cursor this endpoint returned", code: "invalid_cursor" })]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = { ...t.probe.calls };
    await reconnect(connect, roomsJoined);
    assert.equal(t.probe.calls.machines, before.machines + 1);
    assert.equal(t.probe.calls.sidebarOrder, before.sidebarOrder + 1);
    assert.equal(t.probe.calls.channels, before.channels + 1);
  } finally {
    t.restore();
  }
});

test("the first reconnect starts sync: cursor first, then every list (DMs and members too) after it", SERIAL, async () => {
  const t = setup([page("c0"), page("c1")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    connect();
    roomsJoined();
    await settle();
    assert.deepEqual(t.syncCalls, [], "the first connect takes no cursor");
    const before = { ...t.probe.calls, dms: t.probe.calls.dms ?? 0, members: t.probe.calls.members ?? 0 };

    t.order.length = 0;
    connect();
    roomsJoined();
    await settle();
    assert.deepEqual(t.syncCalls, [null], "the cursor is taken at once");
    assert.equal(t.probe.calls.channels, before.channels, "no channel read before the cursor's jittered resnapshot");
    vi.advanceTimersByTime(20_000);
    await settle();
    await settle();
    assert.equal(t.order[0], "sync", "every list is read after the cursor");
    for (const key of ["channels", "dms", "members", "machines", "agents", "sidebarOrder", "followedThreads", "unread", "inbox"]) {
      assert.ok((t.probe.calls[key] ?? 0) > (before as Record<string, number>)[key], `${key} read after the cursor`);
    }

    // The next reconnect pulls.
    connect();
    vi.advanceTimersByTime(2_000);
    await settle();
    assert.deepEqual(t.syncCalls, [null, "c0"]);
  } finally {
    t.restore();
  }
});

test("a session for another server is replaced, not reused", SERIAL, async () => {
  const t = setup([page("c0"), page("x0"), page("x1")]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    // Same bridge, different current server (no teardown in between).
    useServerStore.setState({ current: { id: "srv-other", slug: "o", name: "O", role: "member", plan: "free" } } as never);
    connect();
    await settle();
    assert.deepEqual(t.syncCalls, [null, null], "a new cursor for the other server, not a pull with c0");
  } finally {
    t.restore();
  }
});

test("sync on: a reset reads agents/servers once, in the same batch as the reconnect reload", SERIAL, async () => {
  const t = setup([
    page("c0"),
    () => ({ cursor: "c1", hasMore: false, changes: [], reset: { reason: "forced", snapshots: ["agents", "server_order", "machines"] } }),
  ]);
  try {
    const { connect, roomsJoined } = bind(new FakeSocket());
    await startSync(connect, roomsJoined);
    const before = { ...t.probe.calls };
    connect();
    roomsJoined();
    vi.advanceTimersByTime(2_000);
    await settle();
    vi.advanceTimersByTime(20_000);
    await settle();
    await settle();
    assert.equal(t.probe.calls.agents, before.agents + 1, "agents once");
    assert.equal(t.probe.calls.servers, before.servers + 1, "servers once");
    assert.equal(t.probe.calls.machines, before.machines + 1, "the reset's other lists are read");
  } finally {
    t.restore();
  }
});

import { strict as assert } from "node:assert";
import test from "node:test";
import api from "../src/api/client";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import {
  LEGACY_SERVER_ID_STORAGE_KEY,
  LAST_SERVER_SLUG_STORAGE_KEY,
  serverPersistence,
} from "../src/store/serverPersistenceRegistry";
import {
  useServerStore,
} from "../src/store/serverStore";
import type {
  Server,
  ServerMember,
  SidebarOrderPreferences,
} from "../src/store/serverStore";
import { registerServerReset } from "../src/store/serverResetRegistry";

const storageValues = new Map<string, string>();
const storageStub = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => void storageValues.set(key, value),
  removeItem: (key: string) => void storageValues.delete(key),
  clear: () => storageValues.clear(),
  key: () => null,
  length: 0,
} as Storage;

if (typeof (globalThis as { localStorage?: Storage }).localStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storageStub,
  });
}

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: "server-1",
    name: "Core",
    avatarUrl: null,
    slug: "core",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function member(overrides: Partial<ServerMember> = {}): ServerMember {
  return {
    userId: "user-1",
    serverId: "server-1",
    serverName: "Core",
    serverSlug: "core",
    email: null,
    gravatarHash: "hash",
    name: "User",
    displayName: null,
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function sidebar(overrides: Partial<SidebarOrderPreferences> = {}): SidebarOrderPreferences {
  return {
    ...DEFAULT_SIDEBAR_ORDER,
    channelOrder: ["channel-1"],
    agentOrder: ["agent-1"],
    dmOrder: ["dm-1"],
    pinned: [
      { kind: "channel", id: "channel-1" },
      { kind: "agent", id: "agent-1" },
    ],
    pinnedChannelIds: ["channel-1"],
    pinnedAgentIds: ["agent-1"],
    pinnedOrder: ["channel:channel-1"],
    hiddenDmIds: ["dm-hidden"],
    channelPanelTabOrder: ["joint", "channels"],
    agentPanelTabOrder: ["agents"],
    ...overrides,
  };
}

function resetStore() {
  storageValues.clear();
  globalThis.localStorage?.clear?.();
  useServerStore.setState({
    servers: [],
    current: null,
    members: [],
    membersLoadError: false,
    loading: true,
    usage: null,
    loadingUsage: false,
    billing: null,
    loadingBilling: false,
    settings: null,
    loadingSettings: false,
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
    serverEpoch: 0,
  });
}

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("[RED T5-server] setCurrent uses the server persistence registry and domain fold", async (t) => {
  resetStore();
  t.mock.method(api, "get", async (url: string) => {
    if (url.endsWith("/members")) return { data: [] };
    if (url.endsWith("/sidebar-order")) return { data: {} };
    if (url.endsWith("/settings")) {
      return {
        data: {
          settings: {
            onboardSettings: {},
            feedbackSettings: { enabled: true },
          },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  useServerStore.setState({
    servers: [server()],
    members: [{ userId: "u-1" } as never],
    usage: { agents: 1, machines: 1, channels: 1 },
    billing: { plan: "free" } as never,
    sidebarOrder: {
      ...useServerStore.getState().sidebarOrder,
      channelOrder: ["channel-1"],
    },
  });

  useServerStore.getState().setCurrent(server());
  await flushAsyncWork();

  assert.equal(serverPersistence.readLastServerSlug(), "core");
  assert.equal(globalThis.localStorage.getItem(LAST_SERVER_SLUG_STORAGE_KEY), "core");
  assert.equal(useServerStore.getState().current?.id, "server-1");
  assert.equal(useServerStore.getState().serverEpoch, 1);
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().settings?.feedbackSettings.enabled, true);
  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, []);
});

test("server settings fail closed when feedback settings are absent", async (t) => {
  resetStore();
  useServerStore.setState({ current: server(), serverEpoch: 1 });
  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/servers/server-1/settings");
    return { data: { settings: { onboardSettings: {} } } };
  });

  const settings = await useServerStore.getState().loadSettings();

  assert.equal(settings?.feedbackSettings.enabled, false);
  assert.equal(useServerStore.getState().settings?.feedbackSettings.enabled, false);
});

test("[RED T5-server] loadServers clears legacy id, refreshes current facts, and starts server loaders", async (t) => {
  resetStore();
  const refreshed = server({ name: "Core Team", plan: "team" });
  globalThis.localStorage.setItem(LEGACY_SERVER_ID_STORAGE_KEY, "legacy-server");
  useServerStore.setState({
    current: server({ name: "Core Old", plan: "free" }),
    serverEpoch: 4,
    loading: true,
  });

  const getUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    getUrls.push(url);
    if (url === "/servers") return { data: [refreshed] };
    if (url === "/servers/server-1/members") return { data: [member()] };
    if (url === "/servers/server-1/sidebar-order") {
      return { data: sidebar({ channelOrder: ["loaded-channel"], dmSortMode: "az" }) };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  await useServerStore.getState().loadServers();
  await flushAsyncWork();

  assert.equal(globalThis.localStorage.getItem(LEGACY_SERVER_ID_STORAGE_KEY), null);
  assert.equal(useServerStore.getState().loading, false);
  assert.equal(useServerStore.getState().current?.name, "Core Team");
  assert.equal(useServerStore.getState().current?.plan, "team");
  assert.equal(useServerStore.getState().serverEpoch, 4);
  assert.deepEqual(useServerStore.getState().members.map((item) => item.userId), ["user-1"]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, ["loaded-channel"]);
  assert.equal(useServerStore.getState().sidebarOrder.dmSortMode, "az");
  assert.deepEqual(getUrls, [
    "/servers",
    "/servers/server-1/members",
    "/servers/server-1/sidebar-order",
  ]);
});

test("[RED T5-server] updateServerOrder de-dupes requested ids and applies saved order from source of truth", async (t) => {
  resetStore();
  const first = server({ id: "a", slug: "a", name: "A" });
  const second = server({ id: "b", slug: "b", name: "B" });
  const third = server({ id: "c", slug: "c", name: "C" });
  useServerStore.setState({ servers: [first, second, third] });

  t.mock.method(api, "patch", async (url: string, body: { serverOrder: string[] }) => {
    assert.equal(url, "/servers/order");
    assert.deepEqual(body.serverOrder, ["b", "a", "c"]);
    return { data: { serverOrder: ["c", "a", "c", 17, "missing"] } };
  });

  await useServerStore.getState().updateServerOrder(["b", "a", "b", "missing"]);

  assert.deepEqual(useServerStore.getState().servers.map((item) => item.id), ["c", "a", "b"]);
});

test("[RED T5-server] updateServerOrder rolls back to the prior list when persistence fails", async (t) => {
  resetStore();
  const first = server({ id: "a", slug: "a", name: "A" });
  const second = server({ id: "b", slug: "b", name: "B" });
  const third = server({ id: "c", slug: "c", name: "C" });
  useServerStore.setState({ servers: [first, second, third] });

  t.mock.method(api, "patch", async () => {
    throw new Error("order save failed");
  });

  await useServerStore.getState().updateServerOrder(["c", "b"]);

  assert.deepEqual(useServerStore.getState().servers.map((item) => item.id), ["a", "b", "c"]);
});

test("[RED T5-server] updateServerOrder treats a null save body as accepting the optimistic order", async (t) => {
  resetStore();
  const first = server({ id: "a", slug: "a", name: "A" });
  const second = server({ id: "b", slug: "b", name: "B" });
  const third = server({ id: "c", slug: "c", name: "C" });
  useServerStore.setState({ servers: [first, second, third] });

  t.mock.method(api, "patch", async () => ({ data: null }));

  await useServerStore.getState().updateServerOrder(["c", "b"]);

  assert.deepEqual(useServerStore.getState().servers.map((item) => item.id), ["c", "b", "a"]);
});

test("[RED T5-server] clearCurrent resets request-shaped slices and is idempotent when no current exists", () => {
  resetStore();
  let resetCount = 0;
  registerServerReset(() => {
    resetCount += 1;
  });
  useServerStore.setState({
    current: server(),
    members: [member()],
    usage: { agents: 2, machines: 3, channels: 4 },
    loadingUsage: true,
    billing: { plan: "team" } as never,
    loadingBilling: true,
    sidebarOrder: sidebar({ channelOrder: ["dirty-channel"] }),
    serverEpoch: 8,
  });

  useServerStore.getState().clearCurrent();

  assert.equal(useServerStore.getState().current, null);
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().loadingUsage, false);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().loadingBilling, false);
  assert.deepEqual(useServerStore.getState().sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(useServerStore.getState().serverEpoch, 9);
  assert.equal(resetCount, 1);

  useServerStore.getState().clearCurrent();
  assert.equal(useServerStore.getState().serverEpoch, 9);
  assert.equal(resetCount, 1);
});

test("[RED T5-server] createServer adds owner role and enters the same switch path as setCurrent", async (t) => {
  resetStore();
  const created = server({ id: "created", slug: "created", name: "Created", role: "member" });
  const getUrls: string[] = [];

  t.mock.method(api, "post", async (url: string, body: { name: string; slug: string }) => {
    assert.equal(url, "/servers");
    assert.deepEqual(body, { name: "Created", slug: "created" });
    return { data: created };
  });
  t.mock.method(api, "get", async (url: string) => {
    getUrls.push(url);
    if (url.endsWith("/members")) return { data: [] };
    if (url.endsWith("/sidebar-order")) return { data: {} };
    if (url.endsWith("/settings")) return { data: { settings: { onboardSettings: {}, feedbackSettings: { enabled: false } } } };
    throw new Error(`unexpected GET ${url}`);
  });

  const result = await useServerStore.getState().createServer("Created", "created");
  await flushAsyncWork();

  assert.equal(result.role, "owner");
  assert.equal(useServerStore.getState().current?.id, "created");
  assert.equal(useServerStore.getState().current?.role, "owner");
  assert.equal(useServerStore.getState().serverEpoch, 1);
  assert.equal(serverPersistence.readLastServerSlug(), "created");
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().loadingUsage, true);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().loadingBilling, true);
  assert.deepEqual(getUrls, [
    "/servers/created/members",
    "/servers/created/sidebar-order",
    "/servers/created/settings",
  ]);
});

test("[RED T5-server] joinCommunityServer reloads full server truth and throws if the joined slug is missing", async (t) => {
  resetStore();
  const community = server({ id: "community-id", slug: "community-cn", name: "Community CN", role: "member" });
  let includeJoined = true;

  t.mock.method(api, "post", async (url: string, body: { agreementId?: string | null; slug: string }) => {
    assert.equal(url, "/servers/join-community");
    assert.deepEqual(body, { agreementId: "agreement-1", slug: "community-cn" });
    return { data: { id: "ignored" } };
  });
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers") return { data: includeJoined ? [community] : [] };
    if (url.endsWith("/members")) return { data: [] };
    if (url.endsWith("/sidebar-order")) return { data: {} };
    throw new Error(`unexpected GET ${url}`);
  });

  const joined = await useServerStore.getState().joinCommunityServer({
    agreementId: "agreement-1",
    slug: "community-cn",
  });
  await flushAsyncWork();

  assert.equal(joined, community);
  assert.equal(useServerStore.getState().current, community);
  assert.equal(serverPersistence.readLastServerSlug(), "community-cn");

  resetStore();
  includeJoined = false;
  await assert.rejects(
    useServerStore.getState().joinCommunityServer({ agreementId: "agreement-1", slug: "community-cn" }),
    /server\.community\.missingAfterJoin/,
  );
});

test("[RED T5-server] profile, avatar, and push patches update known servers without creating unknown entries", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Old", avatarUrl: "/old.png" });
  const other = server({ id: "other", slug: "other", name: "Other" });
  useServerStore.setState({ servers: [current, other], current, serverEpoch: 2 });

  t.mock.method(api, "patch", async (url: string, body: unknown) => {
    assert.equal(url, "/servers/current");
    assert.deepEqual(body, { name: "New", hideHumansFromMembers: true });
    return { data: { name: "New", avatarUrl: "/profile.png", hideHumansFromMembers: true } };
  });
  t.mock.method(api, "post", async (url: string, body: FormData) => {
    assert.equal(url, "/servers/current/avatar");
    assert.equal(typeof body.get, "function");
    return { data: { avatarUrl: "/avatar.png" } };
  });

  await useServerStore.getState().updateServerProfile({ name: "New", hideHumansFromMembers: true });
  assert.equal(useServerStore.getState().current?.name, "New");
  assert.equal(useServerStore.getState().current?.avatarUrl, "/profile.png");
  assert.equal(useServerStore.getState().current?.hideHumansFromMembers, true);
  assert.equal(useServerStore.getState().servers.find((item) => item.id === "current")?.name, "New");

  await useServerStore.getState().uploadServerAvatar(new Blob(["avatar"], { type: "image/png" }) as File);
  assert.equal(useServerStore.getState().current?.avatarUrl, "/avatar.png");

  useServerStore.getState().applyServerPatch({ id: "other", plan: "team" });
  useServerStore.getState().applyServerPatch({ id: "missing", plan: "enterprise" });
  assert.equal(useServerStore.getState().servers.find((item) => item.id === "other")?.plan, "team");
  assert.equal(useServerStore.getState().servers.some((item) => item.id === "missing"), false);
  assert.equal(useServerStore.getState().serverEpoch, 2);
});

test("[RED T5-server] unknown server patches are silent no-ops at the store boundary", () => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const previousSidebar = sidebar({ channelOrder: ["stable"] });
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 5,
    sidebarOrder: previousSidebar,
  });
  const previous = useServerStore.getState();
  let notifications = 0;
  const unsubscribe = useServerStore.subscribe(() => {
    notifications += 1;
  });

  try {
    useServerStore.getState().applyServerPatch({ id: "missing", plan: "team" });
  } finally {
    unsubscribe();
  }

  assert.equal(notifications, 0);
  assert.equal(useServerStore.getState().servers, previous.servers);
  assert.equal(useServerStore.getState().current, previous.current);
  assert.equal(useServerStore.getState().sidebarOrder, previousSidebar);
  assert.equal(useServerStore.getState().serverEpoch, 5);
});

test("[RED T5-server] leaveServer removes current membership, clears matching slug, and resets server slices", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const other = server({ id: "other", slug: "other", name: "Other" });
  useServerStore.setState({
    servers: [current, other],
    current,
    members: [member({ serverId: "current" })],
    usage: { agents: 1, machines: 1, channels: 1 },
    loadingUsage: true,
    billing: { plan: "free" } as never,
    loadingBilling: true,
    sidebarOrder: sidebar({ channelOrder: ["dirty"] }),
    serverEpoch: 3,
  });
  serverPersistence.writeLastServerSlug("current");

  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/servers/current/leave");
    return { data: {} };
  });

  await useServerStore.getState().leaveServer();

  assert.deepEqual(useServerStore.getState().servers.map((item) => item.id), ["other"]);
  assert.equal(useServerStore.getState().current, null);
  assert.equal(serverPersistence.readLastServerSlug(), null);
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().loadingUsage, false);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().loadingBilling, false);
  assert.deepEqual(useServerStore.getState().sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(useServerStore.getState().serverEpoch, 4);
});

test("[RED T5-server] deleteServer mirrors leave semantics through the delete endpoint", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  useServerStore.setState({
    servers: [current],
    current,
    members: [member({ serverId: "current" })],
    usage: { agents: 1, machines: 1, channels: 1 },
    loadingUsage: true,
    billing: { plan: "free" } as never,
    loadingBilling: true,
    sidebarOrder: sidebar({ channelOrder: ["dirty"] }),
    serverEpoch: 6,
  });
  serverPersistence.writeLastServerSlug("current");

  t.mock.method(api, "delete", async (url: string) => {
    assert.equal(url, "/servers/current");
    return { data: {} };
  });

  await useServerStore.getState().deleteServer();

  assert.deepEqual(useServerStore.getState().servers, []);
  assert.equal(useServerStore.getState().current, null);
  assert.equal(serverPersistence.readLastServerSlug(), null);
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().loadingUsage, false);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().loadingBilling, false);
  assert.deepEqual(useServerStore.getState().sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(useServerStore.getState().serverEpoch, 7);
});

test("[RED T5-server] handleMembershipRemoved reconciles servers, clears current, and forgets stale slug", async (t) => {
  resetStore();
  let resetCount = 0;
  registerServerReset(() => {
    resetCount += 1;
  });
  const removed = server({ id: "removed", slug: "removed", name: "Removed" });
  const kept = server({ id: "kept", slug: "kept", name: "Kept" });
  useServerStore.setState({
    servers: [removed, kept],
    current: removed,
    members: [member({ serverId: "removed" })],
    usage: { agents: 1, machines: 2, channels: 3 },
    loadingUsage: true,
    billing: { plan: "free" } as never,
    loadingBilling: true,
    sidebarOrder: sidebar({ channelOrder: ["dirty"] }),
    serverEpoch: 2,
  });
  serverPersistence.writeLastServerSlug("removed");

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers") return { data: [kept] };
    throw new Error(`unexpected GET ${url}`);
  });

  const removedCurrent = await useServerStore.getState().handleMembershipRemoved("removed");

  assert.equal(removedCurrent, true);
  assert.deepEqual(useServerStore.getState().servers.map((item) => item.id), ["kept"]);
  assert.equal(useServerStore.getState().current, null);
  assert.equal(useServerStore.getState().serverEpoch, 3);
  assert.equal(serverPersistence.readLastServerSlug(), null);
  assert.deepEqual(useServerStore.getState().members, []);
  assert.equal(useServerStore.getState().usage, null);
  assert.equal(useServerStore.getState().loadingUsage, false);
  assert.equal(useServerStore.getState().billing, null);
  assert.equal(useServerStore.getState().loadingBilling, false);
  assert.deepEqual(useServerStore.getState().sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(resetCount, 1);
});

test("[RED T5-server] handleMembershipRemoved preserves current state for non-current and still-member cases", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const other = server({ id: "other", slug: "other", name: "Other" });
  const retainedSidebar = sidebar({ channelOrder: ["keep"] });
  useServerStore.setState({
    servers: [current, other],
    current,
    members: [member({ serverId: "current" })],
    usage: { agents: 7, machines: 8, channels: 9 },
    loadingUsage: true,
    billing: { plan: "team" } as never,
    loadingBilling: true,
    serverEpoch: 10,
    sidebarOrder: retainedSidebar,
  });
  serverPersistence.writeLastServerSlug("current");

  let serverLoads = 0;
  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers") {
      serverLoads += 1;
      return { data: serverLoads === 1 ? [current] : [current, other] };
    }
    if (url === "/servers/current/members") return { data: [member({ serverId: "current" })] };
    if (url === "/servers/current/sidebar-order") return { data: retainedSidebar };
    throw new Error(`unexpected GET ${url}`);
  });

  const nonCurrentRemoved = await useServerStore.getState().handleMembershipRemoved("other");
  assert.equal(nonCurrentRemoved, false);
  assert.equal(useServerStore.getState().current?.id, "current");
  assert.equal(useServerStore.getState().serverEpoch, 10);
  assert.equal(serverPersistence.readLastServerSlug(), "current");
  assert.deepEqual(useServerStore.getState().members.map((item) => item.userId), ["user-1"]);
  assert.equal(useServerStore.getState().usage?.agents, 7);
  assert.equal(useServerStore.getState().loadingUsage, true);
  assert.equal(useServerStore.getState().billing?.plan, "team");
  assert.equal(useServerStore.getState().loadingBilling, true);
  await flushAsyncWork();
  assert.deepEqual(useServerStore.getState().sidebarOrder, retainedSidebar);

  const stillMember = await useServerStore.getState().handleMembershipRemoved("current");
  assert.equal(stillMember, false);
  assert.equal(useServerStore.getState().current?.id, "current");
  assert.equal(useServerStore.getState().serverEpoch, 10);
  assert.equal(serverPersistence.readLastServerSlug(), "current");
});

test("[RED T5-server] handleMembershipRemoved reloads and returns false when no current server is selected", async (t) => {
  resetStore();
  const kept = server({ id: "kept", slug: "kept", name: "Kept" });
  useServerStore.setState({ servers: [], current: null, loading: true, serverEpoch: 12 });

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/servers") return { data: [kept] };
    throw new Error(`unexpected GET ${url}`);
  });

  const result = await useServerStore.getState().handleMembershipRemoved("kept");

  assert.equal(result, false);
  assert.deepEqual(useServerStore.getState().servers, [kept]);
  assert.equal(useServerStore.getState().current, null);
  assert.equal(useServerStore.getState().serverEpoch, 12);
  assert.equal(useServerStore.getState().loading, false);
});

test("[RED T5-server] loadSidebarOrder normalizes payloads and falls back only for the active epoch", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: sidebar({ channelOrder: ["dirty"] }),
  });

  t.mock.method(api, "get", async (url: string) => {
    assert.equal(url, "/servers/current/sidebar-order");
    return {
      data: {
        channelOrder: ["channel-loaded"],
        agentOrder: "bad",
        dmOrder: ["dm-loaded"],
        channelSortMode: "az",
        jointChannelSortMode: "recent",
        dmSortMode: "bad",
        pinnedSortMode: "manual",
        pinned: [{ kind: "channel", id: "pin-channel" }],
        pinnedChannelIds: ["pin-channel"],
        pinnedAgentIds: 42,
        pinnedOrder: ["channel:pin-channel"],
        hiddenDmIds: ["dm-hidden"],
        channelPanelTabOrder: "bad",
        agentPanelTabOrder: ["agents"],
      },
    };
  });

  await useServerStore.getState().loadSidebarOrder();

  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, ["channel-loaded"]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.agentOrder, []);
  assert.deepEqual(useServerStore.getState().sidebarOrder.dmOrder, ["dm-loaded"]);
  assert.equal(useServerStore.getState().sidebarOrder.channelSortMode, "az");
  assert.equal(useServerStore.getState().sidebarOrder.jointChannelSortMode, "recent");
  assert.equal(useServerStore.getState().sidebarOrder.dmSortMode, "manual");
  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, [{ kind: "channel", id: "pin-channel" }]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.pinnedChannelIds, ["pin-channel"]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.pinnedAgentIds, []);
  assert.deepEqual(useServerStore.getState().sidebarOrder.channelPanelTabOrder, []);
  assert.deepEqual(useServerStore.getState().sidebarOrder.agentPanelTabOrder, ["agents"]);
});

test("[RED T5-server] loadSidebarOrder discards stale success and stale failure responses", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const pending = defer<{ data: SidebarOrderPreferences }>();
  const retained = sidebar({ channelOrder: ["retained"] });
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: retained,
  });

  t.mock.method(api, "get", async () => pending.promise);

  const load = useServerStore.getState().loadSidebarOrder();
  useServerStore.setState({ serverEpoch: 5, sidebarOrder: retained });
  pending.resolve({ data: sidebar({ channelOrder: ["stale"] }) });
  await load;

  assert.equal(useServerStore.getState().sidebarOrder, retained);

  const failed = defer<{ data: SidebarOrderPreferences }>();
  t.mock.reset();
  t.mock.method(api, "get", async () => failed.promise);
  const failureLoad = useServerStore.getState().loadSidebarOrder();
  useServerStore.setState({ serverEpoch: 6, sidebarOrder: retained });
  failed.reject(new Error("late failure"));
  await failureLoad;

  assert.equal(useServerStore.getState().sidebarOrder, retained);
});

test("[RED T5-server] loadSidebarOrder failure restores the default order for the still-active epoch", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: sidebar({ channelOrder: ["dirty"] }),
  });

  t.mock.method(api, "get", async () => {
    throw new Error("sidebar failed");
  });

  await useServerStore.getState().loadSidebarOrder();

  assert.deepEqual(useServerStore.getState().sidebarOrder, DEFAULT_SIDEBAR_ORDER);
});

test("[RED T5-server] updateSidebarOrder rolls back failed writes only while still on the same server", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const original = sidebar({ channelOrder: ["original"] });
  const pending = defer<{ data: unknown }>();
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: original,
  });

  t.mock.method(api, "patch", async (url: string, body: Partial<SidebarOrderPreferences>) => {
    assert.equal(url, "/servers/current/sidebar-order");
    assert.deepEqual(body, { channelOrder: ["optimistic"] });
    return pending.promise;
  });

  const update = useServerStore.getState().updateSidebarOrder({ channelOrder: ["optimistic"] });
  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, ["optimistic"]);
  pending.reject(new Error("save failed"));
  await update;

  assert.equal(useServerStore.getState().sidebarOrder, original);
});

test("updateSidebarOrder preserves typed pinned refs through unrelated sparse writes", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const originalPinned: SidebarOrderPreferences["pinned"] = [
    { kind: "human", id: "human-1" },
    { kind: "agent", id: "agent-1" },
  ];
  const original = sidebar({ pinned: originalPinned, channelOrder: ["original"] });
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: original,
  });

  t.mock.method(api, "patch", async (url: string, body: Partial<SidebarOrderPreferences>) => {
    assert.equal(url, "/servers/current/sidebar-order");
    assert.deepEqual(body, { channelOrder: ["optimistic"] });
    return { data: { channelOrder: ["server-confirmed"] } };
  });

  await useServerStore.getState().updateSidebarOrder({ channelOrder: ["optimistic"] });

  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, ["server-confirmed"]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.pinned, originalPinned);
});

test("updateSidebarOrder serializes section writes with the latest confirmed version", async (t) => {
  resetStore();
  const current = server({ id: "current", slug: "current", name: "Current" });
  const original = sidebar({
    customSections: [],
    sectionOrder: ["system:pinned", "system:channels"],
    sectionPlacements: [],
    sectionsVersion: 0,
  });
  const createdSection = {
    id: "section-1",
    name: "Launch",
    emoji: null,
    sortMode: "manual" as const,
  };
  const createdOrder = ["system:pinned", "section-1", "system:channels"];
  const placement = {
    kind: "channel" as const,
    id: "channel-1",
    sectionId: "section-1",
    position: 0,
  };
  const createPending = defer<{ data: Partial<SidebarOrderPreferences> }>();
  const movePending = defer<{ data: Partial<SidebarOrderPreferences> }>();
  const requests: Partial<SidebarOrderPreferences>[] = [];
  useServerStore.setState({
    servers: [current],
    current,
    serverEpoch: 4,
    sidebarOrder: original,
  });

  t.mock.method(api, "patch", async (url: string, body: Partial<SidebarOrderPreferences>) => {
    assert.equal(url, "/servers/current/sidebar-order");
    requests.push(body);
    if (requests.length === 1) return createPending.promise;
    return movePending.promise;
  });

  const create = useServerStore.getState().updateSidebarOrder({
    customSections: [createdSection],
    sectionOrder: createdOrder,
    sectionPlacements: [],
  });
  const move = useServerStore.getState().updateSidebarOrder({
    pinned: [],
    sectionPlacements: [placement],
  });

  await flushAsyncWork();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.sectionsVersion, 0);
  assert.deepEqual(useServerStore.getState().sidebarOrder.customSections, [createdSection]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.sectionPlacements, [placement]);

  createPending.resolve({
    data: {
      customSections: [createdSection],
      sectionOrder: createdOrder,
      sectionPlacements: [],
      sectionsVersion: 1,
    },
  });
  await create;
  await flushAsyncWork();

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.sectionsVersion, 1);
  assert.deepEqual(useServerStore.getState().sidebarOrder.customSections, [createdSection]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.sectionPlacements, [placement]);
  assert.equal(useServerStore.getState().sidebarOrder.sectionsVersion, 1);

  movePending.resolve({
    data: {
      ...requests[1],
      customSections: [createdSection],
      sectionOrder: createdOrder,
      sectionsVersion: 2,
    },
  });
  await move;

  assert.deepEqual(useServerStore.getState().sidebarOrder.customSections, [createdSection]);
  assert.deepEqual(useServerStore.getState().sidebarOrder.sectionPlacements, [placement]);
  assert.equal(useServerStore.getState().sidebarOrder.sectionsVersion, 2);
});

test("[RED T5-server] updateSidebarOrder keeps a newer server's sidebar when an old write fails", async (t) => {
  resetStore();
  const first = server({ id: "first", slug: "first", name: "First" });
  const second = server({ id: "second", slug: "second", name: "Second" });
  const firstSidebar = sidebar({ channelOrder: ["first-original"] });
  const secondSidebar = sidebar({ channelOrder: ["second-current"] });
  const pending = defer<{ data: unknown }>();
  useServerStore.setState({
    servers: [first, second],
    current: first,
    serverEpoch: 4,
    sidebarOrder: firstSidebar,
  });

  t.mock.method(api, "patch", async () => pending.promise);

  const update = useServerStore.getState().updateSidebarOrder({ channelOrder: ["first-optimistic"] });
  assert.deepEqual(useServerStore.getState().sidebarOrder.channelOrder, ["first-optimistic"]);
  useServerStore.setState({ current: second, serverEpoch: 5, sidebarOrder: secondSidebar });
  pending.reject(new Error("save failed"));
  await update;

  assert.equal(useServerStore.getState().sidebarOrder, secondSidebar);
  assert.equal(useServerStore.getState().current?.id, "second");
});

// Guards the single-source-of-truth / single-flight behavior added for the
// duplicate `unread-summary` / `sidebar-order` fetches: concurrent callers must
// share ONE request instead of issuing one each.

import { strict as assert } from "node:assert";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: "server-1",
    name: "Core",
    slug: "core",
    avatarUrl: null,
    ownerId: "user-1",
    role: "owner",
    ...overrides,
  } as Server;
}

test("concurrent unread-summary loads coalesce into a single request", async () => {
  const original = api.get;
  let unreadCalls = 0;
  api.get = (async (path: string) => {
    if (path === "/servers/unread-summary") {
      unreadCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { data: [{ serverId: "server-1", unreadCount: 2, serverPushMuted: false }] };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server(), serverUnreadCounts: {} });
    await Promise.all([
      useServerStore.getState().loadServerUnreadSummary(),
      useServerStore.getState().loadServerUnreadSummary(),
      useServerStore.getState().loadServerUnreadSummary(),
    ]);
    assert.equal(unreadCalls, 1, "three concurrent loads must share one request");
    assert.equal(useServerStore.getState().serverUnreadCounts["server-1"]?.unreadCount, 2);
  } finally {
    api.get = original;
    useServerStore.setState({ serverUnreadCounts: {}, current: null, servers: [] });
  }
});

test("concurrent sidebar-order loads coalesce into a single request", async () => {
  const original = api.get;
  let sidebarCalls = 0;
  api.get = (async (path: string) => {
    if (path.endsWith("/sidebar-order")) {
      sidebarCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { data: DEFAULT_SIDEBAR_ORDER };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server() });
    await Promise.all([
      useServerStore.getState().loadSidebarOrder(),
      useServerStore.getState().loadSidebarOrder(),
      useServerStore.getState().loadSidebarOrder(),
    ]);
    assert.equal(sidebarCalls, 1, "three concurrent loads must share one request");
  } finally {
    api.get = original;
    useServerStore.setState({ current: null, servers: [] });
  }
});

test("a later load after completion issues a fresh request (coalescing is not a cache)", async () => {
  const original = api.get;
  let unreadCalls = 0;
  api.get = (async (path: string) => {
    if (path === "/servers/unread-summary") {
      unreadCalls += 1;
      return { data: [{ serverId: "server-1", unreadCount: 1, serverPushMuted: false }] };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server(), serverUnreadCounts: {} });
    await useServerStore.getState().loadServerUnreadSummary();
    await useServerStore.getState().loadServerUnreadSummary();
    assert.equal(unreadCalls, 2, "sequential loads each fetch once");
  } finally {
    api.get = original;
    useServerStore.setState({ serverUnreadCounts: {}, current: null, servers: [] });
  }
});

test("a membership-removal re-read does not trust a server-list read already in flight", async () => {
  // The stale read started before the removal committed and still lists the
  // server. Joining it would keep the removed user on the server.
  const original = api.get;
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  let serverListCalls = 0;
  api.get = (async (path: string) => {
    if (path === "/servers") {
      serverListCalls += 1;
      if (serverListCalls === 1) {
        await staleGate;
        return { data: [server()] };
      }
      return { data: [] };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server() });
    const staleRead = useServerStore.getState().loadServers();
    const removal = useServerStore.getState().handleMembershipRemoved("server-1");
    releaseStale();
    await staleRead;

    assert.equal(await removal, true, "the removal must be decided on a read issued after it");
    assert.equal(serverListCalls, 2);
    assert.equal(useServerStore.getState().current, null);
  } finally {
    api.get = original;
    useServerStore.setState({ current: null, servers: [] });
  }
});

test("a membership removal does not reset a server the user switched to meanwhile", async () => {
  const original = api.get;
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const other = server({ id: "server-2", slug: "other" });
  api.get = (async (path: string) => {
    if (path === "/servers") {
      await readGate;
      return { data: [other] };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server(), other], current: server() });
    const removal = useServerStore.getState().handleMembershipRemoved("server-1");
    useServerStore.setState({ current: other });
    releaseRead();

    assert.equal(await removal, false);
    assert.equal(useServerStore.getState().current?.id, "server-2");
  } finally {
    api.get = original;
    useServerStore.setState({ current: null, servers: [] });
  }
});

test("concurrent billing loads coalesce into a single request (task #17)", async () => {
  const original = api.get;
  let billingCalls = 0;
  api.get = (async (path: string) => {
    if (path === "/billing/subscription") {
      billingCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { data: { plan: "pro" } };
    }
    return { data: {} };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server(), billing: null });
    await Promise.all([
      useServerStore.getState().loadBilling(),
      useServerStore.getState().loadBilling(),
      useServerStore.getState().loadBilling(),
    ]);
    assert.equal(billingCalls, 1, "three concurrent loads must share one request");
    assert.equal((useServerStore.getState().billing as { plan?: string } | null)?.plan, "pro");
  } finally {
    api.get = original;
    useServerStore.setState({ billing: null, current: null, servers: [] });
  }
});

test("loadServers({ listOnly }) refreshes the list without the members / sidebar-order reads", async () => {
  const original = api.get;
  const paths: string[] = [];
  api.get = (async (path: string) => {
    paths.push(path);
    if (path === "/servers") return { data: [server()] };
    if (path.endsWith("/sidebar-order")) return { data: DEFAULT_SIDEBAR_ORDER };
    return { data: [] };
  }) as typeof api.get;
  try {
    useServerStore.setState({ servers: [server()], current: server() });
    await useServerStore.getState().loadServers({ fresh: true, listOnly: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(paths.includes("/servers"), "the list is read");
    assert.ok(!paths.some((p) => p.endsWith("/members") || p.endsWith("/sidebar-order")), `listOnly: ${paths.join(", ")}`);

    paths.length = 0;
    await useServerStore.getState().loadServers({ fresh: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(paths.some((p) => p.endsWith("/members")), `default still cascades: ${paths.join(", ")}`);
  } finally {
    api.get = original;
    useServerStore.setState({ current: null, servers: [] });
  }
});

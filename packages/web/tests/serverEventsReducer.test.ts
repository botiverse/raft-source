/**
 * RFC 037 T5-server reducer pins.
 *
 * RED contract: server entity/current/sidebarOrder/serverEpoch are one
 * reducer-owned push domain. members/billing/usage stay request-shaped and
 * are intentionally absent from this state.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_ORDER,
  applyServerEvent,
} from "../src/store/events/serverEvents";
import type {
  ServerDomainState,
} from "../src/store/events/serverEvents";
import type { Server, SidebarOrderPreferences } from "../src/store/serverStore";

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

function sidebar(overrides: Partial<SidebarOrderPreferences> = {}): SidebarOrderPreferences {
  return {
    ...DEFAULT_SIDEBAR_ORDER,
    channelOrder: ["channel-1"],
    agentOrder: ["agent-1"],
    pinnedChannelIds: ["channel-1"],
    ...overrides,
  };
}

function state(overrides: Partial<ServerDomainState> = {}): ServerDomainState {
  return {
    servers: [],
    current: null,
    sidebarOrder: DEFAULT_SIDEBAR_ORDER,
    serverEpoch: 0,
    ...overrides,
  };
}

test("[RED T5-server] current switch increments serverEpoch and resets sidebarOrder in the pure fold", () => {
  const base = state({
    servers: [server()],
    sidebarOrder: sidebar(),
    serverEpoch: 7,
  });

  const { state: next, transition } = applyServerEvent(base, {
    kind: "patch",
    patch: "current-set",
    server: server(),
  });

  assert.equal(next.current?.id, "server-1");
  assert.equal(next.serverEpoch, 8);
  assert.deepEqual(next.sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(transition.event, "patch:current-set");
  assert.equal(transition.touched, 1);
});

test("[RED T5-server] loadServers hydrate refreshes current server facts without epoch churn", () => {
  const base = applyServerEvent(state({ servers: [server()] }), {
    kind: "patch",
    patch: "current-set",
    server: server(),
  }).state;

  const { state: next, transition } = applyServerEvent(base, {
    kind: "hydrate",
    source: "servers",
    servers: [server({ plan: "pro", name: "Core Pro" })],
  });

  assert.equal(next.current?.plan, "pro");
  assert.equal(next.current?.name, "Core Pro");
  assert.equal(next.serverEpoch, base.serverEpoch);
  assert.equal(transition.event, "hydrate:servers");
});

test("[RED T5-server] loadServers hydrate preserves a URL-resolved current when the list is stale", () => {
  const current = server({ id: "url-server", slug: "url-server", name: "URL" });
  const base = state({
    servers: [],
    current,
    serverEpoch: 3,
  });

  const { state: next, transition } = applyServerEvent(base, {
    kind: "hydrate",
    source: "servers",
    servers: [server({ id: "other", slug: "other", name: "Other" })],
  });

  assert.equal(next.current, current);
  assert.equal(next.serverEpoch, 3);
  assert.equal(transition.event, "hydrate:servers");
  assert.equal(transition.serverEpochDelta, 0);
  assert.equal(transition.reconcileSuggested, false);
});

test("[RED T5-server] server:plan-updated patches list/current idempotently without reconcile", () => {
  const current = server({ plan: "free" });
  const base = state({ servers: [current], current, serverEpoch: 4 });

  const once = applyServerEvent(base, {
    kind: "patch",
    patch: "server-upsert",
    server: { id: "server-1", plan: "team" },
  });
  assert.equal(once.state.current?.plan, "team");
  assert.equal(once.state.servers[0]?.plan, "team");
  assert.equal(once.state.serverEpoch, 4);
  assert.equal(once.transition.reconcileSuggested, false);

  const twice = applyServerEvent(once.state, {
    kind: "patch",
    patch: "server-upsert",
    server: { id: "server-1", plan: "team" },
  });
  assert.equal(twice.transition.touched, 0);
  assert.equal(twice.state, once.state, "idempotent patch preserves reference identity");
});

test("[RED T5-server] unknown server patches are no-ops with explicit zero transition metadata", () => {
  const current = server({ plan: "free" });
  const base = state({ servers: [current], current, serverEpoch: 4 });

  const result = applyServerEvent(base, {
    kind: "patch",
    patch: "server-upsert",
    server: { id: "missing", plan: "team" },
  });

  assert.equal(result.state, base);
  assert.equal(result.transition.event, "patch:server-upsert");
  assert.equal(result.transition.touched, 0);
  assert.equal(result.transition.serverEpochDelta, 0);
  assert.equal(result.transition.reconcileSuggested, false);
});

test("[RED T5-server] sidebar hydrate is guarded by reducer-owned serverEpoch", () => {
  const current = server();
  const base = state({ servers: [current], current, serverEpoch: 3 });

  const stale = applyServerEvent(base, {
    kind: "hydrate",
    source: "sidebar-order",
    serverId: "server-1",
    epoch: 2,
    sidebarOrder: sidebar({ channelOrder: ["stale-channel"] }),
  });
  assert.equal(stale.transition.touched, 0);
  assert.equal(stale.state, base);

  const fresh = applyServerEvent(base, {
    kind: "hydrate",
    source: "sidebar-order",
    serverId: "server-1",
    epoch: 3,
    sidebarOrder: sidebar({ channelOrder: ["fresh-channel"] }),
  });
  assert.deepEqual(fresh.state.sidebarOrder.channelOrder, ["fresh-channel"]);
  assert.equal(fresh.transition.event, "hydrate:sidebar-order");
});

test("[RED T5-server] membership removal clears current and bumps epoch in the pure fold", () => {
  const current = server();
  const base = state({
    servers: [current, server({ id: "server-2", slug: "ops", name: "Ops" })],
    current,
    sidebarOrder: sidebar(),
    serverEpoch: 5,
  });

  const { state: next, transition } = applyServerEvent(base, {
    kind: "patch",
    patch: "membership-removed",
    serverId: "server-1",
  });

  assert.deepEqual(next.servers.map((item) => item.id), ["server-2"]);
  assert.equal(next.current, null);
  assert.equal(next.serverEpoch, 6);
  assert.deepEqual(next.sidebarOrder, DEFAULT_SIDEBAR_ORDER);
  assert.equal(transition.event, "patch:membership-removed");
  assert.equal(transition.touched, 1);
});

test("[RED T5-server] membership removal for a non-current server keeps current, sidebar, and epoch", () => {
  const current = server();
  const retainedSidebar = sidebar({ channelOrder: ["keep-channel"] });
  const base = state({
    servers: [current, server({ id: "server-2", slug: "ops", name: "Ops" })],
    current,
    sidebarOrder: retainedSidebar,
    serverEpoch: 5,
  });

  const { state: next, transition } = applyServerEvent(base, {
    kind: "patch",
    patch: "membership-removed",
    serverId: "server-2",
  });

  assert.deepEqual(next.servers.map((item) => item.id), ["server-1"]);
  assert.equal(next.current, current);
  assert.equal(next.sidebarOrder, retainedSidebar);
  assert.equal(next.serverEpoch, 5);
  assert.equal(transition.touched, 1);
  assert.equal(transition.serverEpochDelta, 0);
});

test("[RED T5-server] current-clear without a current is a zero-transition no-op", () => {
  const base = state({ serverEpoch: 6 });

  const result = applyServerEvent(base, {
    kind: "patch",
    patch: "current-clear",
  });

  assert.equal(result.state, base);
  assert.equal(result.transition.event, "patch:current-clear");
  assert.equal(result.transition.touched, 0);
  assert.equal(result.transition.serverEpochDelta, 0);
});

test("[RED T5-server] reconcile converges server list and current reference to server truth", () => {
  const current = server({ name: "Old", plan: "free" });
  const base = state({ servers: [current], current, serverEpoch: 2 });
  const truth = server({ name: "New", plan: "enterprise" });

  const { state: next } = applyServerEvent(base, {
    kind: "reconcile",
    servers: [truth],
  });

  assert.deepEqual(next.servers, [truth]);
  assert.deepEqual(next.current, truth);
  assert.equal(next.serverEpoch, 2);
});

test("[RED T5-server] reconcile clears a missing current without epoch churn", () => {
  const current = server({ id: "missing", slug: "missing", name: "Missing" });
  const base = state({ servers: [current], current, serverEpoch: 9 });

  const { state: next, transition } = applyServerEvent(base, {
    kind: "reconcile",
    servers: [server({ id: "kept", slug: "kept", name: "Kept" })],
  });

  assert.deepEqual(next.servers.map((item) => item.id), ["kept"]);
  assert.equal(next.current, null);
  assert.equal(next.serverEpoch, 9);
  assert.equal(transition.event, "reconcile");
  assert.equal(transition.touched, 1);
  assert.equal(transition.serverEpochDelta, 0);
});

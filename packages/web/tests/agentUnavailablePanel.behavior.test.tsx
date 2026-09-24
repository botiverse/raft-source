import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { canRenderAgentDetail } from "../src/components/agent/agentDetailAvailability";
import { __testInternals } from "../src/components/layout/MainLayout";
import ProfilePanel from "../src/components/profile/ProfilePanel";
import { setCachedAgentProfile } from "../src/components/profile/profileFallbackCache";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useProfileStore } from "../src/store/profileStore";
import { useServerStore } from "../src/store/serverStore";

window.matchMedia = window.matchMedia ?? (() => ({
  matches: true,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  // profileFallbackCache is a module-level Map that survives `cleanup()`. Without
  // this, an entry cached by one test satisfies another test's lookup and that
  // test passes for the wrong reason — which is exactly what happened while
  // writing the task #19 cross-server case.
  triggerServerReset();
  useAgentStore.setState({ agents: [], activityLogs: {} } as never);
  useAuthStore.setState({ user: null } as never);
  useProfileStore.setState({ profileType: null, profileId: null, defaultAgentTabIntent: null } as never);
  useServerStore.setState({ current: null, members: [], servers: [], loading: false } as never);
});

function seedShell() {
  useAuthStore.setState({ user: { id: "user-2", name: "member" } } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "server-1", name: "Server 1", role: "member" },
    members: [],
    servers: [],
    loading: false,
  } as never);
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    serverName: "Server 1",
    serverSlug: "server-1",
    name: "agent-one",
    displayName: "Agent One",
    avatarUrl: null,
    description: null,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test("stale agent profile overlay falls through to an unavailable panel instead of the root error UI", async (t) => {
  seedShell();
  useProfileStore.getState().openProfile("agent", "terminated-agent-1");

  const requestedUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    requestedUrls.push(url);
    if (url === "/agents/terminated-agent-1") throw Object.assign(new Error("Agent not found"), { response: { status: 404 } });
    throw new Error(`unexpected GET ${url}`);
  });

  render(
    <MemoryRouter initialEntries={["/s/server-1/members?profile=agent:terminated-agent-1"]}>
      <TestIntlProvider>
        <ProfilePanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
  assert.ok(screen.getAllByText("Agent unavailable").length >= 1);
  assert.ok(screen.getByText("This agent has been terminated or is no longer available in this server."));
  assert.equal(screen.queryByText("Something went wrong"), null);
  assert.equal(screen.queryByText(/Cannot read properties of undefined/), null);
  await waitFor(() => assert.deepEqual(requestedUrls, ["/agents/terminated-agent-1"]));
});

test("stale agent profile overlay treats a 200 deleted fallback response as unavailable", async (t) => {
  seedShell();
  useProfileStore.getState().openProfile("agent", "terminated-agent-1");

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/agents/terminated-agent-1") {
      return { data: makeAgent({ id: "terminated-agent-1", deletedAt: "2026-08-12T00:00:00.000Z" }) };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  render(
    <MemoryRouter initialEntries={["/s/server-1/members?profile=agent:terminated-agent-1"]}>
      <TestIntlProvider>
        <ProfilePanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
  assert.equal(screen.queryByText("Something went wrong"), null);
  assert.equal(screen.queryByText(/Cannot read properties of undefined/), null);
});

test("stale agent profile overlay treats a 200 incomplete fallback response as unavailable", async (t) => {
  seedShell();
  useProfileStore.getState().openProfile("agent", "partial-agent-1");

  t.mock.method(api, "get", async (url: string) => {
    if (url === "/agents/partial-agent-1") {
      return { data: { id: "partial-agent-1", name: "partial-agent", deletedAt: null } };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  render(
    <MemoryRouter initialEntries={["/s/server-1/members?profile=agent:partial-agent-1"]}>
      <TestIntlProvider>
        <ProfilePanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
  assert.equal(screen.queryByText("Something went wrong"), null);
  assert.equal(screen.queryByText(/Cannot read properties of undefined/), null);
});

test("joint peer partial profile remains readable without querying the current server agent endpoint", async (t) => {
  seedShell();
  const remotePartial = {
    id: "peer-agent-1",
    serverId: "server-2",
    serverName: "Server 2",
    serverSlug: "server-2",
    name: "peer-agent",
    displayName: "Peer Agent",
    avatarUrl: null,
    status: "active",
    deletedAt: null,
  } as Agent;
  setCachedAgentProfile("server-1", remotePartial);
  useProfileStore.getState().openProfile("agent", remotePartial.id);

  const requestedUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    requestedUrls.push(url);
    throw new Error(`unexpected GET ${url}`);
  });

  render(
    <MemoryRouter initialEntries={[`/s/server-1/channel/joint-1?profile=agent:${remotePartial.id}`]}>
      <TestIntlProvider>
        <ProfilePanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok((await screen.findAllByText("Peer Agent")).length > 0);
  assert.equal(screen.queryByTestId("agent-unavailable-panel"), null);
  assert.equal(requestedUrls.includes(`/agents/${remotePartial.id}`), false);
  assert.equal(canRenderAgentDetail(remotePartial, "server-1"), true);
  assert.equal(canRenderAgentDetail(remotePartial, "server-2"), false);
  assert.equal(canRenderAgentDetail({ ...remotePartial, status: undefined } as unknown as Agent, "server-1"), false);

  const channelSummary = {
    id: "agent-channel-summary",
    serverId: "server-1",
    name: "channel-agent",
    displayName: "Channel Agent",
    avatarUrl: null,
    status: "active",
    profileProjection: "channel_summary",
    deletedAt: null,
  } as unknown as Agent;
  assert.equal(canRenderAgentDetail(channelSummary, "server-1"), true);
  assert.equal(canRenderAgentDetail({ ...channelSummary, profileProjection: undefined }, "server-1"), false);
});

test("store-retained deleted agent profile overlay renders unavailable instead of AgentDetailPanel", async () => {
  seedShell();
  useAgentStore.setState({
    agents: [makeAgent({ id: "terminated-agent-1", deletedAt: "2026-08-12T00:00:00.000Z" })],
  } as never);
  useProfileStore.getState().openProfile("agent", "terminated-agent-1");

  render(
    <MemoryRouter initialEntries={["/s/server-1/members?profile=agent:terminated-agent-1"]}>
      <TestIntlProvider>
        <ProfilePanel />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
  assert.equal(screen.queryByText("Something went wrong"), null);
  assert.equal(screen.queryByText(/Cannot read properties of undefined/), null);
});

// ── task #19: the full-page /agent/:agentId route ────────────────────────────
// The overlay panel was fixed by #6493, but the route body still read only the
// local agentStore and called the guard without `currentServerId`, so every
// peer-server agent rendered "Agent unavailable" — the screenshot stdrc filed.


/** A real peer-server projection: exactly the bounded field set the server's
 *  `toJointAgentProfile()` returns. Deliberately has NO `model` / `runtime` —
 *  those are private to the owning server. Using a full `makeAgent()` here
 *  would satisfy the base guard on its own and the test would pass without
 *  ever exercising the remote-projection branch. */
function makeRemoteProjection(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "remote-agent-9",
    serverId: "server-2",
    serverName: "Server 2",
    serverSlug: "server-2",
    name: "peer-agent",
    displayName: "Peer Agent",
    avatarUrl: null,
    description: null,
    status: "active",
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  } as Agent;
}

const { AgentById } = __testInternals;

function renderRoute(agentId: string) {
  return render(
    <MemoryRouter initialEntries={[`/agent/${agentId}`]}>
      <TestIntlProvider>
        <AgentById agentId={agentId} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("full-page route renders a peer-server agent from the viewer-scoped projection, without asking this server for it", async (t) => {
  seedShell();
  const requestedUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    requestedUrls.push(url);
    throw new Error(`unexpected GET ${url}`);
  });

  // Primed by a member / message-sender / mention surface, scoped to the viewer server.
  setCachedAgentProfile("server-1", makeRemoteProjection());

  renderRoute("remote-agent-9");

  // TERMINAL ORACLE, asserted first: the peer agent's profile is actually
  // VISIBLE. Asserting only the absence of the unavailable panel would also
  // pass if the route rendered nothing at all, and would let a mutation fail on
  // an incidental signal (a call count) instead of on what the user sees.
  // (displayName renders in more than one slot of the panel, so match all)
  const shown = await screen.findAllByText("Peer Agent");
  assert.ok(shown.length >= 1, "the peer-server agent's profile must actually render");

  // Supporting, not load-bearing.
  assert.equal(screen.queryByTestId("agent-unavailable-panel"), null);
  assert.equal(screen.queryByText("This agent has been terminated or is no longer available in this server."), null);
  // The contract is specifically that this server is never asked to resolve a
  // FOREIGN agent id: `/agents/:id` 404s for it.
  assert.equal(requestedUrls.includes("/agents/remote-agent-9"), false,
    "must not ask this server to resolve a peer-server agent id");
});

test("full-page route still shows unavailable for a direct hit with no bounded projection", async () => {
  seedShell();
  renderRoute("never-seen-agent");
  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
});

test("full-page route still shows unavailable for a same-server deleted agent", async () => {
  seedShell();
  useAgentStore.setState({
    agents: [makeAgent({ id: "gone-agent", deletedAt: "2026-08-12T00:00:00.000Z" })],
    activityLogs: {},
  } as never);
  renderRoute("gone-agent");
  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
});

test("full-page route: a cached projection for a DIFFERENT viewer server does not leak in", async () => {
  seedShell(); // current server is server-1
  setCachedAgentProfile("server-99", makeRemoteProjection());
  renderRoute("remote-agent-9");
  assert.ok(await screen.findByTestId("agent-unavailable-panel"));
});

// ── task #21: a peer-server public profile must not load private subresources ──
// Hiding a surface does not stop its loaders — hooks run unconditionally. The
// panel already hid every operational control for a remote joint agent, yet
// still asked THIS server for that FOREIGN agent's runtime options.

test("full-page route: peer-server profile does not request this server's private agent subresources", async (t) => {
  seedShell();
  useServerStore.setState((state) => ({
    current: state.current ? { ...state.current, role: "owner" } : state.current,
  }) as never);
  const requestedUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    requestedUrls.push(url);
    throw new Error(`unexpected GET ${url}`);
  });

  setCachedAgentProfile("server-1", makeRemoteProjection());
  renderRoute("remote-agent-9");

  // Terminal oracle first: the profile is genuinely rendered, so a "no requests"
  // result cannot be produced by simply failing to render anything.
  const shown = await screen.findAllByText("Peer Agent");
  assert.ok(shown.length >= 1, "the peer-server profile must actually render");
  assert.ok(screen.getByText("Profile"));
  assert.ok(screen.getByText("From"));
  assert.ok(screen.getByText("Server 2"));
  for (const label of ["Activity", "Chat", "Reminders", "Workspace", "Apps", "MCP"]) {
    assert.equal(screen.queryByText(label), null);
  }
  assert.equal(screen.queryByRole("button", { name: "Restart / Reset" }), null);

  // DENY-LIST BY DEFAULT. The previous version filtered for the specific paths
  // I had thought of, so a leak I had not thought of (`/reminders`) was
  // invisible to the very check that claimed to rule leaks out. Assert on the
  // WHOLE request set instead, with an explicit allow-list of public calls.
  const PUBLIC_ALLOWED = [/^\/servers\/[^/]+\/members(\/|$|\?)/];
  const leaked = requestedUrls.filter((url) => !PUBLIC_ALLOWED.some((re) => re.test(url)));
  assert.deepEqual(leaked, [],
    `a peer-server public profile must issue no private loaders, saw: ${leaked.join(", ")}`);
});

test("same-server agent KEEPS its private loaders (positive control for the gate)", async (t) => {
  seedShell();
  const requestedUrls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    requestedUrls.push(url);
    if (url === "/reminders") return { data: { reminders: [] } };
    return { data: {} };
  });

  // canViewAgentPrivateSurfaces: creator-owned agent ⇒ private surfaces allowed.
  useAgentStore.setState({
    agents: [makeAgent({ id: "local-agent-1", serverId: "server-1", creatorType: "user", creatorId: "user-2" })],
    activityLogs: {},
  } as never);

  renderRoute("local-agent-1");
  await screen.findAllByText("Agent One");

  // The gate must not have over-fired: a same-server agent still loads reminders.
  await waitFor(() => assert.ok(
    requestedUrls.includes("/reminders"),
    `same-server agent must still load its private reminders, saw: ${requestedUrls.join(", ")}`,
  ));
  // Both gated loaders must survive for a same-server agent, not just one:
  // a gate that over-fires on runtime-options would otherwise pass unnoticed.
  await waitFor(() => assert.ok(
    requestedUrls.some((url) => /^\/agents\/local-agent-1\/runtime-options/.test(url)),
    `same-server agent must still load its runtime options, saw: ${requestedUrls.join(", ")}`,
  ));
});

// ── task #21 review: stale-response fencing needs its own tooth ──────────────
// I claimed scope fencing; Mahua deleted all three commit guards and the suite
// stayed green, so the claim was unverified. This drives the real sequence:
// a deferred load for (server-1, agent A) that resolves only AFTER the viewer
// has switched to (server-9, agent B).

function renderRouteOnTab(agentId: string, tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/agent/${agentId}?agentTab=${tab}`]}>
      <TestIntlProvider>
        <AgentById agentId={agentId} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}


// ── task #21 review round 5: switch teeth with a FRESH-B terminal oracle ──────
// Previous versions let B return empty, so they only proved "the stale row is
// gone" — never "the fresh row arrives and stays". Absence is not correctness.

const FRESH_B = "FRESH B ROW";
const STALE_A = "STALE A ROW";

function reminderRow(title: string, ownerAgentId: string) {
  return { reminderId: `rem-${title}`, ownerAgentId, title, fireAt: new Date(10_000).toISOString(), status: "scheduled" };
}

test("A→B: B's fresh row arrives and SURVIVES a late resolve from the abandoned scope", async (t) => {
  seedShell();
  let resolveA: ((v: unknown) => void) | null = null;
  t.mock.method(api, "get", async (url: string, config?: any) => {
    if (url !== "/reminders") return { data: {} };
    if (config?.params?.ownerAgentId === "local-a") return new Promise((r) => { resolveA = r; });
    return { data: { reminders: [reminderRow(FRESH_B, "local-b")] } };
  });

  useAgentStore.setState({
    agents: [makeAgent({ id: "local-a", displayName: "Agent A", creatorType: "user", creatorId: "user-2" })],
    activityLogs: {},
  } as never);
  const { rerender } = renderRouteOnTab("local-a", "reminders");
  await waitFor(() => assert.ok(resolveA, "scope A load must be in flight"));

  await act(async () => {
    useServerStore.setState({
      current: { id: "server-9", slug: "server-9", name: "Server 9", role: "member" },
      members: [], servers: [], loading: false,
    } as never);
    useAgentStore.setState({
      agents: [makeAgent({ id: "local-b", serverId: "server-9", displayName: "Agent B", creatorType: "user", creatorId: "user-2" })],
      activityLogs: {},
    } as never);
    rerender(
      <MemoryRouter initialEntries={["/agent/local-b?agentTab=reminders"]}>
        <TestIntlProvider><AgentById agentId="local-b" /></TestIntlProvider>
      </MemoryRouter>,
    );
  });

  // Fresh B must be PRESENT before we let A come back.
  assert.ok(await screen.findByText(FRESH_B), "B's fresh row must render");

  await act(async () => {
    resolveA!({ data: { reminders: [reminderRow(STALE_A, "local-a")] } });
    await Promise.resolve();
  });

  assert.ok(screen.queryByText(FRESH_B), "B's row must SURVIVE the late resolve from scope A");
  assert.equal(screen.queryByText(STALE_A), null, "scope A must not commit anything");
});

test("server-only switch: old row clears while pending, then B's fresh row appears", async (t) => {
  seedShell();
  let resolveB: ((v: unknown) => void) | null = null;
  let call = 0;
  t.mock.method(api, "get", async (url: string) => {
    if (url !== "/reminders") return { data: {} };
    call += 1;
    if (call === 1) return { data: { reminders: [reminderRow(STALE_A, "shared-agent")] } };
    return new Promise((r) => { resolveB = r; });
  });

  useAgentStore.setState({
    agents: [makeAgent({ id: "shared-agent", creatorType: "user", creatorId: "user-2" })],
    activityLogs: {},
  } as never);
  const { unmount } = renderRouteOnTab("shared-agent", "reminders");
  await screen.findByText(STALE_A);

  await act(async () => {
    useServerStore.setState({
      current: { id: "server-9", slug: "server-9", name: "Server 9", role: "member" },
      members: [], servers: [], loading: false,
    } as never);
  });
  // Unmount BEFORE asserting on the fail path. Otherwise a failing assertion
  // leaves the tree mounted, cleanup is deferred, and the mutant surfaces as a
  // file-level 70s timeout instead of a named sub-second RED. (Mahua, task #22)
  const oldRowCleared = screen.queryByText(STALE_A) === null;
  if (!oldRowCleared) unmount();
  assert.ok(oldRowCleared, "old server's row must clear while the new load is pending");
  // Bounded: if the viewer server is not part of load ownership, the second
  // load never starts. Without a short timeout that failure arrives as a 60s
  // file-level timeout instead of a named, fast assertion.
  await waitFor(
    () => assert.ok(resolveB, "server switch must start a NEW load — viewer server must be part of load ownership"),
    { timeout: 1500 },
  );

  await act(async () => {
    resolveB!({ data: { reminders: [reminderRow(FRESH_B, "shared-agent")] } });
    await Promise.resolve();
  });
  assert.ok(await screen.findByText(FRESH_B), "the new scope's fresh row must appear");
  assert.equal(screen.queryByText(STALE_A), null);
});

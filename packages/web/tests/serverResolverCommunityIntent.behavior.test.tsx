import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import api from "../src/api/client";
import { ServerResolver } from "../src/App";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { CommunityServerSlug, Server } from "../src/store/serverStore";

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

const existingServer: Server = {
  id: "server-dev",
  name: "Dev",
  avatarUrl: null,
  slug: "dev",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "member",
  createdAt: "2026-07-07T00:00:00.000Z",
};

const originalSetCurrent = useServerStore.getState().setCurrent;
const originalGet = api.get;

function RouteJump({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      Open community
    </button>
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState({
    current: null,
    servers: [],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

test("the authenticated Native onboarding route mounts the dedicated gate with the routed server and generation", async () => {
  const emitted: Array<{ kind: string; payload: object }> = [];
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: {
      version: "raft-host-v1",
      emit: (kind: string, payload: object) => emitted.push({ kind, payload }),
    },
  });
  api.get = (async (url: string) => {
    assert.equal(url, "/servers/server-dev/setup-projection");
    return {
      data: {
        surface: "complete",
        phase: "complete",
        currentStep: null,
        blocksChat: false,
        allowedExits: [],
        sideEffectState: { transitions: "enabled", completion: "enabled" },
        gateReason: "setup_complete",
      },
    } as never;
  }) as typeof api.get;
  useMachineStore.setState({ machines: [], loadMachines: async () => undefined } as never);
  useServerStore.setState({
    current: existingServer,
    servers: [existingServer],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/dev/onboarding?generation=account_1%3Aserver-dev.view-3"]}>
      <Routes>
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
      </Routes>
    </MemoryRouter>,
  );

  assert.ok(screen.getByTestId("native-onboarding-web-surface"));
  assert.ok(screen.getByTestId("native-onboarding-loading"));
  await waitFor(() => {
    assert.deepEqual(emitted, [{
      kind: "onboarding:completed",
      payload: {
        contractVersion: "raft-onboarding-v1",
        serverId: "server-dev",
        serverSlug: "dev",
        generation: "account_1:server-dev.view-3",
      },
    }]);
  });
});

test("a browser without a wake generation never enters the standalone onboarding route", async () => {
  // artin (#proj-mobile d89d3318, task #313): only clients enter the standalone
  // surface. A plain browser lands back on the server route, where the
  // MainLayout gate renders the setup Modal instead.
  let lastPathname = "";
  function PathSpy() {
    lastPathname = useLocation().pathname;
    return null;
  }
  api.get = (async () => ({ data: [] })) as typeof api.get;
  useMachineStore.setState({ machines: [], loadMachines: async () => undefined } as never);
  useServerStore.setState({
    current: existingServer,
    servers: [existingServer],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/dev/onboarding"]}>
      <PathSpy />
      <Routes>
        <Route path="/s/:serverSlug/onboarding" element={<ServerResolver />} />
        {/* The bounce target. MainLayout itself cannot mount under the focused
            tsx loader (import.meta.env), and this test pins the redirect, not
            the layout. */}
        <Route path="/s/:serverSlug" element={<div data-testid="server-home" />} />
      </Routes>
    </MemoryRouter>,
  );

  // Synchronous on purpose: the gate's own no-generation fallback also
  // navigates eventually, but only the App-level guard keeps the standalone
  // surface from mounting even transiently (no loading flash, no projection
  // read from a surface the browser was never meant to see).
  assert.equal(
    screen.queryByTestId("native-onboarding-web-surface"),
    null,
    "the standalone surface must never mount for a generation-less browser",
  );
  await waitFor(() => assert.equal(lastPathname, "/s/dev"));
  assert.ok(screen.getByTestId("server-home"));
  assert.equal(screen.queryByTestId("native-onboarding-web-surface"), null);
});

test("an in-flight server switch never lands the old server's projection on the new standalone surface", async () => {
  // #310 review finding: the standalone gate must be identity-isolated per
  // server, because refreshProjection has no stale-response guard — if an
  // alpha-mounted instance were ever reused as beta's, alpha's late
  // setup-projection read would overwrite beta's projection and beta's user
  // would see alpha's blocking setup step. Isolation comes from two layers:
  // `key={server.id}` on the gate (explicit), and ServerResolver's
  // `current.id !== server.id` loading guard, which unmounts the gate during
  // the switch window in every reachable update ordering. This test drives the
  // REAL App callsite through ServerResolver, holds alpha's read in flight
  // across the switch, resolves it late with a blocking step, and pins the
  // user-visible contract: the stale read lands nowhere.
  const alphaServer: Server = {
    ...existingServer,
    id: "server-alpha",
    name: "Alpha",
    slug: "alpha",
  };
  const betaServer: Server = {
    ...existingServer,
    id: "server-beta",
    name: "Beta",
    slug: "beta",
  };

  let resolveAlphaProjection: (value: { data: object }) => void = () => {};
  const alphaProjectionRead = new Promise<{ data: object }>((resolve) => {
    resolveAlphaProjection = resolve;
  });

  api.get = (async (url: string) => {
    if (url === "/servers/server-alpha/setup-projection") return alphaProjectionRead;
    if (url === "/servers/server-beta/setup-projection") {
      return {
        data: {
          surface: "complete",
          phase: "complete",
          currentStep: null,
          blocksChat: false,
          allowedExits: [],
          sideEffectState: { transitions: "enabled", completion: "enabled" },
          gateReason: "setup_complete",
          postSetup: { surveyPending: true, handoffPending: false },
        },
      };
    }
    return { data: [] };
  }) as typeof api.get;

  useMachineStore.setState({ machines: [], loadMachines: async () => undefined } as never);
  useServerStore.setState({
    current: alphaServer,
    servers: [alphaServer, betaServer],
    members: [],
    loading: false,
    setCurrent: (server: Server) => useServerStore.setState({ current: server }),
  } as never);

  function JumpToBeta() {
    const navigate = useNavigate();
    return (
      <button
        type="button"
        onClick={() => {
          // A real server switch (ServerSwitcherMenu, switch intent) updates
          // the current server AND navigates in the same event. The contract
          // pinned below must hold regardless of how those two updates commit.
          useServerStore.setState({ current: betaServer });
          navigate("/s/beta/onboarding?generation=beta.view-1");
        }}
      >
        Switch to beta
      </button>
    );
  }

  render(
    <MemoryRouter initialEntries={["/s/alpha/onboarding?generation=alpha.view-1"]}>
      <JumpToBeta />
      <Routes>
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
      </Routes>
    </MemoryRouter>,
  );

  // Alpha's standalone surface is mounted with its projection read still in flight.
  assert.ok(screen.getByTestId("native-onboarding-web-surface"));

  fireEvent.click(screen.getByRole("button", { name: "Switch to beta" }));

  // Beta's surface settles on its own authoritative state (post-setup survey).
  await waitFor(() => assert.ok(screen.getByTestId("server-setup-survey")));

  // NOW alpha's read resolves — late, with a blocking setup step. It must go
  // nowhere: alpha's gate instance was unmounted by the server.id key.
  resolveAlphaProjection({
    data: {
      surface: "computer_runtime",
      phase: "in_progress",
      currentStep: "computer_runtime",
      blocksChat: true,
      allowedExits: ["defer", "return_to_server"],
      sideEffectState: { transitions: "enabled", completion: "disabled" },
      gateReason: "runtime_checking",
      computerStatus: "online",
      runtimeStatus: "checking",
      postSetup: { surveyPending: false, handoffPending: false },
    },
  });
  await alphaProjectionRead;
  // Let any (wrong) state update from the stale read flush before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    screen.queryByRole("heading", { name: "Connect a computer" }),
    null,
    "alpha's late projection must not render its setup step on beta's surface",
  );
  assert.ok(
    screen.getByTestId("server-setup-survey"),
    "beta keeps its own authoritative post-setup state",
  );
});

test("direct default community route auto-joins after ServerResolver is reused across server slug changes", async () => {
  const joinCalls: Array<{ slug?: CommunityServerSlug; agreementId?: string | null }> = [];
  useServerStore.setState({
    current: null,
    servers: [existingServer],
    members: [],
    loading: false,
    setCurrent: () => {},
    joinCommunityServer: (options = {}) => {
      joinCalls.push(options);
      return new Promise<Server>(() => {
        // Keep the promise pending: this test only needs to prove the reused
        // resolver starts the auto-join side effect, not render the full app
        // layout after a successful join.
      });
    },
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <RouteJump to="/s/community" />
      <Routes>
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Open community" }));

  await waitFor(() => {
    assert.deepEqual(joinCalls, [{ slug: "community" }]);
  });
});

test("direct Chinese community route redirects to the QR page instead of auto-joining", async () => {
  const joinCalls: Array<{ slug?: CommunityServerSlug; agreementId?: string | null }> = [];
  let lastPathname = "";
  let lastSearch = "";
  function PathSpy() {
    const location = useLocation();
    lastPathname = location.pathname;
    lastSearch = location.search;
    return null;
  }
  useServerStore.setState({
    current: null,
    servers: [existingServer],
    members: [],
    loading: false,
    setCurrent: () => {},
    joinCommunityServer: (options = {}) => {
      joinCalls.push(options);
      return new Promise<Server>(() => {});
    },
  } as never);

  render(
    <MemoryRouter initialEntries={["/s/dev"]}>
      <PathSpy />
      <RouteJump to="/s/community-cn" />
      <Routes>
        <Route path="/community/chinese" element={<div data-testid="chinese-community-page" />} />
        <Route path="/s/:serverSlug/*" element={<ServerResolver />} />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Open community" }));

  await waitFor(() => {
    assert.equal(lastPathname, "/community/chinese");
    assert.equal(lastSearch, "?from=direct-community-route");
  });
  assert.deepEqual(joinCalls, []);
  assert.ok(screen.getByTestId("chinese-community-page"));
});

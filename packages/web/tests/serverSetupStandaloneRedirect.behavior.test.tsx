import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { RuntimeSelectionOption } from "@botiverse/raft-shared";
import api from "../src/api/client";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import ServerSetupProjectionGate from "../src/components/onboarding/ServerSetupProjectionGate";
import { useServerSetupRevision } from "../src/components/onboarding/serverSetupProjection";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useOnboardingAnnouncementGateStore } from "../src/store/onboardingAnnouncementGateStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Browser/client onboarding split contract (artin, #proj-mobile d89d3318,
 * task #313 — supersedes the short-lived redirect-everything shape of #7211).
 *
 * The gate has two rendering surfaces:
 * - MainLayout (dedicatedSurface=false, the BROWSER flow): renders the
 *   mandatory steps as gate-owned Modals in place — it never navigates to
 *   /s/:slug/onboarding. Completion simply stops rendering the Modal.
 * - Standalone page (dedicatedSurface=true, the CLIENT flow): renders steps as
 *   page content. On completion with a wake generation it emits the
 *   onboarding:completed wake, asks the host to close via window.close(), and
 *   renders a completion panel — never null (task #311: parking on null left a
 *   blank WebView whenever the host missed the wake) and never a redirect into
 *   the app shell. Without a wake generation it falls back to /s/:slug.
 *
 * These tests pin both directions so reintroducing a redirect, dropping a
 * Modal, or breaking the step-shell navigation split causes a stable RED.
 */

const COMPUTER_RUNTIME_PROJECTION = {
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
};

const CREATE_AGENT_PROJECTION = {
  surface: "create_agent",
  phase: "in_progress",
  currentStep: "create_agent",
  blocksChat: true,
  allowedExits: ["reset", "return_to_server"],
  sideEffectState: { transitions: "enabled", completion: "enabled" },
  gateReason: "completion_pending",
  computerStatus: "online",
  runtimeStatus: "ready_recommended",
  hasConnectedComputer: true,
  offlineComputers: [],
  postSetup: { surveyPending: false, handoffPending: false },
};

const COMPLETE_WITH_SURVEY = {
  surface: "complete",
  phase: "complete",
  currentStep: null,
  blocksChat: false,
  gateReason: "setup_complete",
  computerStatus: "online",
  runtimeStatus: "ready",
  postSetup: { surveyPending: true, handoffPending: false },
};

const COMPLETE_WITH_HANDOFF = {
  surface: "complete",
  phase: "complete",
  currentStep: null,
  blocksChat: false,
  gateReason: "setup_complete",
  computerStatus: "online",
  runtimeStatus: "ready",
  postSetup: { surveyPending: false, handoffPending: true },
};

const COMPLETE_DONE = {
  surface: "complete",
  phase: "complete",
  currentStep: null,
  blocksChat: false,
  gateReason: "setup_complete",
  computerStatus: "online",
  runtimeStatus: "ready",
  postSetup: { surveyPending: false, handoffPending: false },
};

const CLAUDE_RUNTIME_OPTION: RuntimeSelectionOption = {
  runtimeId: "claude",
  capabilityStatus: "available",
  admissionStatus: "available_for_new",
  admissionReason: null,
  current: false,
  availableForNew: true,
  manageableForCurrentAgent: false,
  canSelectInThisContext: true,
};

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

let capturedPathname = "";

function LocationSpy() {
  const location = useLocation();
  capturedPathname = location.pathname;
  return <output data-testid="route">{location.pathname}</output>;
}

function renderGateWithRouter(
  projection: Record<string, unknown>,
  opts: {
    dedicatedSurface?: boolean;
    completionWakeGeneration?: string | null;
    initialPath?: string;
  } = {},
) {
  const {
    dedicatedSurface = false,
    completionWakeGeneration = null,
    initialPath = dedicatedSurface ? "/s/server-1/onboarding" : "/s/server-1",
  } = opts;

  api.get = (async (url: string) => {
    if (!url.includes("/setup-projection")) return { data: [] };
    return { data: projection };
  }) as typeof api.get;

  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationSpy />
        <ServerSetupProjectionGate
          serverId="server-1"
          serverSlug="server-1"
          completionWakeGeneration={completionWakeGeneration}
          dedicatedSurface={dedicatedSurface}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function installHostEventCapture() {
  const calls: Array<{ kind: string; payload: object }> = [];
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: Object.freeze({
      version: "raft-host-v1",
      emit(kind: string, payload: object) {
        calls.push({ kind, payload });
      },
    }),
  });
  return calls;
}

function makeAgent(): Agent {
  return {
    id: "agent-cindy",
    serverId: "server-1",
    name: "Cindy",
    displayName: "Cindy",
    avatarUrl: "pixel:mug",
    description: "Onboarding Assistant",
    status: "starting",
    model: "claude-opus-4-1-20250805",
    runtime: "claude",
    serverRole: null,
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: "machine-1",
    creatorType: "user",
    creatorId: "owner-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

function seedCreateAgentStores() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Launch",
      slug: "server-1",
      avatarUrl: null,
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    billing: null,
    loadBilling: async () => undefined,
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "machine-1",
      name: "Mac",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["claude"],
      hostname: "mac.local",
      os: "darwin",
      daemonVersion: "0.72.6",
      lastHeartbeat: "2026-07-11T00:00:00.000Z",
      createdAt: "2026-07-11T00:00:00.000Z",
    }],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "channel-onboarding-owner",
      name: "onboarding-owner",
      description: null,
      type: "channel",
      createdAt: "2026-07-11T00:00:00.000Z",
    }],
  } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

beforeEach(() => {
  capturedPathname = "";
  useServerSetupRevision.setState({ revision: 0 });
  useOnboardingAnnouncementGateStore.setState({ byServerId: {} });
});

afterEach(() => {
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  cleanup();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useOnboardingAnnouncementGateStore.setState({ byServerId: {} });
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

// ── MainLayout gate renders Modals in place (browser flow) ───────────

test("MainLayout gate renders computer_runtime as a Modal without navigating", async () => {
  renderGateWithRouter(COMPUTER_RUNTIME_PROJECTION, { dedicatedSurface: false });
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  assert.equal(capturedPathname, "/s/server-1", "browser flow must stay on the server route");
});

test("MainLayout gate renders create_agent as a Modal without navigating", async () => {
  renderGateWithRouter(CREATE_AGENT_PROJECTION, { dedicatedSurface: false });
  await waitFor(() => assert.ok(screen.getByText("Meet Cindy")));
  assert.equal(capturedPathname, "/s/server-1", "browser flow must stay on the server route");
});

test("MainLayout gate renders survey as a Modal without navigating", async () => {
  renderGateWithRouter(COMPLETE_WITH_SURVEY, { dedicatedSurface: false });
  await waitFor(() => assert.ok(screen.getByTestId("server-setup-survey")));
  assert.equal(capturedPathname, "/s/server-1", "browser flow must stay on the server route");
});

test("MainLayout gate renders handoff as a Modal without navigating", async () => {
  renderGateWithRouter(COMPLETE_WITH_HANDOFF, { dedicatedSurface: false });
  await waitFor(() => assert.ok(screen.getByTestId("server-setup-handoff")));
  assert.equal(capturedPathname, "/s/server-1", "browser flow must stay on the server route");
});

// ── Standalone surface renders step content ──────────────────────────

test("standalone surface renders computer_runtime step content instead of redirecting", async () => {
  renderGateWithRouter(COMPUTER_RUNTIME_PROJECTION, { dedicatedSurface: true });
  await waitFor(() => assert.ok(screen.getByRole("heading", { name: "Connect a computer" })));
  assert.equal(capturedPathname, "/s/server-1/onboarding", "stays on the standalone route");
});

test("standalone surface renders create_agent step content instead of redirecting", async () => {
  renderGateWithRouter(CREATE_AGENT_PROJECTION, { dedicatedSurface: true });
  await waitFor(() => assert.ok(screen.getByText("Meet Cindy")));
  assert.equal(capturedPathname, "/s/server-1/onboarding", "stays on the standalone route");
});

test("standalone surface renders survey step content instead of redirecting", async () => {
  renderGateWithRouter(COMPLETE_WITH_SURVEY, { dedicatedSurface: true });
  await waitFor(() => assert.ok(screen.getByTestId("server-setup-survey")));
  assert.equal(capturedPathname, "/s/server-1/onboarding", "stays on the standalone route");
});

// ── Shell navigation split: "page" stays put, "step" navigates ───────

function stubFirstAgentCreation() {
  api.get = (async (url: string) => {
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [CLAUDE_RUNTIME_OPTION],
        },
      };
    }
    return {
      data: {
        kind: "live",
        value: { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" },
      },
    };
  }) as typeof api.get;

  api.post = (async (url: string) => {
    if (url === "/agents") return { data: makeAgent() };
    if (url.includes("/setup-transition")) return { data: { surface: "complete" } };
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;
}

async function createCindyInShell(shell: "step" | "page", initialPath: string) {
  let closed = false;
  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationSpy />
        <CreateAgentDialog
          onboarding
          onboardingShell={shell}
          onClose={() => { closed = true; }}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const button = screen.getByRole("button", { name: "Create Cindy" });
  await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false));
  fireEvent.click(button);
  await waitFor(() => assert.equal(closed, true));
}

test("page-shell first-agent creation stays on the standalone page", async () => {
  seedCreateAgentStores();
  stubFirstAgentCreation();
  await createCindyInShell("page", "/s/server-1/onboarding");
  assert.equal(
    capturedPathname,
    "/s/server-1/onboarding",
    "page shell must not navigate away — survey/handoff render on this page next",
  );
});

test("step-shell first-agent creation navigates to the onboarding-owner channel behind the modal", async () => {
  seedCreateAgentStores();
  stubFirstAgentCreation();
  await createCindyInShell("step", "/s/server-1");
  assert.equal(
    capturedPathname,
    "/s/server-1/channel/channel-onboarding-owner",
    "browser Modal flow keeps the pre-standalone landing: the channel where Cindy briefs",
  );
});

// ── Completion redirect back to server ───────────────────────────────

test("standalone Web surface redirects to server when setup completes (no wake generation)", async () => {
  renderGateWithRouter(COMPLETE_DONE, {
    dedicatedSurface: true,
    completionWakeGeneration: null,
  });
  await waitFor(() => assert.equal(capturedPathname, "/s/server-1"));
});

test("optimistic completion never closes the WebView before the authoritative refresh (task #314)", async () => {
  // closeCompletedSetup marks the projection complete locally, spreading the
  // PREVIOUS step's stale postSetup. If window.close() keyed off that state it
  // would close the WebView past a still-owed survey/handoff. This drives the
  // real flow: create Cindy on the standalone surface, hold the post-completion
  // refresh in flight, and pin that close waits for server truth.
  seedCreateAgentStores();
  installHostEventCapture();
  const originalClose = window.close.bind(window);
  let closeCalls = 0;
  window.close = () => { closeCalls += 1; };

  let projectionReads = 0;
  let resolveHeldProjection: (value: { data: object }) => void = () => {};
  const heldProjection = new Promise<{ data: object }>((resolve) => {
    resolveHeldProjection = resolve;
  });

  api.get = (async (url: string) => {
    if (url.includes("/setup-projection")) {
      projectionReads += 1;
      return projectionReads === 1 ? { data: CREATE_AGENT_PROJECTION } : heldProjection;
    }
    if (url.endsWith("/runtime-options")) {
      return {
        data: {
          context: "new_agent",
          machineId: "machine-1",
          options: [CLAUDE_RUNTIME_OPTION],
        },
      };
    }
    return {
      data: {
        kind: "live",
        value: { models: [{ id: "opus", label: "Claude Opus" }], default: "opus" },
      },
    };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/agents") return { data: makeAgent() };
    if (url.includes("/setup-transition")) return { data: { surface: "complete" } };
    throw new Error(`Unexpected POST ${url}`);
  }) as typeof api.post;

  render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/server-1/onboarding"]}>
        <LocationSpy />
        <ServerSetupProjectionGate
          serverId="server-1"
          serverSlug="server-1"
          completionWakeGeneration="webview:1"
          dedicatedSurface
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  try {
    const button = await screen.findByRole("button", { name: "Create Cindy" });
    await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, false));
    fireEvent.click(button);

    // Optimistic complete replaced the step while the refresh is in flight.
    await waitFor(() => assert.ok(screen.getByTestId("native-onboarding-complete")));
    assert.equal(closeCalls, 0, "window.close must not fire on locally-synthesized completion");

    // Server truth arrives: the survey is still owed.
    resolveHeldProjection({ data: COMPLETE_WITH_SURVEY });
    await waitFor(() => assert.ok(screen.getByTestId("server-setup-survey")));
    assert.equal(closeCalls, 0, "the WebView must not have closed past the authoritative survey");
  } finally {
    window.close = originalClose;
  }
});

test("standalone Native completion: wake fires, window.close is asked, panel renders, no redirect (task #311)", async () => {
  const calls = installHostEventCapture();
  const originalClose = window.close.bind(window);
  let closeCalls = 0;
  window.close = () => { closeCalls += 1; };

  try {
    renderGateWithRouter(COMPLETE_DONE, {
      dedicatedSurface: true,
      completionWakeGeneration: "webview:1",
    });

    // The completion contract (artin, #proj-mobile d89d3318): the client closes
    // the onboarding page. Three teeth:
    // 1. the wake still fires — Native's dismissal path keeps its signal;
    // 2. the Web side asks the host to close via window.close();
    // 3. the surface never parks on null (Nathan's #311 report: a blank WebView
    //    kept only the standalone <main>) and never redirects into the app
    //    shell inside the WebView.
    await waitFor(() => assert.equal(calls.length, 1, "completion wake must fire"));
    assert.deepEqual(calls[0], {
      kind: "onboarding:completed",
      payload: {
        contractVersion: "raft-onboarding-v1",
        serverId: "server-1",
        serverSlug: "server-1",
        generation: "webview:1",
      },
    });

    await waitFor(() => assert.equal(closeCalls, 1, "window.close assist must be asked exactly once"));
    assert.ok(
      screen.getByTestId("native-onboarding-complete"),
      "completion panel must render — never a blank standalone shell",
    );
    assert.equal(
      capturedPathname,
      "/s/server-1/onboarding",
      "Native surface must not navigate into the app inside the WebView",
    );
  } finally {
    window.close = originalClose;
  }
});

test("completion wake leaves a logcat-visible breadcrumb naming bridge presence", async () => {
  // emitHostEvent is a silent no-op without the injected bridge (host contract),
  // so a wake fired into a missing RaftHost is invisible to Native logs. The
  // console.warn breadcrumb is the only Web-side evidence distinguishing
  // "bridge ABSENT at emit" from "host consumed but dropped" (2026-09-03 fresh
  // repro: completion panel shown, zero Native callbacks). Pin both wordings.
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  const originalClose = window.close.bind(window);
  window.close = () => {};

  try {
    // No RaftHost installed: the panel still renders and the breadcrumb says ABSENT.
    renderGateWithRouter(COMPLETE_DONE, {
      dedicatedSurface: true,
      completionWakeGeneration: "webview:absent",
    });
    await waitFor(() => assert.ok(
      warnings.some((line) => line.includes("completion wake emit") && line.includes("webview:absent") && line.includes("ABSENT")),
      "bridge-absent emit must log an ABSENT breadcrumb",
    ));
    assert.ok(screen.getByTestId("native-onboarding-complete"));

    cleanup();

    // Bridge installed: same breadcrumb reports the bridge as present.
    installHostEventCapture();
    renderGateWithRouter(COMPLETE_DONE, {
      dedicatedSurface: true,
      completionWakeGeneration: "webview:present",
    });
    await waitFor(() => assert.ok(
      warnings.some((line) => line.includes("completion wake emit") && line.includes("webview:present") && line.includes("bridge present")),
      "bridge-present emit must log a present breadcrumb",
    ));
  } finally {
    console.warn = originalWarn;
    window.close = originalClose;
  }
});

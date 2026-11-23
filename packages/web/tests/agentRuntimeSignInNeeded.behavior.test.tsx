// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// #triage:#494: an agent whose start failed because its runtime is not signed in
// (`runtime_login_required`) reads, on every surface, the error light (orange,
// not the offline grey), "Sign-in needed" and Cat's sentence in place of the
// daemon's English one. Sign in opens the same sign-in as the profile, only for
// a viewer who can act on the Computer. Any other failed start keeps the
// daemon's text and the grey light (the reverse check).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@botiverse/raft-ui";
import { MemoryRouter } from "react-router-dom";
import type { AgentRuntimeErrorState, SpawnFailureReason } from "@botiverse/raft-shared";
import { afterEach, beforeEach, test, vi } from "vitest";

import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { useAuthStore } from "../src/store/authStore";
import { runtimeAuthClient } from "../src/utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";
import { SidebarAgentActivityBadge } from "../src/features/sidebar/rows/SidebarAgentActivityBadge";
import { SidebarAgentMeta } from "../src/features/sidebar/rows/SidebarAgentMeta";
import { ChannelMemberRow } from "../src/components/channel/ChannelMemberList";
import { AgentActivityInfo } from "../src/components/agent/channelMemberParts";
import { AgentRuntimeSignInRowAction } from "../src/components/agent/AgentRuntimeSignInRowAction";
import { AgentDMStatus } from "../src/features/channel/AgentDMStatus";
import { AgentStatusBadge } from "../src/features/agent/AgentStatusBadge";

const AGENT = "agent-cindy";
const MACHINE = "machine-1";
const DAEMON_SENTENCE = "The runtime needs you to log in on this computer before it can start. Log in to the runtime there, then restart the agent.";
const PHRASE = "Sign-in needed for Kimi Code";
const SENTENCE = "Cindy can't start until Kimi Code is signed in on Mei's PC. Sign in there, or switch Cindy to another runtime.";

type LiveKind = "logged_out" | "logged_in" | "unknown";

function view(canAct: boolean, kind: LiveKind = "logged_out"): RuntimeAuthView {
  return {
    status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes: { kimi: { kind } as never } },
    availability: "ok",
    runtimes: ["claude", "codex", "kimi"],
    canAct,
  };
}

let reads = 0;
let startLogin: ReturnType<typeof vi.fn>;

function seed({ reason = "runtime_login_required", source = "activity", attached = true, canAct = true, live = "logged_out" }: {
  reason?: SpawnFailureReason;
  source?: "activity" | "stored";
  attached?: boolean;
  canAct?: boolean;
  /** The Computer's live sign-in state for Kimi, as the runtime-auth read reports it. */
  live?: LiveKind;
} = {}) {
  const lastRuntimeError: AgentRuntimeErrorState | null = source === "stored"
    ? { message: DAEMON_SENTENCE, at: "2026-11-17T10:00:00.000Z", actionRequired: true, spawnFailureReason: reason }
    : null;
  useServerStore.setState({ current: { id: "server-1", slug: "mei", name: "Mei's team", role: "member" } } as never);
  useAuthStore.setState({ user: { id: "user-mei" } } as never);
  useMachineStore.setState({ machines: [{ id: MACHINE, name: "Mei's PC", status: "online", runtimes: ["kimi-sdk"], computerAttachedByCurrentUser: attached }] } as never);
  useAgentStore.setState({
    agents: [{
      id: AGENT, name: "cindy", displayName: "Cindy", avatarUrl: null, description: null, status: "inactive", model: "",
      runtime: "kimi-sdk", serverRole: "member", executionMode: "byoc", envVars: null, machineId: MACHINE,
      reasoningEffort: null, lastRuntimeError,
    }],
    agentActivities: {
      [AGENT]: {
        activity: "offline",
        activityDetail: DAEMON_SENTENCE,
        detailKind: "runtime_unavailable",
        ...(source === "activity" ? { spawnFailure: { reason } } : {}),
      },
    },
  } as never);
  vi.spyOn(runtimeAuthClient, "read").mockImplementation(async () => {
    reads += 1;
    return view(canAct, live);
  });
  vi.spyOn(runtimeAuthClient, "watch").mockImplementation(() => () => {});
  startLogin = vi.fn(() => new Promise<never>(() => {}));
  vi.spyOn(runtimeAuthClient, "startLogin").mockImplementation(startLogin as never);
  vi.spyOn(runtimeAuthClient, "onLogin").mockImplementation(() => () => {});
}

beforeEach(() => { reads = 0; });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useMachineStore.setState({ machines: [] } as never);
});

function mount(node: ReactNode) {
  return render(<TestIntlProvider><MemoryRouter><TooltipProvider>{node}</TooltipProvider></MemoryRouter></TestIntlProvider>);
}

/** The light's colour: raft-ui Status draws the presence through `--status-color`. */
function lightOf(container: HTMLElement): "error" | "offline" | "other" {
  const dot = container.querySelector<HTMLElement>('[class*="--status-color"]');
  const className = dot?.className ?? "";
  if (className.includes("--presence-error")) return "error";
  if (className.includes("--presence-offline")) return "offline";
  return "other";
}

/** Opens the tooltip on `trigger` (focus shows what hover shows) and reads whether `text` is in it. */
async function tooltipSays(trigger: HTMLElement, text: string) {
  trigger.tabIndex = 0;
  act(() => trigger.focus());
  fireEvent.focus(trigger);
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
  fireEvent.pointerMove(trigger, { pointerType: "mouse" });
  fireEvent.mouseMove(trigger);
  await waitFor(() => assert.equal(screen.queryAllByText(text).some((node) => node !== trigger && !trigger.contains(node) && !node.classList.contains("sr-only")), true, `tooltip: ${text}`));
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

// ── Sidebar ──────────────────────────────────────────────────────────────

test("sidebar: the orange light, \"Sign-in needed\" in place of the runtime, the sentence on hover (no button: the row is one)", async () => {
  seed();
  const { container } = mount(
    <div>
      <span data-testid="badge"><SidebarAgentActivityBadge agentId={AGENT} /></span>
      <SidebarAgentMeta agentId={AGENT} runtime="kimi-sdk" />
    </div>,
  );
  assert.equal(lightOf(screen.getByTestId("badge")), "error");
  const meta = screen.getByTestId("sidebar-agent-sign-in-needed");
  assert.equal(meta.textContent, "Sign-in needed");
  assert.ok(screen.queryByTestId("sidebar-agent-runtime") === null);
  await tooltipSays(meta, SENTENCE);
  const dot = screen.getByTestId("badge").querySelector<HTMLElement>('[class*="--status-color"]')!;
  await tooltipSays(dot, SENTENCE);
  assert.equal(container.textContent?.includes(DAEMON_SENTENCE), false, "the daemon's sentence is gone");
  assert.ok(screen.queryByText("Sign in") === null);
  assert.equal(screen.getByTestId("sidebar-agent-sign-in-detail").textContent, SENTENCE, "a screen reader gets the sentence too");
});

test("sidebar, zh-CN: 「需要登录」", () => {
  seed();
  render(<TestIntlProvider locale="zh-cn"><SidebarAgentMeta agentId={AGENT} runtime="kimi-sdk" /></TestIntlProvider>);
  assert.equal(screen.getByTestId("sidebar-agent-sign-in-needed").textContent, "需要登录");
});

// ── Member list ──────────────────────────────────────────────────────────

function memberRow() {
  return (
    <ChannelMemberRow
      type="agent"
      agentId={AGENT}
      name="Cindy"
      secondary={<AgentActivityInfo agentId={AGENT} fallbackStatus="inactive" />}
      trailing={<AgentRuntimeSignInRowAction agentId={AGENT} fallbackStatus="inactive" />}
      onRowClick={() => {}}
    />
  );
}

test("member list: orange light, the full phrase, the sentence as the secondary line, Sign in beside the row's button", async () => {
  seed({ source: "stored" });
  const { container } = mount(memberRow());
  assert.equal(lightOf(container), "error");
  const info = screen.getByTestId("member-row-sign-in-needed");
  assert.equal(info.textContent?.startsWith(PHRASE), true);
  assert.equal(screen.getByTestId("member-row-sign-in-detail").textContent, SENTENCE);
  assert.equal(container.textContent?.includes(DAEMON_SENTENCE), false);
  const signIn = await screen.findByTestId("member-row-sign-in");
  assert.equal(signIn.textContent, "Sign in");
  assert.ok(signIn.closest("button") === signIn, "its own button");
  assert.ok(signIn.parentElement?.closest("button") === null, "never inside the row's profile button");
  assert.equal(signIn.getAttribute("aria-label"), "Sign in to Kimi Code", "the button names its runtime");
  fireEvent.click(signIn);
  await screen.findByText("Sign in to Kimi Code");
});

test("member list: no Sign in for a viewer the Computer's sign-in read does not let act", async () => {
  seed({ canAct: false });
  mount(memberRow());
  await waitFor(() => assert.equal(reads > 0, true));
  await settle();
  assert.equal(screen.getByTestId("member-row-sign-in-needed").textContent?.startsWith(PHRASE), true, "the status stays");
  assert.ok(screen.queryByTestId("member-row-sign-in") === null);
});

test("member list: no Sign in (and no read) for a viewer who may not see the Computer's sign-in state", async () => {
  seed({ attached: false });
  mount(memberRow());
  await settle();
  assert.equal(reads, 0);
  assert.ok(screen.queryByTestId("member-row-sign-in") === null);
  assert.equal(screen.getByTestId("member-row-sign-in-detail").textContent, SENTENCE);
});

// ── DM header ────────────────────────────────────────────────────────────

test("DM header: orange light, the full phrase, the sentence on hover, Sign in opens the runtime's sign-in", async () => {
  seed();
  const { container } = mount(<div className="flex">{<AgentDMStatus agentId={AGENT} />}</div>);
  assert.equal(lightOf(container), "error");
  const status = screen.getByTestId("agent-dm-status-sign-in-needed");
  assert.equal(status.textContent, PHRASE);
  assert.equal(container.textContent?.includes(DAEMON_SENTENCE), false);
  await tooltipSays(status, SENTENCE);
  assert.equal(screen.getByTestId("agent-dm-status-sign-in-detail").textContent, SENTENCE, "a screen reader gets the sentence too");
  assert.equal(screen.getByTestId("agent-dm-status-sign-in-detail").className.includes("sr-only"), true);
  fireEvent.click(await screen.findByTestId("agent-dm-status-sign-in"));
  await screen.findByText("Sign in to Kimi Code");
});

test("DM header, phone width (below 768px): the short phrase, the runtime only in the sentence", async () => {
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  try {
    seed();
    const { container } = mount(<AgentDMStatus agentId={AGENT} />);
    assert.equal(lightOf(container), "error");
    const status = screen.getByTestId("agent-dm-status-sign-in-needed");
    assert.equal(status.textContent, "Sign-in needed");
    await tooltipSays(status, SENTENCE);
    cleanup();
    render(<TestIntlProvider locale="zh-cn"><MemoryRouter><TooltipProvider><AgentDMStatus agentId={AGENT} /></TooltipProvider></MemoryRouter></TestIntlProvider>);
    assert.equal(screen.getByTestId("agent-dm-status-sign-in-needed").textContent, "需要登录");
  } finally {
    window.matchMedia = previous;
  }
});

test("DM header, desktop width: the full phrase (the media query at 768px)", () => {
  const queries: string[] = [];
  const previous = window.matchMedia;
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return { matches: /min-width:\s*768px/.test(query), media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
  try {
    seed();
    mount(<AgentDMStatus agentId={AGENT} />);
    assert.equal(screen.getByTestId("agent-dm-status-sign-in-needed").textContent, PHRASE);
    assert.ok(queries.includes("(min-width: 768px)"));
  } finally {
    window.matchMedia = previous;
  }
});

test("DM header: the status without Sign in for a viewer who cannot act", async () => {
  seed({ canAct: false, source: "stored" });
  mount(<AgentDMStatus agentId={AGENT} />);
  await waitFor(() => assert.equal(reads > 0, true));
  await settle();
  assert.equal(screen.getByTestId("agent-dm-status-sign-in-needed").textContent, PHRASE);
  assert.ok(screen.queryByTestId("agent-dm-status-sign-in") === null);
});

// ── The Computer's live sign-in state (review of #15282) ────────────────

test("signed in since (live logged_in): no Sign in and no \"Sign-in needed\", in the member list, the DM header and the sidebar", async () => {
  seed({ source: "stored", live: "logged_in" });
  mount(
    <div>
      {memberRow()}
      <AgentDMStatus agentId={AGENT} />
      <SidebarAgentMeta agentId={AGENT} runtime="kimi-sdk" />
    </div>,
  );
  await waitFor(() => assert.equal(reads > 0, true));
  await waitFor(() => assert.ok(screen.queryByTestId("member-row-sign-in-needed") === null));
  await settle();
  assert.ok(screen.queryByTestId("agent-dm-status-sign-in-needed") === null);
  assert.ok(screen.queryByTestId("sidebar-agent-sign-in-needed") === null);
  assert.ok(screen.queryByTestId("member-row-sign-in") === null);
  assert.ok(screen.queryByTestId("agent-dm-status-sign-in") === null);
  assert.equal(screen.queryAllByText(SENTENCE).length, 0, "nobody is told it can't start until it is signed in");
});

test("live state unknown: the status stays, with no Sign in", async () => {
  seed({ live: "unknown" });
  mount(
    <div>
      {memberRow()}
      <AgentDMStatus agentId={AGENT} />
    </div>,
  );
  await waitFor(() => assert.equal(reads > 0, true));
  await settle();
  assert.equal(screen.getByTestId("member-row-sign-in-needed").textContent?.startsWith(PHRASE), true);
  assert.equal(screen.getByTestId("agent-dm-status-sign-in-needed").textContent, PHRASE);
  assert.ok(screen.queryByTestId("member-row-sign-in") === null);
  assert.ok(screen.queryByTestId("agent-dm-status-sign-in") === null);
});

// ── Profile badge ────────────────────────────────────────────────────────

test("profile badge: the same check names the runtime on the error light, the sentence on hover", async () => {
  seed({ source: "stored" });
  const { container } = mount(<AgentStatusBadge agentId={AGENT} showDetail />);
  assert.equal(lightOf(container), "error");
  const chip = screen.getByTestId("agent-status-chip");
  assert.equal(chip.textContent, PHRASE);
  await tooltipSays(chip.querySelector<HTMLElement>("span.min-w-0")!, SENTENCE);
});

test("profile badge: a rejected sign-in (user_reauth) keeps its own words, not the not-signed-in ones", () => {
  seed({ reason: "runtime_spawn_failed", source: "activity" });
  const reauth = { message: "401 token expired", at: "2026-11-17T10:00:00.000Z", actionRequired: true, requiredAction: "user_reauth" as const };
  useAgentStore.setState((state) => ({
    agents: state.agents.map((a) => ({ ...a, lastRuntimeError: reauth })),
    agentActivities: { [AGENT]: { activity: "error", activityDetail: reauth.message, detailKind: "none" } },
  }) as never);
  const agent = useAgentStore.getState().agents[0];
  mount(<AgentStatusBadge agentId={AGENT} showDetail credentialAgent={agent} />);
  assert.equal(screen.getByTestId("agent-status-chip").textContent, "Sign in again to Kimi Code");
});

// ── Reverse check ────────────────────────────────────────────────────────

test("reverse: any other failed start keeps the grey light and the daemon's text on every surface, with no Sign in", async () => {
  for (const source of ["activity", "stored"] as const) {
    seed({ reason: "runtime_spawn_failed", source });
    const sidebar = mount(
      <div>
        <span data-testid="badge"><SidebarAgentActivityBadge agentId={AGENT} /></span>
        <SidebarAgentMeta agentId={AGENT} runtime="kimi-sdk" />
      </div>,
    );
    assert.equal(lightOf(screen.getByTestId("badge")), "offline", source);
    assert.ok(screen.queryByTestId("sidebar-agent-sign-in-needed") === null);
    assert.equal(screen.getByTestId("sidebar-agent-runtime").textContent, "Kimi Code");
    sidebar.unmount();

    const member = mount(memberRow());
    assert.equal(lightOf(member.container), "offline");
    assert.equal(member.container.textContent?.includes(DAEMON_SENTENCE), true);
    assert.ok(screen.queryByTestId("member-row-sign-in-needed") === null);
    member.unmount();

    const badge = mount(<AgentStatusBadge agentId={AGENT} showDetail />);
    assert.equal(lightOf(badge.container), "offline");
    assert.equal(screen.getByTestId("agent-status-chip").textContent?.includes(PHRASE), false);
    badge.unmount();

    const header = mount(<AgentDMStatus agentId={AGENT} />);
    assert.equal(lightOf(header.container), "offline");
    assert.equal(header.container.textContent?.includes(DAEMON_SENTENCE), true);
    assert.ok(screen.queryByTestId("agent-dm-status-sign-in-needed") === null);
    await settle();
    assert.equal(reads, 0, "no sign-in read for it");
    assert.ok(screen.queryByText("Sign in") === null);
    header.unmount();
    vi.restoreAllMocks();
  }
});

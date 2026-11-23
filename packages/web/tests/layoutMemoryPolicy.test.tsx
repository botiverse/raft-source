import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { ComponentType } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ConnectedProfilePanel from "../src/components/profile/ProfilePanel";
import { useHistoryStep, useHistoryTracker } from "../src/components/topbar/historyNavigation";
import { searchEntryState } from "../src/features/search/searchOverlayLocation";
import { placeFor, resetPlaceMigrationForTests, usePlaceMemory } from "../src/hooks/placeMemory";
import { forgetRememberedPlaces } from "../src/hooks/placeMemoryKeys";
import { NavigationDepthTracker } from "../src/hooks/useAppNavigate";
import { useRailMode } from "../src/hooks/useSidebarTab";
import type { RailMode } from "../src/hooks/useSidebarTab";
import { mobileTabForPath, placeOf, railModeForPath } from "../src/navigation/surfaces";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useProfileStore } from "../src/store/profileStore";
import { resetServerFeatureFlagsForTests, resolveServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { getServerSwitcherTarget } from "../src/utils/serverSwitcherNavigation";
import { stubDesktopWidth } from "./helpers/desktopWidth";
import { installFakeNavigation } from "./helpers/fakeNavigation";
import { renderWithIntl } from "./helpers/intl";

// The layout memory and close policy (#triage:#550), route × action → where
// the person lands, with the real place memory (usePlaceMemory), rail
// (useRailMode), server switch target, address sync (useRightPanelUrlSync),
// history trackers and profile panel over a BrowserRouter.
//
// - A place (rail click, server switch and back, phone tab, `/`) is the page
//   with only its own params: never a pane (thread, profile, open result,
//   task), a dialog or a message to jump to. A conversation's panes come back
//   through its beside memory (useBesideMemory, docs/frontend/beside-memory.md),
//   not mounted here.
// - × / Esc close their own pane and stay on the page; returning to the page
//   it was opened from is Back's (the top bar's ‹, the browser's).
// - Reload and deep links: the address stays as it is.

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const machine: Machine = {
  id: "m1",
  name: "mac-mini",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "mac-mini.local",
  os: "darwin",
  daemonVersion: null,
  isComputer: true,
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-08-08T00:00:00.000Z",
};

const BASE = "/s/acme";
const CHANNEL = `${BASE}/channel/c1`;
const COMPUTER_PANEL = `${BASE}/computers?profile=computer%3Am1`;
const RAIL_MODES: readonly RailMode[] = ["search", "activity", "chat", "members", "computers", "apps", "tasks", "settings", "assistant", "artifacts"];
const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const initialProfileState = useProfileStore.getState();
let teardown: Array<() => void> = [];

afterEach(() => {
  cleanup();
  for (const undo of teardown.reverse()) undo();
  teardown = [];
  forgetRememberedPlaces();
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
  useProfileStore.setState(initialProfileState, true);
});

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

/** Test-only links: each button pushes its address (with its router state). */
function Links({ links }: { links: Record<string, { to: string; state?: unknown }> }) {
  const navigate = useNavigate();
  return (
    <>
      {Object.entries(links).map(([id, link]) => (
        <button key={id} type="button" data-testid={id} onClick={() => navigate(link.to, { state: link.state })} />
      ))}
    </>
  );
}

/** The layout's place memory, the rail's tabs, a server switch back to Acme and the top bar's ‹. */
function Shell() {
  usePlaceMemory(null);
  useHistoryTracker();
  const { selectRailMode } = useRailMode();
  const navigate = useNavigate();
  const step = useHistoryStep();
  return (
    <>
      {RAIL_MODES.map((mode) => (
        <button key={mode} type="button" data-testid={`rail-${mode}`} onClick={() => selectRailMode(mode)} />
      ))}
      <button type="button" data-testid="switch-acme" onClick={() => navigate(getServerSwitcherTarget("acme"))} />
      <button type="button" data-testid="top-bar-back" onClick={() => step("back")} />
    </>
  );
}

/** A pane's close as the store has it (the profile panel's × and Esc call it; the address sync removes the param). */
function StoreClose() {
  return <button type="button" data-testid="close" onClick={() => useProfileStore.getState().closeProfile()} />;
}

async function mount(start: string, links: Record<string, { to: string; state?: unknown }> = {}, panel: "profile" | "store" | "none" = "none") {
  teardown.push(stubDesktopWidth());
  useServerStore.setState({ current: server, members: [] });
  resolveServerFeatureFlagsForTests(server.id);
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    machines: [machine],
    loading: false,
    loadStatus: "loaded",
    computerOperationProgress: {},
    loadMachines: async () => {},
  } as never);
  window.history.replaceState(null, "", start);
  const { uninstall } = installFakeNavigation(window);
  teardown.push(uninstall);
  const mod = await import("../src/components/layout/MainLayout");
  const internals = (mod as unknown as {
    __testInternals: { HumanRoute: ComponentType; MachineRoute: ComponentType; useRightPanelUrlSync: () => void };
  }).__testInternals;
  const { HumanRoute, MachineRoute } = internals;
  function AddressSync() {
    internals.useRightPanelUrlSync();
    return null;
  }
  return renderWithIntl(
    <BrowserRouter>
      <NavigationDepthTracker />
      <AddressSync />
      <Shell />
      <Routes>
        <Route path="/s/:slug/computer/:machineId" element={<MachineRoute />} />
        <Route path="/s/:slug/human/:userId" element={<HumanRoute />} />
        <Route path="*" element={null} />
      </Routes>
      <Links links={{ ...links, away: { to: "/s/other/channel/x" }, neutral: { to: `${BASE}/raftbench` } }} />
      {panel === "profile" ? <ConnectedProfilePanel /> : panel === "store" ? <StoreClose /> : null}
      <LocationProbe />
    </BrowserRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

// ---- Places: route × (rail click, server switch away and back) → landing ----

/** [surface, address visited, its rail tab, where the rail and a server switch back land]. */
const PLACES: ReadonlyArray<readonly [string, string, RailMode, string]> = [
  ["channel with a thread and a jump (#549)", `${CHANNEL}?msg=jump&thread=c1%3Ap1`, "chat", CHANNEL],
  ["DM with a profile, its chat tab kept", `${BASE}/dm/d1?profile=agent%3Aa1&chatTab=files`, "chat", `${BASE}/dm/d1?chatTab=files`],
  ["Saved", `${BASE}/saved`, "chat", `${BASE}/saved`],
  ["Drafts", `${BASE}/drafts`, "chat", `${BASE}/drafts`],
  ["Activity with an item open", `${BASE}/activity?open=channel%3Ac1&msg=m1`, "activity", `${BASE}/activity`],
  ["Search with a result open", `${BASE}/search?q=mac&open=channel%3Ac1&msg=m1`, "search", `${BASE}/search`],
  ["Tasks with a task beside it and its dialog, filters kept", `${BASE}/tasks?tab=all&status=todo&open=task%3At1&task=t1`, "tasks", `${BASE}/tasks?tab=all&status=todo`],
  ["Computers with a profile, its filter kept", `${BASE}/computers?filter=attention&profile=computer%3Am1`, "computers", `${BASE}/computers?filter=attention`],
  ["This device", `${BASE}/computers/this-device?section=troubleshoot&profile=computer%3Am1`, "computers", `${BASE}/computers/this-device`],
  ["a phone-era computer page (phone → desktop)", `${BASE}/computer/m1`, "computers", `${BASE}/computers`],
  ["Members with a profile", `${BASE}/members?profile=human%3Au1`, "members", `${BASE}/members`],
  ["an agent page", `${BASE}/agent/a1?agentTab=activity`, "members", `${BASE}/members`],
  ["a person's page", `${BASE}/human/u1`, "members", `${BASE}/members`],
  ["Apps with a link's scope", `${BASE}/apps?tab=bots`, "apps", `${BASE}/apps`],
  ["a Settings page with a dialog", `${BASE}/settings/notifications?open=change-password`, "settings", `${BASE}/settings/notifications`],
  ["Artifacts with one open", `${BASE}/artifacts?artifact=x1`, "artifacts", `${BASE}/artifacts`],
  ["Assistant", `${BASE}/assistant`, "assistant", `${BASE}/assistant`],
];

for (const [surface, visited, tab, landing] of PLACES) {
  test(`place: ${surface} — rail click and server switch back land on ${landing}`, async () => {
    await mount(visited);
    await settle();
    // Rail click from elsewhere on the server.
    fireEvent.click(screen.getByTestId("neutral"));
    await waitFor(() => assert.equal(location(), `${BASE}/raftbench`));
    fireEvent.click(screen.getByTestId(`rail-${tab}`));
    await waitFor(() => assert.equal(location(), landing));
    assert.ok(screen.queryByTestId("machine-panel-close") === null, "no pane reopened");
    // Server switch away and back.
    fireEvent.click(screen.getByTestId("away"));
    await waitFor(() => assert.equal(location(), "/s/other/channel/x"));
    fireEvent.click(screen.getByTestId("switch-acme"));
    await waitFor(() => assert.equal(location(), landing));
  });
}

for (const address of [`${CHANNEL}?msg=m1&thread=c1%3Ap1`, COMPUTER_PANEL, `${BASE}/tasks?tab=all&open=task%3At1`]) {
  test(`place: a reload or deep link keeps its address verbatim, whatever is remembered: ${address}`, async () => {
    localStorage.setItem("slock:place:v1:acme", JSON.stringify({ tab: "chat", places: { chat: `${BASE}/channel/c2` } }));
    await mount(address);
    await settle();
    assert.equal(location(), address);
  });
}

test("place: with nothing remembered, each rail tab lands on its home, a server switch on the server's root", async () => {
  await mount(`${BASE}/raftbench`);
  const homes: Record<RailMode, string> = {
    search: `${BASE}/search`, activity: `${BASE}/activity`, chat: BASE, members: `${BASE}/members`,
    computers: `${BASE}/computers`, apps: `${BASE}/apps`, tasks: `${BASE}/tasks`, settings: `${BASE}/settings/account`,
    assistant: `${BASE}/assistant`, artifacts: `${BASE}/artifacts`,
  };
  assert.equal(getServerSwitcherTarget("acme"), BASE);
  for (const mode of RAIL_MODES) {
    assert.equal(placeFor("acme", mode), homes[mode], mode);
  }
});

test("place: not memorable — Settings › Applications, Delete Account, RaftBench, a conversation's search, the own assistant's DM", () => {
  assert.equal(placeOf(`${BASE}/settings/integrations`, "acme"), null);
  assert.equal(placeOf(`${BASE}/settings/account/delete`, "acme"), null);
  assert.equal(placeOf(`${BASE}/raftbench`, "acme"), null);
  assert.equal(placeOf(`${CHANNEL}/search?q=x`, "acme"), null);
  assert.equal(placeOf(`${BASE}/dm/ottie`, "acme", { assistantDmId: "ottie" }), null);
  assert.deepEqual(placeOf(`${BASE}/dm/d1`, "acme", { assistantDmId: "ottie" }), { tab: "chat", place: `${BASE}/dm/d1` });
  // Another server's address, or no app address at all, is no place of this one.
  assert.equal(placeOf("/s/acme-two/channel/c1", "acme"), null);
  assert.equal(placeOf("https://example.com/s/acme/channel/c1", "acme"), null);
});

test("place: the rail and a server switch never land on Search's place over chat (task #311), and re-selecting the page you are on keeps its address", async () => {
  await mount(CHANNEL, { search: { to: `${BASE}/search?q=x` }, thread: { to: `${CHANNEL}?msg=jump&thread=c1%3Ap1` } });
  fireEvent.click(screen.getByTestId("search"));
  await waitFor(() => assert.equal(location(), `${BASE}/search?q=x`));
  fireEvent.click(screen.getByTestId("rail-chat"));
  await waitFor(() => assert.equal(location(), CHANNEL));
  fireEvent.click(screen.getByTestId("thread"));
  await waitFor(() => assert.equal(location(), `${CHANNEL}?msg=jump&thread=c1%3Ap1`));
  fireEvent.click(screen.getByTestId("rail-chat"));
  await settle();
  assert.equal(location(), `${CHANNEL}?msg=jump&thread=c1%3Ap1`);
});

test("place: a Guest's Chat lands on the server's root; the phone's Home tab on its list, its other tabs on their place", async () => {
  await mount(`${BASE}/tasks?tab=all&open=task%3At1`, { channel: { to: CHANNEL } });
  fireEvent.click(screen.getByTestId("channel"));
  await waitFor(() => assert.equal(location(), CHANNEL));
  assert.equal(placeFor("acme", "chat", { guest: true }), BASE);
  assert.equal(placeFor("acme", "chat", { phone: true }), BASE);
  assert.equal(placeFor("acme", "tasks", { phone: true }), `${BASE}/tasks?tab=all`);
  assert.equal(placeFor("acme", "chat"), CHANNEL);
  assert.equal(placeFor("acme"), CHANNEL);
});

test("place: with no viewer given, a Guest on the target server (server store role) lands Chat on the server's root — server switch and `/` start too", () => {
  const rows: ReadonlyArray<readonly [string, Server["role"], string]> = [
    [CHANNEL, "guest", BASE], [`${BASE}/drafts`, "guest", BASE],
    [CHANNEL, "member", CHANNEL], [`${BASE}/drafts`, "member", `${BASE}/drafts`],
  ];
  for (const [remembered, role, landing] of rows) {
    localStorage.setItem("slock:place:v1:acme", JSON.stringify({ tab: "chat", places: { chat: remembered } }));
    // The target server is in the list, not the current one.
    useServerStore.setState({ servers: [{ ...server, role }], current: { ...server, id: "server-2", slug: "other", role: "owner" } });
    assert.equal(placeFor("acme"), landing, `${role} ${remembered}`);
    assert.equal(placeFor("acme", "chat"), landing, `${role} ${remembered} chat`);
    assert.equal(getServerSwitcherTarget("acme"), landing, `${role} ${remembered} switch`);
    assert.equal(placeFor("acme", undefined, { guest: false }), remembered, `${role} ${remembered} explicit member`);
    assert.equal(placeFor("acme", undefined, { guest: true }), BASE, `${role} ${remembered} explicit guest`);
  }
  // Before the list loads, the current server's role counts.
  useServerStore.setState({ servers: [], current: { ...server, role: "guest" } });
  assert.equal(placeFor("acme"), BASE);
});

test("place: the route table — rail tab and phone tab of every server page", () => {
  const rows: ReadonlyArray<readonly [string, RailMode, string | null]> = [
    ["", "chat", "chat"], ["/channel/c1", "chat", "chat"], ["/dm/d1", "chat", "chat"], ["/saved", "chat", "chat"],
    ["/search", "search", "search"], ["/activity", "activity", "activity"], ["/inbox", "activity", "activity"],
    ["/tasks", "tasks", "tasks"], ["/assistant", "assistant", "chat"], ["/artifacts", "artifacts", null],
    ["/apps", "apps", null], ["/members", "members", null], ["/agent/a1", "members", null], ["/human/u1", "members", null],
    ["/computers", "computers", null], ["/computers/this-device", "computers", null], ["/computer/m1", "computers", null],
    ["/machine/m1", "computers", null], ["/settings/account", "settings", null], ["/release-notes", "settings", null],
    ["/keyboard-shortcuts", "settings", null], ["/raftbench", "settings", null], ["/migrations", "chat", "chat"],
  ];
  for (const [rest, rail, phone] of rows) {
    assert.equal(railModeForPath(`${BASE}${rest}`, BASE), rail, rest);
    assert.equal(mobileTabForPath(`${BASE}${rest}/`, BASE), phone, rest);
  }
});

test("place: the old tab memory and server surface are read once through the allowlist, then deleted; the crash screen forgets places", () => {
  forgetRememberedPlaces();
  localStorage.setItem("slock:tabMemory:v2:acme:computers", COMPUTER_PANEL);
  localStorage.setItem("slock:tabMemory:v2:acme:chat", `${CHANNEL}?msg=jump&thread=c1%3Ap1#latest`);
  localStorage.setItem("slock:serverSurface:v1:acme", `${BASE}/activity?open=channel%3Ac1`);
  localStorage.setItem("slock:last-location", JSON.stringify({ path: `${BASE}/settings/account`, ts: 1 }));
  resetPlaceMigrationForTests();
  assert.equal(placeFor("acme"), `${BASE}/activity`);
  assert.equal(placeFor("acme", "chat"), CHANNEL);
  assert.equal(placeFor("acme", "computers"), `${BASE}/computers`);
  for (const key of ["slock:tabMemory:v2:acme:computers", "slock:tabMemory:v2:acme:chat", "slock:serverSurface:v1:acme", "slock:last-location"]) {
    assert.equal(localStorage.getItem(key), null, key);
  }
  forgetRememberedPlaces();
  assert.equal(localStorage.getItem("slock:place:v1:acme"), null);
  assert.equal(placeFor("acme"), BASE);
});

test("place: a stored tab or place this build doesn't know (corrupt storage, a newer build) is ignored", () => {
  localStorage.setItem("slock:place:v1:acme", JSON.stringify({ tab: "future", places: { future: `${BASE}/future`, chat: CHANNEL, tasks: 5 } }));
  assert.equal(placeFor("acme"), BASE);
  assert.equal(placeFor("acme", "chat"), CHANNEL);
  assert.equal(placeFor("acme", "tasks"), `${BASE}/tasks`);
  localStorage.setItem("slock:place:v1:acme", "[1,");
  assert.equal(placeFor("acme"), BASE);
});

function OwnAssistantPlaceMemory() {
  usePlaceMemory("ottie");
  return null;
}

test("place: the own assistant's DM migrated into Chat is dropped once the assistant is known", async () => {
  forgetRememberedPlaces();
  localStorage.setItem("slock:tabMemory:v2:acme:chat", `${BASE}/dm/ottie`);
  localStorage.setItem("slock:serverSurface:v1:acme", `${BASE}/dm/ottie`);
  resetPlaceMigrationForTests();
  useServerStore.setState({ current: server, members: [] });
  renderWithIntl(<MemoryRouter initialEntries={[`${BASE}/raftbench`]}><OwnAssistantPlaceMemory /></MemoryRouter>);
  await settle();
  assert.equal(placeFor("acme", "chat"), BASE);
  assert.equal(placeFor("acme"), BASE);
});

for (const [list, panel, rail] of [
  ["Computers", COMPUTER_PANEL, "computers"],
  ["Members", `${BASE}/members?profile=human%3Au1`, "members"],
] as const) {
  test(`place: re-clicking the ${list} rail tab with a panel open lands on the clean list`, async () => {
    await mount(panel, {}, "store");
    await settle();
    fireEvent.click(screen.getByTestId(`rail-${rail}`));
    await waitFor(() => assert.equal(location(), panel.split("?", 1)[0]));
    await waitFor(() => assert.equal(useProfileStore.getState().profileId, null));
  });
}

// ---- Close (× / Esc) vs Back (the top bar's ‹) ----

test("close: Computers opened from a channel — × stays on the full-width list; the top bar's ‹ returns to the channel", async () => {
  await mount(CHANNEL, { go: { to: COMPUTER_PANEL } }, "profile");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
  fireEvent.click(screen.getByTestId("machine-panel-close"));
  await waitFor(() => assert.equal(location(), `${BASE}/computers`));
  await waitFor(() => assert.equal(useProfileStore.getState().profileId, null));
  fireEvent.click(screen.getByTestId("top-bar-back"));
  await waitFor(() => assert.equal(location(), CHANNEL));
});

test("close: Computers top bar ‹ with the panel open returns to the channel", async () => {
  await mount(CHANNEL, { go: { to: COMPUTER_PANEL } }, "profile");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
  fireEvent.click(screen.getByTestId("top-bar-back"));
  await waitFor(() => assert.equal(location(), CHANNEL));
});

test("close: /computer/<id> from a channel — Esc stays on Computers", async () => {
  await mount(CHANNEL, { go: { to: `${BASE}/computer/m1` } }, "profile");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.equal(location(), COMPUTER_PANEL));
  await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => assert.equal(location(), `${BASE}/computers`));
});

test("close: Computers opened from ⌘K search over a channel — × stays on Computers", async () => {
  await mount(CHANNEL, {
    search: { to: `${BASE}/search?q=mac`, state: searchEntryState({ pathname: CHANNEL, search: "" }) },
    go: { to: COMPUTER_PANEL },
  }, "profile");
  fireEvent.click(screen.getByTestId("search"));
  await waitFor(() => assert.equal(location(), `${BASE}/search?q=mac`));
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
  fireEvent.click(screen.getByTestId("machine-panel-close"));
  await waitFor(() => assert.equal(location(), `${BASE}/computers`));
});

for (const [opened, start] of [["from the list", `${BASE}/computers`], ["on a cold start (a link, a reload)", COMPUTER_PANEL]] as const) {
  test(`close: Computers ${opened} — × stays on the list`, async () => {
    await mount(start, { go: { to: COMPUTER_PANEL } }, "profile");
    if (start !== COMPUTER_PANEL) fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
    fireEvent.click(screen.getByTestId("machine-panel-close"));
    await waitFor(() => assert.equal(location(), `${BASE}/computers`));
    assert.equal(useProfileStore.getState().profileId, null);
  });
}

test("close: a double × and Esc never step back past the page", async () => {
  await mount(CHANNEL, { go: { to: COMPUTER_PANEL } }, "profile");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.ok(screen.queryByTestId("machine-panel-close") !== null, "panel open"));
  const close = screen.getByTestId("machine-panel-close");
  fireEvent.click(close);
  fireEvent.click(close);
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  assert.equal(location(), `${BASE}/computers`);
});

for (const [label, remembered] of [
  ["a remembered panel", COMPUTER_PANEL],
  ["a remembered phone-era /computer/<id>", `${BASE}/computer/m1`],
] as const) {
  test(`close: from a channel through the Computers rail with ${label}, the rail lands on the list with no panel (#triage:#550)`, async () => {
    await mount(remembered, { channel: { to: CHANNEL } }, "profile");
    fireEvent.click(screen.getByTestId("channel"));
    await waitFor(() => assert.equal(location(), CHANNEL));
    fireEvent.click(screen.getByTestId("rail-computers"));
    await waitFor(() => assert.equal(location(), `${BASE}/computers`));
    await settle();
    assert.ok(screen.queryByTestId("machine-panel-close") === null, "no panel open");
  });
}

test("close: Members /human/<id> from a channel — × stays on Members; ‹ returns to the channel (no bare /human/<id> behind)", async () => {
  await mount(CHANNEL, { go: { to: `${BASE}/human/u1` } }, "store");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.equal(location(), `${BASE}/members?profile=human%3Au1`));
  assert.equal(useProfileStore.getState().profileId, "u1");
  fireEvent.click(screen.getByTestId("close"));
  await waitFor(() => assert.equal(location(), `${BASE}/members`));
  await settle();
  assert.equal(useProfileStore.getState().profileId, null);
  fireEvent.click(screen.getByTestId("top-bar-back"));
  await waitFor(() => assert.equal(location(), CHANNEL));
  await settle();
  assert.equal(location(), CHANNEL);
});

test("close: a profile over a channel — × stays on the channel", async () => {
  await mount(`${BASE}/channel/c2`, { go: { to: `${CHANNEL}?profile=human%3Au1` } }, "store");
  fireEvent.click(screen.getByTestId("go"));
  await waitFor(() => assert.equal(useProfileStore.getState().profileId, "u1"));
  fireEvent.click(screen.getByTestId("close"));
  await waitFor(() => assert.equal(location(), CHANNEL));
});

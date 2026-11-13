import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import type { ComponentType } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { MachineDetailPanel } from "../MachineDetailPanel";
import ConnectedProfilePanel from "../../../components/profile/ProfilePanel";
import {
  syncRightPanelStoresFromSearch,
  syncRightPanelUrlFromStores,
} from "../../../components/layout/rightPanelUrlSync";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useProfileStore } from "../../../store/profileStore";
import { resetServerFeatureFlagsForTests, resolveServerFeatureFlagsForTests } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { computerPath, currentComputerPath, isComputerOpen } from "../../../utils/computerPanel";
import { stubDesktopWidth } from "../../../../tests/helpers/desktopWidth";
import { renderWithIntl } from "../../../../tests/helpers/intl";

// Raft DS › Navigation, "Opening an item": on desktop a computer opens like
// an agent's or a person's profile, in the side panel beside the Computers
// card wall (`?profile=computer:<id>`), with its icon and name in the head and
// × to close. A phone keeps the computer's own page with Back. Raft has no
// breadcrumbs. No feature flag reads it (the retired
// computers_rack_overview_v0): every flag is at its default, off.
// Assertions compare strings / booleans only (never DOM nodes).

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();
const initialProfileState = useProfileStore.getState();

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

function seed() {
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
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

let restoreWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = null;
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
  useProfileStore.setState(initialProfileState, true);
});

test("a computer's address: the side panel beside the card wall from 768px; otherwise its own page", () => {
  assert.equal(computerPath("/s/acme", "m1", true), "/s/acme/computers?profile=computer%3Am1");
  assert.equal(computerPath("/s/acme", "m1", false), "/s/acme/computer/m1");
  // A phone (no desktop width) pushes the computer's page.
  seed();
  assert.equal(currentComputerPath("/s/acme", "m1"), "/s/acme/computer/m1");
  restoreWidth = stubDesktopWidth();
  assert.equal(currentComputerPath("/s/acme", "m1"), "/s/acme/computers?profile=computer%3Am1");
});

test("the sidebar's computer row is selected while that computer is open, in the panel or as its page", () => {
  const at = (pathname: string, openComputerId: string | null) => ({ pathname, pathBase: "/s/acme", openComputerId });
  assert.equal(isComputerOpen("m1", at("/s/acme/computers", "m1")), true);
  assert.equal(isComputerOpen("m2", at("/s/acme/computers", "m1")), false);
  assert.equal(isComputerOpen("m1", at("/s/acme/computer/m1", null)), true);
  assert.equal(isComputerOpen("m1", at("/s/acme/machine/m1", null)), true);
  assert.equal(isComputerOpen("m1", at("/s/acme/computers", null)), false);
});

test("?profile=computer:<id> opens the computer in the profile store, and the store writes it back", () => {
  syncRightPanelStoresFromSearch("?profile=computer%3Am1");
  assert.equal(useProfileStore.getState().profileType, "computer");
  assert.equal(useProfileStore.getState().profileId, "m1");

  useProfileStore.getState().closeProfile();
  useProfileStore.getState().openProfile("computer", "m2");
  const navigations: Array<{ search: string; replace: boolean }> = [];
  syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/computers", search: "" },
    navigate: (to, options) => {
      navigations.push({ search: to.search, replace: options.replace });
    },
  });
  assert.equal(navigations.length, 1);
  assert.equal(new URLSearchParams(navigations[0]!.search).get("profile"), "computer:m2");
});

test("the head is the computer's icon and name, with no breadcrumb", () => {
  seed();
  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computer/m1"]}>
      <MachineDetailPanel machine={machine} />
    </MemoryRouter>,
  );
  assert.equal(screen.queryByTestId("machine-breadcrumb") === null, true);
  assert.equal(screen.queryByTestId("machine-breadcrumb-computers") === null, true);
  const header = screen.getByTestId("machine-panel-header");
  assert.equal(header.querySelector("h2")?.textContent, "mac-mini");
  // The icon belongs to the title beside it: nothing between them.
  assert.equal(header.querySelector("svg.lucide") !== null, true);
  assert.equal(header.textContent?.includes("Computers"), false);
});

test("the phone's own page (no side panel) has Back and no ×", () => {
  seed();
  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computer/m1"]}>
      <MachineDetailPanel machine={machine} />
    </MemoryRouter>,
  );
  assert.equal(screen.queryByTestId("machine-mobile-back") !== null, true);
  assert.equal(screen.queryByTestId("machine-panel-close") === null, true);
  assert.equal(screen.queryByTestId("machine-breadcrumb") === null, true);
});

function renderComputerProfile(id = "m1") {
  // ProfilePanel reads the window's width (jsdom has no matchMedia).
  restoreWidth = stubDesktopWidth();
  useProfileStore.getState().openProfile("computer", id);
  return renderWithIntl(
    <MemoryRouter initialEntries={[`/s/acme/computers?profile=computer%3A${id}`]}>
      <ConnectedProfilePanel />
    </MemoryRouter>,
  );
}

test("the profile panel shows a computer: its name in the head at once, then its detail; × closes it", async () => {
  seed();
  renderComputerProfile();
  assert.equal(screen.getByTestId("profile-panel").getAttribute("data-profile-type"), "computer");
  // Drawn from the computer the list already has, before the detail's code arrives.
  assert.equal(screen.getByTestId("machine-panel-header").querySelector("h2")?.textContent, "mac-mini");
  // Focus moves into the panel when it opens.
  assert.equal(document.activeElement?.getAttribute("data-testid"), "computer-profile");
  await waitFor(() => assert.equal(screen.queryByTestId("machine-connection-status") !== null, true));
  // One head: the detail below it draws none of its own.
  assert.equal(screen.getAllByTestId("machine-panel-header").length, 1);
  // × is named by its title, as on a person's profile.
  assert.equal(screen.getByTestId("machine-panel-close").getAttribute("title"), "Close");
  fireEvent.click(screen.getByTestId("machine-panel-close"));
  assert.equal(useProfileStore.getState().profileId, null);
});

test("closing the panel gives focus back to what opened it", async () => {
  seed();
  const opener = document.createElement("button");
  opener.setAttribute("data-testid", "opener");
  document.body.append(opener);
  try {
    opener.focus();
    renderComputerProfile();
    assert.equal(document.activeElement?.getAttribute("data-testid"), "computer-profile");
    fireEvent.click(screen.getByTestId("machine-panel-close"));
    assert.equal(useProfileStore.getState().profileId, null);
    await waitFor(() => assert.equal(document.activeElement?.getAttribute("data-testid"), "opener"));
  } finally {
    opener.remove();
  }
});

test("Esc closes the panel, unless something in it handled that Esc first (cancelling a rename)", () => {
  seed();
  renderComputerProfile();
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  document.dispatchEvent(handled);
  assert.equal(useProfileStore.getState().profileId, "m1");
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(useProfileStore.getState().profileId, null);
});

test("an unknown computer says so in the panel, which keeps its ×", () => {
  seed();
  renderComputerProfile("gone");
  assert.equal(screen.queryByTestId("machine-panel-close") !== null, true);
  assert.equal(screen.getByTestId("profile-panel").textContent?.includes("Computer not found"), true);
});

async function mountMachineRoute(path: string) {
  const mod = await import("../../../components/layout/MainLayout");
  const MachineRoute = (mod as unknown as { __testInternals: { MachineRoute: ComponentType } }).__testInternals.MachineRoute;
  return renderWithIntl(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/s/:slug/computer/:machineId" element={<MachineRoute />} />
        <Route path="/s/:slug/machine/:machineId" element={<MachineRoute />} />
        <Route path="/s/:slug/computers" element={<span data-testid="computers-page" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

test("desktop: /computer/<id> (and the legacy /machine/<id>) lands on Computers with the computer's panel", async () => {
  seed();
  restoreWidth = stubDesktopWidth();
  await mountMachineRoute("/s/acme/computer/m1");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/computers?profile=computer%3Am1"));
  assert.equal(screen.queryByTestId("computers-page") !== null, true);
  cleanup();
  await mountMachineRoute("/s/acme/machine/m1");
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/acme/computers?profile=computer%3Am1"));
});

test("phone: /computer/<id> stays the computer's own page with Back", async () => {
  seed();
  await mountMachineRoute("/s/acme/computer/m1");
  await waitFor(() => assert.equal(screen.queryByTestId("machine-mobile-back") !== null, true));
  assert.equal(screen.getByTestId("location").textContent, "/s/acme/computer/m1");
  assert.equal(screen.queryByTestId("machine-breadcrumb") === null, true);
});

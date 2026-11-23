import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { useState } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { MachineAgentList } from "../MachineAgentList";
import { MachineDetailPanel } from "../MachineDetailPanel";
import type { Agent } from "../../../store/agentStore";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { resetServerFeatureFlagsForTests, resolveServerFeatureFlagsForTests } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { renderWithIntl } from "../../../../tests/helpers/intl";

// Raft DS › Components, "Toolbar for selected items": selecting agents on a
// Computer's page uses the same floating toolbar as tasks and messages
// (raft-ui SelectionToolbar), in the page's dock outside the scroller, not a
// row of coloured buttons inside the list. Select all leads; at 0 the toolbar
// stays with its actions off; × and Escape end selecting and give focus back
// to Select. Assertions compare strings / booleans only (never DOM nodes).

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

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

function agent(id: string, name: string): Agent {
  return {
    id,
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name,
    displayName: name,
    avatarUrl: null,
    description: null,
    status: "stopped",
    model: "gpt-5",
    runtime: "codex",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: "m1",
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
  };
}

function machine(status: Machine["status"]): Machine {
  return {
    id: "m1",
    name: "mac-mini",
    description: null,
    status,
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["codex"],
    hostname: "mac-mini.local",
    os: "darwin",
    daemonVersion: null,
    isComputer: true,
    computerVersion: "1.0.0",
    computerUpgradeAvailable: false,
    lastHeartbeat: null,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

const noop = () => {};

function Page({ status }: { status: Machine["status"] }) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <div data-testid="scroller">
        <MachineAgentList machine={machine(status)} canManageMachines canControl={false} canViewRuntimeAccountUsage={false} selectionDock={dock} onSelectingChange={noop} />
      </div>
      <div ref={setDock} data-testid="dock" />
    </MemoryRouter>
  );
}

function seed() {
  useAgentStore.setState({
    agents: [agent("a1", "Ada"), agent("a2", "Bo")],
    activityLogs: {},
    agentActivities: {},
    loading: false,
  } as never);
}

const bar = () => within(screen.getByTestId("dock")).getByRole("toolbar", { name: "Selected agents" });
const disabled = (name: string) => (within(bar()).getByRole("button", { name }) as HTMLButtonElement).disabled;

afterEach(() => {
  cleanup();
  resetServerFeatureFlagsForTests();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

test("the Computer page gives the list its dock, and keeps its last content clear of the toolbar while selecting", () => {
  seed();
  const online = machine("online");
  useServerStore.setState({ current: server, members: [] });
  resolveServerFeatureFlagsForTests(server.id);
  useMachineStore.setState({
    machines: [online],
    loading: false,
    loadStatus: "loaded",
    computerOperationProgress: {},
    loadMachines: async () => {},
  } as never);
  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/computer/m1"]}>
      <MachineDetailPanel machine={online} />
    </MemoryRouter>,
  );
  assert.equal(screen.queryByTestId("machine-agents-selection-clearance") === null, true);

  fireEvent.click(screen.getByRole("button", { name: "Select" }));

  const dock = screen.getByTestId("machine-agents-selection-dock");
  assert.equal(within(dock).getByRole("toolbar", { name: "Selected agents" }).getAttribute("data-testid"), "machine-agents-selection-bar");
  assert.equal(screen.queryByTestId("machine-agents-selection-clearance") === null, false);

  fireEvent.click(within(dock).getByRole("button", { name: "Clear selection" }));
  assert.equal(within(dock).queryByRole("toolbar") === null, true);
  assert.equal(screen.queryByTestId("machine-agents-selection-clearance") === null, true);
});

test("Select opens the toolbar in the page's dock, with nothing selected and its actions off", () => {
  seed();
  renderWithIntl(<Page status="online" />);
  assert.equal(within(screen.getByTestId("dock")).queryByRole("toolbar") === null, true);

  fireEvent.click(screen.getByRole("button", { name: "Select" }));

  assert.equal(within(screen.getByTestId("scroller")).queryByRole("toolbar") === null, true);
  assert.equal(within(bar()).getByTestId("selection-toolbar-count").textContent, "0 selected");
  assert.equal(disabled("Start"), true);
  assert.equal(disabled("Stop"), true);
  assert.equal(disabled("Restart / reset"), true);
  assert.equal(disabled("Change model"), true);
  // The header's Select, Select all and Cancel give way to the toolbar's own controls.
  assert.equal(screen.queryByRole("button", { name: "Select" }) === null, true);
  assert.equal(screen.queryByRole("button", { name: "Cancel" }) === null, true);
});

test("the select-all box selects every agent from none, and clears from some", () => {
  seed();
  renderWithIntl(<Page status="online" />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  const all = () => within(bar()).getByRole("checkbox", { name: "Select all" });

  fireEvent.click(all());
  // Every agent selected: the count says so, the words for the checked box beside it.
  assert.equal(within(bar()).getByTestId("selection-toolbar-count").textContent, "All 2 selected");
  assert.equal(all().getAttribute("aria-checked"), "true");
  // Both are stopped: Start is on, Stop has nothing to stop.
  assert.equal(disabled("Start"), false);
  assert.equal(disabled("Stop"), true);
  assert.equal(disabled("Change model"), false);

  fireEvent.click(all());
  assert.equal(within(bar()).getByTestId("selection-toolbar-count").textContent, "0 selected");
});

test("on an offline computer the toolbar says so, and Start and Restart are off", () => {
  seed();
  renderWithIntl(<Page status="offline" />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(within(bar()).getByRole("checkbox", { name: "Select all" }));

  assert.equal(within(bar()).getByText("Computer offline").textContent, "Computer offline");
  assert.equal(disabled("Start"), true);
  assert.equal(disabled("Restart / reset"), true);
  assert.equal(disabled("Change model"), false);
});

test("× and Escape end selecting and give focus back to Select", () => {
  seed();
  renderWithIntl(<Page status="online" />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(within(bar()).getByRole("button", { name: "Clear selection" }));
  assert.equal(within(screen.getByTestId("dock")).queryByRole("toolbar") === null, true);
  assert.equal(document.activeElement?.textContent, "Select");

  // Escape works from anywhere on the page: after Select, focus is on a row or nowhere, not in the toolbar.
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  const taken = !fireEvent.keyDown(document.body, { key: "Escape" });
  assert.equal(taken, true, "the page's Escape is taken, so the side panel's own Escape does not close the Computer");
  assert.equal(within(screen.getByTestId("dock")).queryByRole("toolbar") === null, true);
  assert.equal(document.activeElement?.textContent, "Select");
});

test("Escape is left to a dialog over the page", () => {
  seed();
  renderWithIntl(<Page status="online" />);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(within(bar()).getByRole("checkbox", { name: "Select all" }));
  fireEvent.click(within(bar()).getByRole("button", { name: "Restart / reset" }));
  assert.equal(screen.queryByRole("dialog") === null, false);

  // The dialog's Escape is its own (it closes the dialog); selecting goes on.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  assert.equal(within(bar()).getByTestId("selection-toolbar-count").textContent, "All 2 selected");
});

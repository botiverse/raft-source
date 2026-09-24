import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import ComputerCommandGuide from "../src/components/machine/ComputerCommandGuide";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { TestIntlProvider } from "./helpers/intl";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function seedComputerStores() {
  useServerStore.setState({
    current: {
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
    },
    members: [],
  } as never);
  useAgentStore.setState({ agents: [] } as never);
  useMachineStore.setState({ computerOperationProgress: {} } as never);
}

const onlineComputer: Machine = {
  id: "computer-1",
  name: "Studio",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["claude"],
  hostname: "studio.local",
  os: "darwin",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: "2026-08-08T00:00:00.000Z",
  createdAt: "2026-08-08T00:00:00.000Z",
};

function agent(id: string, status: Agent["status"]): Agent {
  return {
    id,
    name: id,
    displayName: id === "offline-agent" ? "Offline Agent" : "Online Agent",
    avatarUrl: null,
    description: null,
    status,
    model: "sonnet",
    runtime: "claude",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "byoc",
    envVars: null,
    machineId: onlineComputer.id,
    sessionId: `${id}-session`,
    runtimeProfile: null,
    creatorType: "user",
    creatorId: "user-1",
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
}

function seedBulkControlStores(calls: {
  start: string[];
  stop: string[];
  reset: Array<[string, "restart" | "session" | "full"]>;
}) {
  seedComputerStores();
  useAgentStore.setState({
    agents: [agent("offline-agent", "stopped"), agent("online-agent", "active")],
    startAgent: async (id: string) => { calls.start.push(id); },
    stopAgent: async (id: string) => { calls.stop.push(id); },
    resetAgent: async (id: string, mode: "restart" | "session" | "full") => {
      calls.reset.push([id, mode]);
    },
  } as never);
}

function renderBulkControls() {
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={onlineComputer} workspaceEmbedded />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

function enterSelectionAndChooseBoth() {
  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.select"] }));
  const offline = screen.getByRole("button", { name: "Select Offline Agent" });
  const online = screen.getByRole("button", { name: "Select Online Agent" });
  fireEvent.click(offline);
  fireEvent.click(online);
  return { offline, online };
}

test("catalog pins computer residue MessageIds", () => {
  assert.equal(en["machine.detail.computer"], "Computer");
  assert.equal(en["machine.detail.macLinux"], "macOS / Linux");
  assert.equal(en["machine.detail.osLabel"], "OS");
  assert.equal(zh["machine.detail.computer"], "计算机");
  assert.equal(zh["machine.detail.macLinux"], "macOS / Linux");
  assert.equal(zh["machine.detail.osLabel"], "OS");
});

test("mounted ComputerCommandGuide keeps the macOS / Linux runtime label under zh-cn", () => {
  render(
    <TestIntlProvider locale="zh-cn">
      <ComputerCommandGuide
        computerCommand="raft-computer setup /launch"
        computerInstallCommand="curl -fsSL https://downloads.raft.build/computer/install.sh | sh"
        windowsComputerCommand="raft-computer setup /launch"
        windowsComputerInstallCommand="irm https://cdn.raft.build/computer/install.ps1 | iex"
        macLinuxDaemonCommand="npx @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_abc"
        windowsDaemonCommand="npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_abc"
      />
    </TestIntlProvider>,
  );

  assert.ok(screen.getByRole("radio", { name: zh["machine.detail.macLinux"] }));
});

test("mounted MachineDetailPanel surfaces Chinese Computer chrome and the OS row", () => {
  seedComputerStores();
  render(
    <TestIntlProvider locale="zh-cn">
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={onlineComputer} workspaceEmbedded />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(screen.getByText(zh["machine.detail.osLabel"]));
  assert.ok(screen.getByText("darwin"));
  const actions = screen.getByTestId("computer-service-actions");
  assert.ok(screen.getByText(zh["machine.detail.computer"]));
  assert.equal(actions.querySelector(".text-sm.font-bold")?.textContent, zh["machine.detail.computer"]);
});

test("online Computer keeps restart available while its version is still syncing", () => {
  seedComputerStores();
  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel
          machine={{ ...onlineComputer, computerVersion: null, computerUpgradeAvailable: null }}
          workspaceEmbedded
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const actions = screen.getByTestId("computer-service-actions");
  const restart = within(actions).getByRole("button", { name: en["machine.detail.restart"] });
  assert.equal(restart.hasAttribute("disabled"), false);
  assert.equal(
    within(actions).getByRole("button", { name: en["machine.detail.upgrade"] }).hasAttribute("disabled"),
    true,
  );
  assert.ok(within(actions).getByText(en["machine.detail.versionStillSyncing"]));
});

test("mounted MachineDetail selection rows expose live yellow markers and clear/cancel controls", () => {
  const calls = { start: [] as string[], stop: [] as string[], reset: [] as Array<[string, "restart" | "session" | "full"]> };
  seedBulkControlStores(calls);
  const view = renderBulkControls();

  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.select"] }));
  const offline = screen.getByRole("button", { name: "Select Offline Agent" });
  const marker = offline.querySelector(".check-marker-brutal");
  assert.ok(marker);
  assert.match(marker.className, /bg-white text-transparent/);

  fireEvent.click(offline);
  assert.match(marker.className, /bg-soft-signal text-black/);
  assert.equal(screen.getByText("1 selected").textContent, "1 selected");
  assert.ok(screen.getByRole("button", { name: "Deselect Offline Agent" }));

  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.selectAll"] }));
  assert.equal(screen.getByText("2 selected").textContent, "2 selected");
  assert.equal(view.container.querySelectorAll(".check-marker-brutal.bg-soft-signal").length, 2);

  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.clearAll"] }));
  assert.equal(screen.queryByText("2 selected"), null);
  assert.ok(screen.getByRole("button", { name: "Select Offline Agent" }));

  fireEvent.click(screen.getByRole("button", { name: en["common.confirm.cancel"] }));
  assert.ok(screen.getByRole("button", { name: en["machine.detail.select"] }));
  assert.equal(screen.queryByRole("button", { name: "Select Offline Agent" }), null);
});

test("mounted MachineDetail bulk actions target offline, online, and all selected agents correctly", async () => {
  const calls = { start: [] as string[], stop: [] as string[], reset: [] as Array<[string, "restart" | "session" | "full"]> };
  seedBulkControlStores(calls);
  renderBulkControls();

  enterSelectionAndChooseBoth();
  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.start"] }));
  await waitFor(() => assert.deepEqual(calls.start, ["offline-agent"]));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: en["machine.detail.select"] })));
  assert.deepEqual(calls.stop, []);

  enterSelectionAndChooseBoth();
  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.stop"] }));
  const stopDialog = screen.getByRole("dialog", { name: en["machine.detail.stopAgentsTitle"] });
  assert.match(stopDialog.textContent ?? "", /Stop 1 selected online agent/);
  fireEvent.click(within(stopDialog).getByRole("button", { name: en["machine.detail.stopAgentsTitle"] }));
  await waitFor(() => assert.deepEqual(calls.stop, ["online-agent"]));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: en["machine.detail.select"] })));

  enterSelectionAndChooseBoth();
  fireEvent.click(screen.getByRole("button", { name: en["machine.detail.restartReset"] }));
  const resetDialog = screen.getByText("Restart 2 Agents").closest(".card-brutal");
  assert.ok(resetDialog);
  const restartButtons = within(resetDialog as HTMLElement).getAllByRole("button", { name: en["machine.detail.bulkRestart"] });
  fireEvent.click(restartButtons.at(-1)!);
  await waitFor(() => assert.deepEqual(calls.reset, [
    ["offline-agent", "restart"],
    ["online-agent", "restart"],
  ]));
});

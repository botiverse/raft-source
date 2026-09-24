import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { getComputerCommands } from "../src/utils/computerSetupCommand";
import { getServerUrl } from "../src/utils/server";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

function clickCopyButtonForCode(container: HTMLElement, command: string) {
  const code = within(container).getByText(command, { exact: true, selector: "code" });
  const button = code.parentElement?.querySelector("button");
  assert.ok(button, `copy button for ${command} should render beside its code row`);
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

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
  createdAt: "2026-07-13T00:00:00.000Z",
};

const machine: Machine = {
  id: "computer-1",
  name: "Offline Mac",
  description: null,
  status: "offline",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "offline-mac.local",
  os: "darwin",
  daemonVersion: "0.45.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "0.45.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: null,
  createdAt: "2026-07-13T00:00:00.000Z",
};

const onlineMachine: Machine = {
  ...machine,
  name: "Online Mac",
  status: "online",
  computerVersion: "1.0.7",
};

const onlineMachineWithoutRemoteUpgrade: Machine = {
  ...onlineMachine,
  computerUpgradeAvailable: false,
  computerBroadcastPolicy: {
    eligibility: "no_broadcast",
    targetVersion: null,
    targetRole: null,
    migrationClass: null,
    policyRevision: "policy-1",
    reasonCode: "source_not_eligible",
  },
};

const windowsMachine: Machine = {
  ...machine,
  name: "Offline Windows PC",
  hostname: "offline-windows.local",
  os: "win32",
};

test("offline managed Computer admin can expand and copy environment-correct Install and Setup commands", async () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const commands = getComputerCommands(server.slug, undefined, getServerUrl());
  assert.ok(commands);
  const clipboardWrites: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (command: string) => {
        clipboardWrites.push(command);
      },
    },
  });

  try {
    renderWithIntl(
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={machine} workspaceEmbedded />
      </MemoryRouter>,
    );

    const disclosure = screen.getByRole("button", {
      name: "raft-computer: command not found? Install or re-run setup",
    });
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    assert.equal(screen.queryByTestId("computer-recovery-install"), null);
    assert.equal(screen.queryByTestId("computer-recovery-setup"), null);

    fireEvent.click(disclosure);

    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.equal(screen.getByTestId("computer-recovery-install").textContent, commands.install);
    assert.equal(screen.getByTestId("computer-recovery-setup").textContent, commands.setup);

    fireEvent.click(screen.getByRole("button", { name: "Copy install command" }));
    await waitFor(() => assert.deepEqual(clipboardWrites, [commands.install]));

    fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }));
    await waitFor(() => assert.deepEqual(clipboardWrites, [commands.install, commands.setup]));
  } finally {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});

test("offline Windows Computer recovery uses PowerShell and the Windows executable bundle", () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const commands = getComputerCommands(server.slug, "staging", getServerUrl(), { platform: "windows" });
  assert.ok(commands);
  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel machine={windowsMachine} workspaceEmbedded deploymentEnv="staging" />
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("computer-recovery-restart").textContent, commands.restart);
  assert.equal(screen.getByTestId("computer-recovery-guide-install").textContent, commands.install);
  assert.ok(screen.getByText("2. Fresh install · Windows x64"));
  fireEvent.click(screen.getByRole("button", {
    name: "raft-computer: command not found? Install or re-run setup",
  }));
  assert.equal(screen.getByTestId("computer-recovery-install").textContent, commands.install);
  assert.equal(screen.getByTestId("computer-recovery-setup").textContent, commands.setup);
  assert.match(commands.install, /install\.ps1/);
  assert.match(commands.setup, /raft-computer\.exe" setup \/acme/);
  assert.doesNotMatch(`${commands.install}\n${commands.setup}`, /install\.sh|RAFT_HOME="\$HOME/);
});

test("legacy Windows machine page offers Experimental Computer migration and keeps the daemon block", () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const legacyWindowsMachine: Machine = {
    ...windowsMachine,
    id: "legacy-windows",
    isComputer: false,
    computerAttachedByCurrentUser: false,
    computerVersion: null,
    computerUpgradeAvailable: false,
  };
  const commands = getComputerCommands(server.slug, undefined, getServerUrl(), {
    machineId: legacyWindowsMachine.id,
    platform: "windows",
  });
  assert.ok(commands);

  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/legacy-windows"]}>
      <MachineDetailPanel machine={legacyWindowsMachine} workspaceEmbedded />
    </MemoryRouter>,
  );

  const migrate = screen.getByTestId("computer-migrate-block");
  assert.ok(within(migrate).getByText("Experimental"));
  assert.ok(within(migrate).getByText("Migrate to Computer · Windows x64"));
  assert.ok(within(migrate).getByText(commands.install, { exact: true, selector: "code" }));
  assert.ok(within(migrate).getByText(commands.setup, { exact: true, selector: "code" }));
  assert.ok(screen.getByTestId("legacy-daemon-block"));
  assert.equal(screen.queryByText(/Computer for Windows is in progress/), null);
});

test("online Computer without remote Upgrade shows a version-pinned fresh-install then restart path", async () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({
    computerOperationProgress: {},
    latestComputerVersion: "1.0.14",
  });

  const commands = getComputerCommands(
    server.slug,
    "staging",
    getServerUrl(),
    { version: "1.0.14" },
  );
  assert.ok(commands);
  const clipboardWrites: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (command: string) => {
        clipboardWrites.push(command);
      },
    },
  });

  try {
    renderWithIntl(
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel
          machine={onlineMachineWithoutRemoteUpgrade}
          workspaceEmbedded
          deploymentEnv="staging"
        />
      </MemoryRouter>,
    );

    const actions = screen.getByTestId("computer-service-actions");
    assert.match(
      actions.textContent ?? "",
      /Restart remains available; this source is not currently eligible for an upgrade\./,
    );
    assert.equal(
      screen.getByTestId("computer-upgrade-fresh-install").textContent,
      commands.install,
    );
    assert.equal(
      screen.getByTestId("computer-upgrade-fresh-restart").textContent,
      commands.restartService,
    );
    assert.match(commands.install, /RAFT_COMPUTER_VERSION=1\.0\.14/);
    assert.match(commands.restartService, /raft-computer"? restart$/);
    assert.doesNotMatch(commands.restartService, /\/acme/);

    fireEvent.click(
      within(actions).getByRole("button", {
        name: "Copy fresh install for upgrade command",
      }),
    );
    fireEvent.click(
      within(actions).getByRole("button", {
        name: "Copy restart after fresh install command",
      }),
    );

    await waitFor(() => {
      assert.deepEqual(clipboardWrites, [commands.install, commands.restartService]);
    });
  } finally {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});

for (const deploymentEnv of ["staging", "slockdev"] as const) {
  test(`healthy managed Computer keeps ${deploymentEnv} recovery commands out of the DOM until explicitly expanded`, async () => {
    useServerStore.setState({ current: server, members: [] });
    useAgentStore.setState({ agents: [] });
    useMachineStore.setState({ computerOperationProgress: {} });

    const commands = getComputerCommands(server.slug, deploymentEnv, getServerUrl());
    assert.ok(commands);
    const clipboardWrites: string[] = [];
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (command: string) => {
          clipboardWrites.push(command);
        },
      },
    });

    try {
      renderWithIntl(
        <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
          <MachineDetailPanel machine={onlineMachine} workspaceEmbedded deploymentEnv={deploymentEnv} />
        </MemoryRouter>,
      );

      const guide = screen.getByTestId("computer-recovery-guide");
      const disclosure = within(guide).getByRole("button", { name: "Show Recovery guide" });
      assert.equal(disclosure.tagName, "BUTTON");
      assert.equal(disclosure.getAttribute("aria-expanded"), "false");
      const collapsedChevron = within(guide).getByTestId("computer-recovery-guide-chevron");
      assert.ok(guide.querySelector("svg.lucide-chevron-right"), "collapsed guide uses the right-pointing chevron glyph");
      assert.equal(guide.querySelector("svg.lucide-chevron-down"), null, "collapsed guide does not use a down chevron glyph");
      assert.equal(collapsedChevron.classList.contains("rotate-90"), false);
      const controlId = disclosure.getAttribute("aria-controls");
      assert.match(controlId ?? "", /^computer-recovery-guide-content-/);
      assert.equal(screen.queryByTestId("computer-recovery-guide-content"), null);
      assert.equal(screen.queryByTestId("computer-recovery-guide-restart"), null);
      assert.equal(screen.queryByTestId("computer-recovery-guide-install"), null);

      fireEvent.click(disclosure);

      assert.equal(disclosure.getAttribute("aria-expanded"), "true");
      const expandedChevron = within(guide).getByTestId("computer-recovery-guide-chevron");
      assert.ok(guide.querySelector("svg.lucide-chevron-right"), "expanded guide keeps the right chevron glyph and rotates it");
      assert.equal(guide.querySelector("svg.lucide-chevron-down"), null, "expanded guide does not swap to a down glyph");
      assert.equal(expandedChevron.classList.contains("rotate-90"), true);
      const content = screen.getByTestId("computer-recovery-guide-content");
      assert.equal(content.id, controlId);
      const terminalVerification = screen.getByTestId("computer-terminal-verification");
      assert.match(content.textContent ?? "", /1\. Restart/);
      assert.match(content.textContent ?? "", /2\. Fresh install/);
      assert.match(content.textContent ?? "", /3\. Restart after install/);
      assert.doesNotMatch(content.textContent ?? "", /Stop, then start/);
      assert.equal(screen.getByTestId("computer-recovery-guide-restart").textContent, commands.restart);
      assert.equal(screen.getByTestId("computer-recovery-guide-install").textContent, commands.install);
      assert.equal(
        screen.getByTestId("computer-recovery-guide-restart-after-install").textContent,
        commands.restartService,
      );
      assert.equal(within(terminalVerification).getByText(commands.status, { exact: true, selector: "code" }).textContent, commands.status);
      assert.equal(within(terminalVerification).getByText(commands.doctor, { exact: true, selector: "code" }).textContent, commands.doctor);
      assert.equal(within(terminalVerification).getByText(commands.restart, { exact: true, selector: "code" }).textContent, commands.restart);
      assert.doesNotMatch(guide.textContent ?? "", /clear state|remove credentials|delete identity/i);

      clickCopyButtonForCode(terminalVerification, commands.status);
      clickCopyButtonForCode(terminalVerification, commands.doctor);
      clickCopyButtonForCode(terminalVerification, commands.restart);
      clickCopyButtonForCode(content, commands.install);
      clickCopyButtonForCode(content, commands.restartService);

      await waitFor(() => {
        assert.deepEqual(clipboardWrites, [
          commands.status,
          commands.doctor,
          commands.restart,
          commands.install,
          commands.restartService,
        ]);
      });

      fireEvent.click(within(guide).getByRole("button", { name: "Hide Recovery guide" }));
      assert.equal(disclosure.getAttribute("aria-expanded"), "false");
      assert.equal(screen.queryByTestId("computer-recovery-guide-content"), null);
      assert.equal(screen.queryByRole("button", { name: "Copy fresh install command" }), null);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
}

test("offline managed Computer auto-expands on each abnormal transition but still allows an explicit collapse", () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const { rerender } = renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded deploymentEnv="staging" />
    </MemoryRouter>,
  );

  const guide = screen.getByTestId("computer-recovery-guide");
  const disclosure = within(guide).getByRole("button", { name: "Hide Recovery guide" });
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.ok(guide.querySelector("svg.lucide-chevron-right"));
  assert.equal(guide.querySelector("svg.lucide-chevron-down"), null);
  assert.equal(within(guide).getByTestId("computer-recovery-guide-chevron").classList.contains("rotate-90"), true);
  assert.ok(screen.getByTestId("computer-recovery-guide-content"));

  fireEvent.click(disclosure);
  assert.equal(within(guide).getByRole("button", { name: "Show Recovery guide" }).getAttribute("aria-expanded"), "false");
  assert.ok(guide.querySelector("svg.lucide-chevron-right"));
  assert.equal(guide.querySelector("svg.lucide-chevron-down"), null);
  assert.equal(within(guide).getByTestId("computer-recovery-guide-chevron").classList.contains("rotate-90"), false);
  assert.equal(screen.queryByTestId("computer-recovery-guide-content"), null);

  rerender(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={onlineMachine} workspaceEmbedded deploymentEnv="staging" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.equal(screen.getByRole("button", { name: "Show Recovery guide" }).getAttribute("aria-expanded"), "false");

  rerender(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={machine} workspaceEmbedded deploymentEnv="staging" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
  assert.equal(screen.getByRole("button", { name: "Hide Recovery guide" }).getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByTestId("computer-recovery-guide-content"));
});

test("an online-to-offline status transition overrides the stale healthy disclosure choice and exposes recovery", () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const { rerender } = renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <MachineDetailPanel machine={onlineMachine} workspaceEmbedded deploymentEnv="staging" />
    </MemoryRouter>,
  );

  const healthyGuide = screen.getByTestId("computer-recovery-guide");
  const show = within(healthyGuide).getByRole("button", { name: "Show Recovery guide" });
  fireEvent.click(show);
  fireEvent.click(within(healthyGuide).getByRole("button", { name: "Hide Recovery guide" }));
  assert.equal(screen.queryByTestId("computer-recovery-guide-content"), null);

  rerender(
    <TestIntlProvider>
      <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
        <MachineDetailPanel machine={machine} workspaceEmbedded deploymentEnv="staging" />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const offlineDisclosure = within(screen.getByTestId("computer-recovery-guide"))
    .getByRole("button", { name: "Hide Recovery guide" });
  assert.equal(offlineDisclosure.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByTestId("computer-recovery-guide-content"));
});

test("multiple Computer panels keep each recovery disclosure control target unique", () => {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  const secondMachine: Machine = {
    ...onlineMachine,
    id: "computer-2",
    name: "Second Online Mac",
    hostname: "second-online-mac.local",
  };

  renderWithIntl(
    <MemoryRouter initialEntries={["/s/acme/settings/computers/computer-1"]}>
      <div>
        <MachineDetailPanel machine={onlineMachine} workspaceEmbedded deploymentEnv="staging" />
        <MachineDetailPanel machine={secondMachine} workspaceEmbedded deploymentEnv="staging" />
      </div>
    </MemoryRouter>,
  );

  const guides = screen.getAllByTestId("computer-recovery-guide");
  assert.equal(guides.length, 2);
  const disclosures = guides.map((guide) => within(guide).getByRole("button", { name: "Show Recovery guide" }));
  const controlIds = disclosures.map((disclosure) => disclosure.getAttribute("aria-controls"));
  assert.equal(controlIds.every(Boolean), true);
  assert.equal(new Set(controlIds).size, 2);

  disclosures.forEach((disclosure) => fireEvent.click(disclosure));
  const contents = screen.getAllByTestId("computer-recovery-guide-content");
  assert.equal(contents.length, 2);
  assert.deepEqual(contents.map((content) => content.id), controlIds);
});

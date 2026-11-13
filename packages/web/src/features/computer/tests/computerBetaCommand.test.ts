import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { MachineDetailPanel } from "../MachineDetailPanel";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { getComputerCommands } from "../../../utils/computerSetupCommand";
import { getServerUrl } from "../../../utils/server";
import { renderWithIntl } from "../../../../tests/helpers/intl";

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

test("machine detail copy buttons copy command to clipboard", async () => {
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
      createElement(
        MemoryRouter,
        { initialEntries: ["/s/acme/settings/computers/computer-1"] },
        createElement(MachineDetailPanel, { machine, hideHeader: true }),
      ),
    );

    const restartCode = screen.getByTestId("computer-recovery-restart");
    assert.ok(restartCode.closest("code"), "restart command must keep code semantics");
    const copyButton = restartCode.closest("[data-slot='copyable-code-root']")?.querySelector("button");
    assert.ok(copyButton, "copy button must render beside code");
    fireEvent.click(copyButton);

    await waitFor(() => {
      assert.deepEqual(clipboardWrites, [commands.restart]);
    });
  } finally {
    cleanup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});


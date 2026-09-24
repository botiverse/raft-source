import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ReactElement } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ServerRole } from "@botiverse/raft-shared";

import { useSystemNotifications } from "../src/components/layout/useSystemNotifications";
import type { SystemNotificationSurface } from "../src/components/layout/useSystemNotifications";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

function makeServer(role: ServerRole): Server {
  return {
    id: "server-1",
    name: "Server One",
    avatarUrl: null,
    slug: "server-one",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: new Date(0).toISOString(),
  };
}

function makeMachine(overrides: Partial<Machine>): Machine {
  return {
    id: "machine-1",
    name: "Machine One",
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: null,
    os: "darwin",
    daemonVersion: "1.0.0",
    lastHeartbeat: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function seedMachineNotificationWorld(role: ServerRole): void {
  useServerStore.setState({
    current: makeServer(role),
    members: [],
  });
  useMachineStore.setState({
    machines: [
      makeMachine({
        id: "offline-machine",
        name: "Offline Mac",
        status: "offline",
      }),
      makeMachine({
        id: "outdated-machine",
        name: "Old Mac",
        daemonVersion: "0.1.0",
      }),
      makeMachine({
        id: "offline-computer",
        name: "Offline Computer",
        status: "offline",
        isComputer: true,
        computerUpgradeAvailable: false,
      }),
      makeMachine({
        id: "upgrade-computer",
        name: "Upgrade Computer",
        isComputer: true,
        computerUpgradeAvailable: true,
      }),
    ],
    latestComputerVersion: "1.2.3",
    latestDaemonVersion: "1.0.0",
    loading: false,
  });
  useAgentStore.setState({
    agents: [],
    loading: false,
  });
}

function renderNotifications(surface?: SystemNotificationSurface) {
  return renderHook(() => useSystemNotifications(surface), {
    wrapper({ children }) {
      return (
        <TestIntlProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </TestIntlProvider>
      );
    },
  });
}

function renderNotificationsZh(surface?: SystemNotificationSurface) {
  return renderHook(() => useSystemNotifications(surface), {
    wrapper({ children }) {
      return (
        <TestIntlProvider locale="zh-cn">
          <MemoryRouter>{children}</MemoryRouter>
        </TestIntlProvider>
      );
    },
  });
}

afterEach(() => {
  cleanup();
  useServerStore.getState().clearCurrent();
  useMachineStore.setState({
    machines: [],
    latestDaemonVersion: null,
    latestComputerVersion: null,
    loading: true,
    selectedMachineId: null,
    showAddMachine: false,
    pendingApiKey: null,
    pendingMachineId: null,
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
  });
  useAgentStore.setState({
    agents: [],
    loading: true,
  });
});

test("members receive machine system notifications through viewMachines", () => {
  seedMachineNotificationWorld("member");

  const { result } = renderNotifications();

  const ids = result.current.map((notification) => notification.id);
  assert.ok(ids.includes("machine-offline"));
  assert.ok(ids.includes("machine-outdated"));
});

test("machine managers see machine system notifications", () => {
  seedMachineNotificationWorld("admin");

  const { result } = renderNotifications();

  const ids = result.current.map((notification) => notification.id);
  assert.ok(ids.includes("machine-offline"));
  assert.ok(ids.includes("machine-outdated"));
  assert.ok(!ids.includes("computer-attention"));
  assert.ok(
    result.current.every((notification) => !notification.title.includes("Computer")),
    "desktop notification center must not list managed Computer status by name",
  );
});

test("mobile machine managers see one anonymous managed Computer aggregate", () => {
  seedMachineNotificationWorld("admin");

  const { result } = renderNotifications("mobile");

  const entry = result.current.find((notification) => notification.id === "computer-attention");
  assert.ok(entry);
  assert.equal(entry.title, "Computers need attention");
  assert.equal((entry.body as ReactElement<{ children: string }>).props.children, "1 needs upgrade · 1 offline");
  assert.ok(!entry.title.includes("Offline Computer"));
  assert.ok(!entry.title.includes("Upgrade Computer"));
});

test("mobile managed Computer aggregate follows the app locale", () => {
  seedMachineNotificationWorld("admin");

  const { result } = renderNotificationsZh("mobile");

  const entry = result.current.find((notification) => notification.id === "computer-attention");
  assert.ok(entry);
  assert.equal(entry.title, "Computer 需要处理");
  assert.equal((entry.body as ReactElement<{ children: string }>).props.children, "1 台需要升级 · 1 台离线");
  assert.equal(entry.title.includes("Computers need attention"), false);
});

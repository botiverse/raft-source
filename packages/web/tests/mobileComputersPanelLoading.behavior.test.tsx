import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import MobileComputersPanel from "../src/components/machine/MobileComputersPanel";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const server: Server = {
  id: "server-1",
  name: "Server One",
  avatarUrl: null,
  slug: "server-one",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: new Date(0).toISOString(),
};

const otherServer: Server = { ...server, id: "server-2", slug: "server-two", name: "Server Two" };

const machine: Machine = {
  id: "machine-1",
  name: "Build Mac",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "build-mac",
  os: "darwin",
  daemonVersion: "1.0.0",
  lastHeartbeat: null,
  createdAt: new Date(0).toISOString(),
};

function renderPanel() {
  useServerStore.setState({ current: server, members: [] });
  return render(
    <MemoryRouter initialEntries={["/s/server-one/computers"]}>
      <MobileComputersPanel />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useServerStore.getState().clearCurrent();
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });
});

test("loading transitions directly to computer rows without a false empty state", () => {
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });
  renderPanel();

  assert.ok(screen.getByTestId("computers-loading-skeleton"));
  assert.equal(screen.queryByText("No computers yet"), null);

  act(() => useMachineStore.setState({ machines: [machine], loading: false, loadStatus: "loaded", loadError: false }));

  assert.equal(screen.queryByTestId("computers-loading-skeleton"), null);
  assert.ok(screen.getByTestId("computer-list-item-machine-1"));
  assert.equal(screen.queryByText("No computers yet"), null);
});

test("mobile rows use one icon dot and preserve offline detail when upgrade wins", () => {
  const managedOnline: Machine = {
    ...machine,
    id: "managed-online",
    name: "Managed Online",
    isComputer: true,
    computerUpgradeAvailable: false,
  };
  const managedOffline: Machine = {
    ...managedOnline,
    id: "managed-offline",
    name: "Managed Offline",
    status: "offline",
  };
  const managedOfflineUpgrade: Machine = {
    ...managedOffline,
    id: "managed-offline-upgrade",
    name: "Managed Offline Upgrade",
    computerUpgradeAvailable: true,
    computerBroadcastPolicy: {
      eligibility: "eligible",
      targetVersion: "0.0.50",
      targetRole: "independent_bugfix",
      migrationClass: "seamless",
      policyRevision: "policy-test-v1",
      reasonCode: "eligible",
    },
  };
  const legacyOnline: Machine = {
    ...machine,
    id: "legacy-online",
    name: "Legacy Online",
    isComputer: false,
    computerUpgradeAvailable: true,
  };
  const legacyOffline: Machine = {
    ...legacyOnline,
    id: "legacy-offline",
    name: "Legacy Offline",
    status: "offline",
  };

  useMachineStore.setState({
    machines: [managedOnline, managedOffline, managedOfflineUpgrade, legacyOnline, legacyOffline],
    loading: false,
    loadStatus: "loaded",
    loadError: false,
  });
  renderPanel();

  const onlineDot = screen.getByTestId("computer-status-dot-managed-online");
  assert.ok(onlineDot.className.includes("bg-brutal-lime"));
  assert.equal(onlineDot.getAttribute("title"), "Online");

  const offlineDot = screen.getByTestId("computer-status-dot-managed-offline");
  assert.ok(offlineDot.className.includes("bg-gray-400"));
  assert.equal(offlineDot.getAttribute("title"), "Offline");

  const offlineUpgradeDot = screen.getByTestId("computer-status-dot-managed-offline-upgrade");
  assert.ok(offlineUpgradeDot.className.includes("bg-brutal-pink"));
  assert.equal(
    offlineUpgradeDot.getAttribute("title"),
    "Computer upgrade available: v0.0.50 · Computer offline",
  );
  assert.match(screen.getByTestId("computer-list-item-managed-offline-upgrade").textContent ?? "", /computer offline/);

  assert.ok(screen.getByTestId("computer-status-dot-legacy-online").className.includes("bg-brutal-lime"));
  assert.ok(screen.getByTestId("computer-status-dot-legacy-offline").className.includes("bg-gray-400"));

  for (const id of [
    "managed-online",
    "managed-offline",
    "managed-offline-upgrade",
    "legacy-online",
    "legacy-offline",
  ]) {
    assert.equal(
      screen.getByTestId(`computer-list-item-${id}`).querySelectorAll('[data-testid^="computer-status-dot-"]').length,
      1,
      `${id} keeps exactly one status dot`,
    );
  }
});

test("loading transitions to the true empty state only after fetch terminal", () => {
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });
  renderPanel();

  assert.ok(screen.getByTestId("computers-loading-skeleton"));
  assert.equal(screen.queryByText("No computers yet"), null);

  act(() => useMachineStore.setState({ machines: [], loading: false, loadStatus: "loaded", loadError: false }));

  assert.equal(screen.queryByTestId("computers-loading-skeleton"), null);
  assert.ok(screen.getByText("No computers yet"));
});

test("current-server fetch failure renders error without exposing empty or add", async (t) => {
  t.mock.method(api, "get", async () => {
    throw new Error("network unavailable");
  });
  t.mock.method(console, "error", () => {});
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });
  renderPanel();

  await act(async () => useMachineStore.getState().loadMachines());

  assert.ok(screen.getByText("Couldn't load computers"));
  assert.equal(screen.queryByText("No computers yet"), null);
  assert.equal(screen.queryByTestId("computers-add-row"), null);
});

test("stale old-server success cannot publish a terminal state into the new server", async (t) => {
  let resolveRequest: ((value: { data: Machine[] }) => void) | undefined;
  const pending = new Promise<{ data: Machine[] }>((resolve) => {
    resolveRequest = resolve;
  });
  t.mock.method(api, "get", async () => pending);
  useServerStore.setState({ current: server, members: [], serverEpoch: 10 });
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });

  const oldServerLoad = useMachineStore.getState().loadMachines();
  act(() => {
    useServerStore.getState().setCurrent(otherServer);
  });
  resolveRequest?.({ data: [machine] });
  await oldServerLoad;

  assert.equal(useServerStore.getState().current?.id, "server-2");
  assert.equal(useMachineStore.getState().loading, true);
  assert.equal(useMachineStore.getState().loadStatus, "loading");
  assert.deepEqual(useMachineStore.getState().machines, []);
});

test("cached rows remain usable when a current-server refresh fails", async (t) => {
  t.mock.method(api, "get", async () => {
    throw new Error("refresh unavailable");
  });
  t.mock.method(console, "error", () => {});
  useMachineStore.setState({
    machines: [machine],
    loading: false,
    loadStatus: "loaded",
    loadError: false,
  });
  renderPanel();

  await act(async () => useMachineStore.getState().loadMachines());

  assert.ok(screen.getByTestId("computers-refresh-error"));
  assert.ok(screen.getByTestId("computer-list-item-machine-1"));
  assert.ok(screen.getByTestId("computers-add-row"));
  assert.equal(screen.queryByText("No computers yet"), null);
  assert.equal(useMachineStore.getState().loadStatus, "loaded");
  assert.equal(useMachineStore.getState().loadError, true);
});

test("stale old-server failure cannot publish an error into the new server", async (t) => {
  let rejectRequest: ((reason: Error) => void) | undefined;
  const pending = new Promise<{ data: Machine[] }>((_, reject) => {
    rejectRequest = reject;
  });
  t.mock.method(api, "get", async () => pending);
  t.mock.method(console, "error", () => {});
  useServerStore.setState({ current: server, members: [], serverEpoch: 20 });
  useMachineStore.setState({ machines: [], loading: true, loadStatus: "loading", loadError: false });

  const oldServerLoad = useMachineStore.getState().loadMachines();
  act(() => {
    useServerStore.getState().setCurrent(otherServer);
  });
  rejectRequest?.(new Error("old server failed"));
  await oldServerLoad;

  assert.equal(useServerStore.getState().current?.id, "server-2");
  assert.equal(useMachineStore.getState().loading, true);
  assert.equal(useMachineStore.getState().loadStatus, "loading");
  assert.equal(useMachineStore.getState().loadError, false);
  assert.deepEqual(useMachineStore.getState().machines, []);
});

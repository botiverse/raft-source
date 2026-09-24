import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import { en } from "../src/i18n/messages/en";
import { shouldShowComputerUpgradeIndicator } from "../src/utils/computerUpgradeIndicator";
import type { Machine } from "../src/store/machineStore";

test("desktop Computers rail attention stays separate from each row's single full-state dot", async (t) => {
  const React = await import("react");
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router-dom");
  const api = (await import("../src/api/client")).default;
  const { LeftRail } = await import("../src/components/layout/LeftRail");
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useServerStore } = await import("../src/store/serverStore");

  t.mock.method(api, "get", async () => ({ data: [] }));
  useServerStore.setState({
    current: {
      id: "server-attention",
      name: "Attention",
      slug: "attention",
      avatarUrl: null,
      ownerId: "owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: new Date(0).toISOString(),
    },
    servers: [],
  } as never);
  useMachineStore.setState({
    machines: [{
      id: "computer-attention",
      name: "Needs upgrade",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: [],
      hostname: "attention.local",
      os: "darwin",
      daemonVersion: "1.0.0",
      isComputer: true,
      computerVersion: "0.0.49",
      computerUpgradeAvailable: true,
      lastHeartbeat: null,
      createdAt: new Date(0).toISOString(),
    } as Machine],
    latestComputerVersion: "0.0.50",
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ["/s/attention"] },
      React.createElement(TestIntlProvider, null,
        React.createElement(LeftRail, { side: "left" }),
      ),
    ));
  });

  const computers = container.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-computers"]');
  assert.ok(computers);
  assert.equal(computers.getAttribute("aria-label"), "Computers");
  assert.equal(
    computers.querySelectorAll('span[aria-hidden="true"]').length,
    1,
    "the rail owns one aggregate attention dot, separate from row status dots",
  );
  assert.equal(en["layout.leftRail.computersNeedAttentionSummary"], "{count} of {total} needs attention");
  await React.act(async () => root.unmount());
  container.remove();
});

test("mobile Computers list renders one full-state row dot with its target version", async () => {
  const React = await import("react");
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router-dom");
  const MobileComputersPanel = (await import("../src/components/machine/MobileComputersPanel")).default;
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const machine: Machine = {
    id: "mobile-upgrade",
    name: "Mobile Upgrade",
    description: null,
    status: "offline",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "mobile.local",
    os: "darwin",
    daemonVersion: "1.0.0",
    isComputer: true,
    computerVersion: "0.0.49",
    computerUpgradeAvailable: true,
    computerBroadcastPolicy: {
      eligibility: "eligible",
      targetVersion: "0.0.50",
      targetRole: "independent_bugfix",
      migrationClass: "seamless",
      policyRevision: "policy-mobile",
      reasonCode: "eligible",
    },
    lastHeartbeat: null,
    createdAt: new Date(0).toISOString(),
  };
  useServerStore.setState({ current: { id: "server-mobile", slug: "mobile", role: "owner" } as never });
  useMachineStore.setState({
    machines: [machine],
    loading: false,
    loadStatus: "loaded",
    loadError: false,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: ["/s/mobile/computers"] },
      React.createElement(TestIntlProvider, null, React.createElement(MobileComputersPanel)),
    ));
  });

  const row = container.querySelector(`[data-testid="computer-list-item-${machine.id}"]`);
  assert.ok(row);
  assert.equal(row.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  assert.match(row.querySelector<HTMLElement>(`[data-testid="computer-status-dot-${machine.id}"]`)?.className ?? "", /bg-brutal-pink/);
  assert.match(row.textContent ?? "", /→ v0\.0\.50/);
  await React.act(async () => root.unmount());
  container.remove();
});

test("desktop Computer upgrade indicator only lights for managed Computers with server-asserted availability", () => {
  assert.equal(shouldShowComputerUpgradeIndicator({ isComputer: true, computerUpgradeAvailable: true }), true);
  assert.equal(shouldShowComputerUpgradeIndicator({ isComputer: true, computerUpgradeAvailable: false }), false);
  assert.equal(shouldShowComputerUpgradeIndicator({ isComputer: true, computerUpgradeAvailable: null }), false);
  assert.equal(shouldShowComputerUpgradeIndicator({ isComputer: false, computerUpgradeAvailable: true }), false);
});

test("ComputerRow renders only when its machine exists and carries the row status dot", async () => {
  const React = await import("react");
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const { createRoot } = await import("react-dom/client");
  const { ComputerRow } = await import("../src/components/layout/Sidebar");
  const { useMachineStore } = await import("../src/store/machineStore");

  const renderRow = async (machineId: string) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(TestIntlProvider, null,
        React.createElement(ComputerRow, { machineId, selected: false, onSelect: () => {} }),
      ));
    });
    return { container, root };
  };

  useMachineStore.setState({ machines: [], latestComputerVersion: "0.0.50" });
  const missing = await renderRow("missing-computer");
  assert.equal(missing.container.textContent, "");
  await React.act(async () => missing.root.unmount());
  missing.container.remove();

  const computer: Machine = {
    id: "computer-1",
    name: "Studio Computer",
    description: "Managed Computer",
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "studio.local",
    os: "darwin",
    daemonVersion: "0.68.0",
    isComputer: true,
    computerVersion: "0.0.49",
    computerUpgradeAvailable: true,
    computerBroadcastPolicy: {
      eligibility: "eligible",
      targetVersion: "0.0.50",
      targetRole: "independent_bugfix",
      migrationClass: "seamless",
      policyRevision: "policy-test-v1",
      reasonCode: "eligible",
    },
    lastHeartbeat: "2026-07-07T13:00:00.000Z",
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  useMachineStore.setState({ machines: [computer], latestComputerVersion: "9.9.9" });
  const present = await renderRow(computer.id);
  assert.ok(present.container.querySelector(`[data-testid="computer-list-item-${computer.id}"]`));
  assert.ok(present.container.querySelector(`[data-testid="computer-status-dot-${computer.id}"]`));
  assert.match(present.container.textContent ?? "", /Studio Computer/);
  assert.match(present.container.textContent ?? "", /v0\.0\.50/);
  await React.act(async () => present.root.unmount());
  present.container.remove();
});

test("ComputerRow keeps exactly one icon dot across managed and legacy status combinations", async () => {
  const React = await import("react");
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const { createRoot } = await import("react-dom/client");
  const { ComputerRow } = await import("../src/components/layout/Sidebar");
  const { useMachineStore } = await import("../src/store/machineStore");

  const renderRow = async (machineId: string) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(TestIntlProvider, null,
        React.createElement(ComputerRow, { machineId, selected: false, onSelect: () => {} }),
      ));
    });
    return { container, root };
  };

  const baseComputer: Machine = {
    id: "computer-normal",
    name: "Normal Computer",
    description: "Managed Computer",
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: "normal.local",
    os: "darwin",
    daemonVersion: "0.68.0",
    isComputer: true,
    computerVersion: "0.0.50",
    computerUpgradeAvailable: false,
    lastHeartbeat: "2026-07-07T13:00:00.000Z",
    createdAt: "2026-07-07T12:00:00.000Z",
  };
  const upgradeComputer: Machine = {
    ...baseComputer,
    id: "computer-upgrade",
    name: "Upgrade Computer",
    computerVersion: "0.0.49",
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
  const offlineComputer: Machine = {
    ...baseComputer,
    id: "computer-offline",
    name: "Offline Computer",
    status: "offline",
    computerUpgradeAvailable: false,
  };
  const offlineUpgradeComputer: Machine = {
    ...upgradeComputer,
    id: "computer-offline-upgrade",
    name: "Offline Upgrade Computer",
    status: "offline",
  };
  const legacyOnline: Machine = {
    ...baseComputer,
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
    machines: [
      baseComputer,
      upgradeComputer,
      offlineComputer,
      offlineUpgradeComputer,
      legacyOnline,
      legacyOffline,
    ],
    latestComputerVersion: "0.0.50",
  });

  const normal = await renderRow(baseComputer.id);
  const normalDot = normal.container.querySelector(`[data-testid="computer-status-dot-${baseComputer.id}"]`);
  assert.ok(normalDot?.className.includes("bg-brutal-lime"));
  assert.equal(normalDot?.getAttribute("title"), "Online");
  assert.equal(normal.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => normal.root.unmount());
  normal.container.remove();

  const upgrade = await renderRow(upgradeComputer.id);
  const upgradeDot = upgrade.container.querySelector(`[data-testid="computer-status-dot-${upgradeComputer.id}"]`);
  assert.ok(upgradeDot?.className.includes("bg-brutal-pink"));
  assert.equal(upgradeDot?.getAttribute("title"), "Computer upgrade available: v0.0.50");
  assert.equal(upgrade.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => upgrade.root.unmount());
  upgrade.container.remove();

  const offline = await renderRow(offlineComputer.id);
  const offlineDot = offline.container.querySelector(`[data-testid="computer-status-dot-${offlineComputer.id}"]`);
  assert.ok(offlineDot?.className.includes("bg-gray-400"));
  assert.equal(offlineDot?.getAttribute("title"), "Offline");
  assert.equal(offline.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => offline.root.unmount());
  offline.container.remove();

  const offlineUpgrade = await renderRow(offlineUpgradeComputer.id);
  const offlineUpgradeDot = offlineUpgrade.container.querySelector(`[data-testid="computer-status-dot-${offlineUpgradeComputer.id}"]`);
  assert.ok(offlineUpgradeDot?.className.includes("bg-brutal-pink"));
  assert.equal(
    offlineUpgradeDot?.getAttribute("title"),
    "Computer upgrade available: v0.0.50 · Computer offline",
  );
  assert.match(offlineUpgrade.container.textContent ?? "", /computer offline/);
  assert.equal(offlineUpgrade.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => offlineUpgrade.root.unmount());
  offlineUpgrade.container.remove();

  const legacyOnlineRow = await renderRow(legacyOnline.id);
  const legacyOnlineDot = legacyOnlineRow.container.querySelector(`[data-testid="computer-status-dot-${legacyOnline.id}"]`);
  assert.ok(legacyOnlineDot?.className.includes("bg-brutal-lime"));
  assert.equal(legacyOnlineRow.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => legacyOnlineRow.root.unmount());
  legacyOnlineRow.container.remove();

  const legacyOfflineRow = await renderRow(legacyOffline.id);
  const legacyOfflineDot = legacyOfflineRow.container.querySelector(`[data-testid="computer-status-dot-${legacyOffline.id}"]`);
  assert.ok(legacyOfflineDot?.className.includes("bg-gray-400"));
  assert.equal(legacyOfflineRow.container.querySelectorAll('[data-testid^="computer-status-dot-"]').length, 1);
  await React.act(async () => legacyOfflineRow.root.unmount());
  legacyOfflineRow.container.remove();

});

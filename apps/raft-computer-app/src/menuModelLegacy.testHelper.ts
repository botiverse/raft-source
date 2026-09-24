import {
  getComputerActionAvailability,
  type ComputerActionAvailabilityInput,
  type ComputerActionId,
  type ComputerStatusReport,
  type ServerStatusRow,
} from "@botiverse/raft-computer/lib";

import type { Action } from "./actionRunner.js";
import {
  type AppState,
  type MenuItem,
  type MenuModelDeps,
  type MenuNode,
  type WorkspaceRowState,
} from "./menuModel.js";

/** Frozen pre-P1b builder used only by the 32-cell compatibility oracle. */
export function buildLegacyMenuModelForEquivalence(
  state: AppState,
  deps: MenuModelDeps,
): MenuNode[] {
  const nodes: MenuNode[] = [];
  const status = state.status;
  const servers: ServerStatusRow[] = status?.servers ?? [];
  const signedIn = status?.loggedIn === true;
  const updateAvailable =
    state.latestVersion !== null &&
    legacySemverGreater(state.latestVersion, deps.localVersion);
  const actionInput: ComputerActionAvailabilityInput = {
    status,
    inFlight: state.inFlight,
    updateAvailable,
  };

  if (status === null) {
    return [
      { label: "Checking status…", enabled: false },
      { separator: true },
      { label: `Raft Desktop v${deps.localVersion}`, enabled: false },
      { label: "Quit Raft Desktop", click: { kind: "quitApp" } },
    ];
  }

  nodes.push({ label: "Account", enabled: false });
  if (signedIn) {
    nodes.push({
      label: legacySignedInLabel(status),
      submenu: [
        legacyClickableNode(
          "Sign out",
          { kind: "signOut" },
          "signOut",
          actionInput,
        ),
      ],
    });
  } else {
    nodes.push(
      legacyClickableNode(
        "Sign in",
        { kind: "connectWorkspace" },
        "connectWorkspace",
        actionInput,
      ),
    );
  }
  nodes.push({ separator: true });

  if (signedIn) {
    nodes.push({ label: "Servers", enabled: false });
    if (servers.length === 0) {
      nodes.push({ label: "No servers connected", enabled: false });
    } else {
      for (const server of servers) {
        const workspaceState = legacyWorkspaceState(server);
        const label = server.serverSlug ?? server.serverId.slice(0, 8);
        nodes.push({
          label: `${legacyStatusDot(workspaceState)}  ${label}`,
          submenu: legacyWorkspaceSubmenu(
            server,
            workspaceState,
            deps,
            actionInput,
          ),
        });
      }
    }
    nodes.push(
      legacyClickableNode(
        "Connect server…",
        { kind: "connectWorkspace" },
        "connectWorkspace",
        actionInput,
      ),
    );
    nodes.push({ separator: true });
  }

  nodes.push({
    label: `Raft Desktop v${deps.localVersion}`,
    submenu: legacyAppSubmenu(state, actionInput),
  });
  if (updateAvailable) {
    nodes.push(
      legacyClickableNode(
        `Update available · v${state.latestVersion}`,
        { kind: "upgrade", targetVersion: state.latestVersion as string },
        "upgrade",
        actionInput,
      ),
    );
  }
  nodes.push(
    legacyClickableNode(
      "Quit Raft Desktop",
      { kind: "quitApp" },
      "quitApp",
      actionInput,
    ),
  );
  return nodes;
}

function legacyWorkspaceSubmenu(
  server: ServerStatusRow,
  workspaceState: WorkspaceRowState,
  deps: MenuModelDeps,
  actionInput: ComputerActionAvailabilityInput,
): MenuNode[] {
  const label = server.serverSlug ?? server.serverId.slice(0, 8);
  const items: MenuNode[] = [
    { label: legacyStatusLabel(workspaceState), enabled: false },
    { separator: true },
  ];
  const serverActionInput = { ...actionInput, serverId: server.serverId };
  const openWorkspace: MenuItem = {
    label: "Open workspace",
    click: { kind: "openUrl", url: legacyComputerPageUrl(server, deps) },
  };

  switch (workspaceState) {
    case "online":
      items.push(openWorkspace);
      break;
    case "offline":
      items.push(
        legacyClickableNode(
          "Recover connection",
          {
            kind: "startService",
            serverId: server.serverId,
            serverLabel: label,
          },
          "startService",
          serverActionInput,
        ),
      );
      items.push(openWorkspace);
      break;
    case "needs-attention":
      items.push(
        legacyClickableNode(
          "Recover connection",
          { kind: "restartRunner", serverId: server.serverId },
          "restartRunner",
          serverActionInput,
        ),
      );
      items.push(openWorkspace);
      break;
    case "verifying":
      items.push({
        label: "Open setup progress",
        click: {
          kind: "connectWorkspace",
          serverId: server.serverId,
          serverLabel: label,
        },
      });
      items.push(openWorkspace);
      break;
  }
  return items;
}

function legacyAppSubmenu(
  state: AppState,
  actionInput: ComputerActionAvailabilityInput,
): MenuNode[] {
  const items: MenuNode[] = [];
  if (legacyActionAvailable("diagnosticsPush", actionInput)) {
    items.push({
      label: "Send diagnostics",
      click: { kind: "diagnosticsPush" },
    });
  }
  if (
    legacyActionAvailable("viewLog", actionInput) &&
    state.status?.service.logPath
  ) {
    items.push({
      label: "View logs",
      click: { kind: "viewLog", path: state.status.service.logPath },
    });
  }
  items.push({
    label: "Launch at login",
    checked: state.launchAtLogin,
    click: {
      kind: "toggleLaunchAtLogin",
      currentlyEnabled: state.launchAtLogin,
    },
  });
  return items;
}

function legacyClickableNode(
  label: string,
  click: Action,
  id: ComputerActionId,
  input: ComputerActionAvailabilityInput,
): MenuItem {
  if (legacyActionAvailable(id, input)) return { label, click };
  return { label, enabled: false };
}

function legacyActionAvailable(
  id: ComputerActionId,
  input: ComputerActionAvailabilityInput,
): boolean {
  return getComputerActionAvailability(id, input).available;
}

function legacySignedInLabel(report: ComputerStatusReport): string {
  return (
    report.userDisplayName ??
    report.userName ??
    report.userEmail ??
    `${(report.userId ?? "").slice(0, 8)}…`
  );
}

function legacyStatusDot(state: WorkspaceRowState): string {
  switch (state) {
    case "online":
      return "•";
    case "needs-attention":
      return "*";
    case "verifying":
      return "*";
    case "offline":
      return "◦";
  }
}

function legacyStatusLabel(state: WorkspaceRowState): string {
  switch (state) {
    case "online":
      return "Online";
    case "needs-attention":
      return "Needs attention";
    case "verifying":
      return "Verifying";
    case "offline":
      return "Offline";
  }
}

function legacyComputerPageUrl(
  server: ServerStatusRow,
  deps: MenuModelDeps,
): string {
  const base = `${deps.dashboardUrl.replace(/\/$/, "")}/s/${server.serverSlug ?? server.serverId}`;
  return server.machineId
    ? `${base}/computer/${server.machineId}`
    : `${base}/computers`;
}

const LEGACY_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function legacySemverGreater(a: string, b: string): boolean {
  const pa = a.match(LEGACY_SEMVER_RE);
  const pb = b.match(LEGACY_SEMVER_RE);
  if (pa === null || pb === null) return false;
  for (let i = 1; i <= 3; i++) {
    const da = Number(pa[i]);
    const db = Number(pb[i]);
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

function legacyWorkspaceState(server: ServerStatusRow): WorkspaceRowState {
  if (server.health === "degraded") return "needs-attention";
  if (server.health === "ok" && server.serverConnected) return "online";
  if (server.health === "ok" && !server.serverConnected) return "verifying";
  return "offline";
}

import {
  getComputerActionAvailability,
  type ComputerActionId,
  type ComputerActionUnavailableReason,
} from "./actions.js";
import type { ComputerStatusReport, ServerStatusRow } from "./types.js";

export type ComputerAffordanceRisk = "safe" | "confirm" | "destructive";

export interface ComputerActionConfirmation {
  message: string;
  detail: string;
}

export const COMPUTER_DIAGNOSTICS_REVIEW_DETAIL = [
  "Raft Desktop will queue a redacted diagnostics bundle for the Raft team.",
  "",
  "Included:",
  "- Desktop app version, platform, and service health",
  "- Workspace attach/recovery status and recent operation outcomes",
  "- Redacted daemon/menu-bar logs and trace metadata needed for debugging",
  "",
  "Not included:",
  "- Agent tokens, machine API keys, session cookies, or raw credentials",
  "- Full message contents",
  "",
  "Upload is queued, not immediate. If you choose Copy details, no diagnostics are queued or uploaded.",
].join("\n");

export interface ComputerUrlHint {
  serverId: string;
  serverSlug: string | null;
  machineId: string | null;
  serverUrl: string;
}

export type ComputerSurfaceAction =
  | { kind: "login"; risk: "safe" }
  | { kind: "sign-out"; risk: "confirm" }
  | { kind: "connect-workspace"; risk: "safe"; serverId?: string; serverLabel?: string }
  | { kind: "start-service"; risk: "safe"; serverId: string; serverLabel: string }
  | { kind: "restart-service"; risk: "confirm" }
  | { kind: "restart-runner"; risk: "confirm"; serverId: string }
  | { kind: "upgrade"; risk: "confirm"; targetVersion: string }
  | { kind: "open-computer"; risk: "safe"; serverId: string; urlHint: ComputerUrlHint }
  | { kind: "run-doctor"; risk: "safe" }
  | { kind: "diagnostics-push"; risk: "confirm" }
  | { kind: "view-log"; risk: "safe"; path: string }
  | { kind: "toggle-launch-at-login"; risk: "safe" }
  | { kind: "quit-app"; risk: "confirm" };

export type WorkspaceAffordanceState = "online" | "offline" | "needs_attention" | "verifying";

export interface WorkspaceAffordance {
  serverId: string;
  label: string;
  state: WorkspaceAffordanceState;
  primary: ComputerSurfaceAction | null;
  secondary: ComputerSurfaceAction[];
}

export type ComputerAccountAffordance = "checking" | "signed_out" | { signedInAs: string };

export type ComputerTrayHealth = "ok" | "degraded" | "stopped";

export interface ComputerBlockedAffordance {
  action: ComputerSurfaceAction;
  actionId: ComputerActionId;
  reason: ComputerActionUnavailableReason;
  message: string | null;
}

export interface ComputerAffordances {
  account: ComputerAccountAffordance;
  trayHealth: ComputerTrayHealth;
  workspaces: WorkspaceAffordance[];
  globalActions: ComputerSurfaceAction[];
  blocked: Record<string, ComputerBlockedAffordance>;
}

export interface ComputerAffordanceInput {
  status: ComputerStatusReport | null;
  localVersion: string;
  latestVersion: string | null;
  inFlight?: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function deriveComputerAffordances(input: ComputerAffordanceInput): ComputerAffordances {
  const status = input.status;
  const updateAvailable =
    input.latestVersion !== null && semverGreater(input.latestVersion, input.localVersion);
  const blocked: Record<string, ComputerBlockedAffordance> = {};

  return {
    account: deriveAccount(status),
    trayHealth: deriveTrayHealth(status),
    workspaces: deriveWorkspaces(status, input, blocked),
    globalActions: deriveGlobalActions(input, updateAvailable, blocked),
    blocked,
  };
}

export function deriveTrayHealth(status: ComputerStatusReport | null): ComputerTrayHealth {
  if (status === null) return "stopped";
  if (status.servers.some((server) => server.health === "degraded")) return "degraded";
  if (!status.service.running) return "stopped";
  return "ok";
}

export function deriveWorkspaceAffordanceState(server: ServerStatusRow): WorkspaceAffordanceState {
  if (server.health === "degraded") return "needs_attention";
  if (server.health === "ok" && server.serverConnected) return "online";
  if (server.health === "ok" && !server.serverConnected) return "verifying";
  return "offline";
}

export function semverGreater(a: string, b: string): boolean {
  const pa = a.match(SEMVER_RE);
  const pb = b.match(SEMVER_RE);
  if (pa === null || pb === null) return false;
  for (let i = 1; i <= 3; i++) {
    const da = Number(pa[i]);
    const db = Number(pb[i]);
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

/** Shared copy source for surfaces that consume a kernel-owned `confirm` risk.
 * Future confirm actions intentionally fall back to a generic warning instead
 * of requiring each presenter to maintain a second action allowlist. */
export function getComputerActionConfirmation(
  action: ComputerSurfaceAction,
): ComputerActionConfirmation {
  switch (action.kind) {
    case "sign-out":
      return {
        message: "Sign out of Raft Desktop?",
        detail:
          "This disconnects every workspace Computer on this device (they go offline). Your attachments are kept — sign in again to bring the same Computers back online.",
      };
    case "restart-service":
      return {
        message: "Restart the Raft Desktop service?",
        detail:
          "Connected workspaces may briefly go offline while Raft Desktop restarts its local service.",
      };
    case "restart-runner":
      return {
        message: "Restart this workspace runner?",
        detail:
          `Raft Desktop will restart the runner for server ${action.serverId.slice(0, 8)}…. ` +
          "Agents on this workspace will briefly go offline until the connection recovers.",
      };
    case "upgrade":
      return {
        message: `Upgrade Raft Desktop to v${action.targetVersion}?`,
        detail:
          "Raft Desktop will download and verify the update, replace the Computer binary, and restart its service. Connected workspaces may briefly go offline.",
      };
    case "diagnostics-push":
      return {
        message: "Review diagnostics before sending",
        detail: COMPUTER_DIAGNOSTICS_REVIEW_DETAIL,
      };
    case "quit-app":
      return {
        message: "Quit Raft Desktop?",
        detail:
          "Your connected workspaces will go offline on this Computer until you open Raft Desktop again.",
      };
    default:
      return {
        message: "Confirm this Raft Desktop action?",
        detail: `Raft Desktop requires confirmation before running “${action.kind}”.`,
      };
  }
}

function deriveAccount(status: ComputerStatusReport | null): ComputerAccountAffordance {
  if (status === null) return "checking";
  if (!status.loggedIn) return "signed_out";
  return {
    signedInAs:
      status.userDisplayName ??
      status.userName ??
      status.userEmail ??
      `${(status.userId ?? "").slice(0, 8)}…`,
  };
}

function deriveWorkspaces(
  status: ComputerStatusReport | null,
  input: ComputerAffordanceInput,
  blocked: Record<string, ComputerBlockedAffordance>,
): WorkspaceAffordance[] {
  if (status === null || !status.loggedIn) return [];

  return status.servers.map((server) => {
    const state = deriveWorkspaceAffordanceState(server);
    const label = serverLabel(server);
    const open = availableAction(
      { ...input, serverId: server.serverId },
      openComputerAction(server),
      blocked,
    );

    switch (state) {
      case "online":
        return {
          serverId: server.serverId,
          label,
          state,
          primary: open,
          secondary: [],
        };
      case "verifying": {
        const setupProgress = availableAction(
          { ...input, serverId: server.serverId },
          { kind: "connect-workspace", risk: "safe", serverId: server.serverId, serverLabel: label },
          blocked,
        );
        return {
          serverId: server.serverId,
          label,
          state,
          primary: setupProgress,
          secondary: compact([open]),
        };
      }
      case "needs_attention": {
        const recover = availableAction(
          { ...input, serverId: server.serverId },
          { kind: "restart-runner", risk: "confirm", serverId: server.serverId },
          blocked,
        );
        return {
          serverId: server.serverId,
          label,
          state,
          primary: recover,
          secondary: compact([open]),
        };
      }
      case "offline": {
        const recover = availableAction(
          { ...input, serverId: server.serverId },
          { kind: "start-service", risk: "safe", serverId: server.serverId, serverLabel: label },
          blocked,
        );
        return {
          serverId: server.serverId,
          label,
          state,
          primary: recover,
          secondary: compact([open]),
        };
      }
    }
  });
}

function deriveGlobalActions(
  input: ComputerAffordanceInput,
  updateAvailable: boolean,
  blocked: Record<string, ComputerBlockedAffordance>,
): ComputerSurfaceAction[] {
  const status = input.status;
  const actions: Array<ComputerSurfaceAction | null> = [];

  if (status !== null) {
    actions.push(
      status.loggedIn
        ? availableAction(input, { kind: "sign-out", risk: "confirm" }, blocked)
        : availableAction(input, { kind: "connect-workspace", risk: "safe" }, blocked),
    );
  }

  if (status?.loggedIn === true) {
    actions.push(availableAction(input, { kind: "connect-workspace", risk: "safe" }, blocked));
  }

  if (input.latestVersion !== null && updateAvailable) {
    actions.push(
      availableAction(input, { kind: "upgrade", risk: "confirm", targetVersion: input.latestVersion }, blocked),
    );
  }

  if (status !== null) {
    actions.push(availableAction(input, { kind: "diagnostics-push", risk: "confirm" }, blocked));
    if (status.service.logPath.length > 0) {
      actions.push(availableAction(input, { kind: "view-log", risk: "safe", path: status.service.logPath }, blocked));
    }
    actions.push(availableAction(input, { kind: "toggle-launch-at-login", risk: "safe" }, blocked));
  }

  actions.push(availableAction(input, { kind: "quit-app", risk: "confirm" }, blocked));

  return compact(actions);
}

function availableAction(
  input: ComputerAffordanceInput & { serverId?: string | null },
  action: ComputerSurfaceAction,
  blocked: Record<string, ComputerBlockedAffordance>,
): ComputerSurfaceAction | null {
  const actionId = actionAvailabilityId(action);
  const availability = getComputerActionAvailability(actionId, {
    status: input.status,
    serverId: input.serverId ?? actionServerId(action),
    updateAvailable:
      action.kind === "upgrade" ? true : input.latestVersion !== null && semverGreater(input.latestVersion, input.localVersion),
    inFlight: input.inFlight ?? null,
  });

  if (availability.available) return action;

  if (availability.reason !== null) {
    blocked[actionKey(action)] = {
      action,
      actionId,
      reason: availability.reason,
      message: availability.message,
    };
  }
  return null;
}

function actionAvailabilityId(action: ComputerSurfaceAction): ComputerActionId {
  switch (action.kind) {
    case "open-computer":
      return "openUrl";
    case "login":
      return "login";
    case "sign-out":
      return "signOut";
    case "connect-workspace":
      return "connectWorkspace";
    case "start-service":
      return "startService";
    case "restart-service":
      return "restartService";
    case "restart-runner":
      return "restartRunner";
    case "upgrade":
      return "upgrade";
    case "run-doctor":
      return "runDoctor";
    case "diagnostics-push":
      return "diagnosticsPush";
    case "view-log":
      return "viewLog";
    case "toggle-launch-at-login":
      return "toggleLaunchAtLogin";
    case "quit-app":
      return "quitApp";
  }
}

function actionServerId(action: ComputerSurfaceAction): string | null {
  switch (action.kind) {
    case "connect-workspace":
    case "start-service":
    case "restart-runner":
    case "open-computer":
      return action.serverId ?? null;
    case "login":
    case "sign-out":
    case "restart-service":
    case "upgrade":
    case "run-doctor":
    case "diagnostics-push":
    case "view-log":
    case "toggle-launch-at-login":
    case "quit-app":
      return null;
  }
}

function actionKey(action: ComputerSurfaceAction): string {
  const serverId = actionServerId(action);
  return serverId === null ? action.kind : `${action.kind}:${serverId}`;
}

function openComputerAction(server: ServerStatusRow): ComputerSurfaceAction {
  return {
    kind: "open-computer",
    risk: "safe",
    serverId: server.serverId,
    urlHint: {
      serverId: server.serverId,
      serverSlug: server.serverSlug,
      machineId: server.machineId,
      serverUrl: server.serverUrl,
    },
  };
}

function serverLabel(server: ServerStatusRow): string {
  return server.serverSlug ?? server.serverId.slice(0, 8);
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

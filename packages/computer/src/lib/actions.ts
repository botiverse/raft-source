import type { ComputerStatusReport, ServerStatusRow } from "../status.js";

export const COMPUTER_ACTION_IDS = [
  "login",
  "signOut",
  "startService",
  "restartService",
  "restartRunner",
  "upgrade",
  "viewLog",
  "runDoctor",
  "diagnosticsPush",
  "openUrl",
  "refresh",
  "connectWorkspace",
  "quitApp",
  "toggleLaunchAtLogin",
] as const;

export type ComputerActionId = (typeof COMPUTER_ACTION_IDS)[number];

export type ComputerActionRoute =
  | "browser"
  | "bootstrap"
  | "local-presenter"
  | "service-dispatch"
  | "support";

export interface ComputerActionDescriptor {
  id: ComputerActionId;
  route: ComputerActionRoute;
  /** Steady-state mutations must be driven through the service dispatch path. */
  steadyStateMutation: boolean;
  /** Explicit exception for flows that may run before the steady-state service exists. */
  bootstrapException: boolean;
}

export const COMPUTER_ACTION_DESCRIPTORS: Record<ComputerActionId, ComputerActionDescriptor> = {
  login: {
    id: "login",
    route: "bootstrap",
    steadyStateMutation: false,
    bootstrapException: true,
  },
  signOut: {
    id: "signOut",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  startService: {
    id: "startService",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  restartService: {
    id: "restartService",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  restartRunner: {
    id: "restartRunner",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  upgrade: {
    id: "upgrade",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  viewLog: {
    id: "viewLog",
    route: "local-presenter",
    steadyStateMutation: false,
    bootstrapException: false,
  },
  runDoctor: {
    id: "runDoctor",
    route: "support",
    steadyStateMutation: false,
    bootstrapException: true,
  },
  diagnosticsPush: {
    id: "diagnosticsPush",
    route: "support",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  openUrl: {
    id: "openUrl",
    route: "browser",
    steadyStateMutation: false,
    bootstrapException: true,
  },
  refresh: {
    id: "refresh",
    route: "local-presenter",
    steadyStateMutation: false,
    bootstrapException: true,
  },
  connectWorkspace: {
    id: "connectWorkspace",
    route: "bootstrap",
    steadyStateMutation: false,
    bootstrapException: true,
  },
  quitApp: {
    id: "quitApp",
    route: "service-dispatch",
    steadyStateMutation: true,
    bootstrapException: false,
  },
  toggleLaunchAtLogin: {
    id: "toggleLaunchAtLogin",
    route: "local-presenter",
    steadyStateMutation: false,
    bootstrapException: true,
  },
};

export type ComputerActionUnavailableReason =
  | "status-unavailable"
  | "signed-in"
  | "signed-out"
  | "service-stopped"
  | "server-missing"
  | "server-not-degraded"
  | "server-not-offline"
  | "update-unavailable"
  | "no-log-path"
  | "in-flight";

export interface ComputerActionAvailabilityInput {
  status: ComputerStatusReport | null;
  /** The target server for per-runner actions. */
  serverId?: string | null;
  /** Whether the presenter has a newer version ready to install. */
  updateAvailable?: boolean;
  /** Any active presenter-side operation label. */
  inFlight?: string | null;
}

export interface ComputerActionAvailability {
  id: ComputerActionId;
  descriptor: ComputerActionDescriptor;
  available: boolean;
  reason: ComputerActionUnavailableReason | null;
  message: string | null;
}

export function getComputerActionAvailability(
  id: ComputerActionId,
  input: ComputerActionAvailabilityInput,
): ComputerActionAvailability {
  const descriptor = COMPUTER_ACTION_DESCRIPTORS[id];
  const status = input.status;
  const busy = input.inFlight !== undefined && input.inFlight !== null;

  if (busy && descriptor.steadyStateMutation) {
    return unavailable(id, "in-flight", `Another Raft Desktop action is already running: ${input.inFlight}`);
  }

  switch (id) {
    case "openUrl":
    case "refresh":
    case "connectWorkspace":
    case "toggleLaunchAtLogin":
    case "runDoctor":
      return available(id);

    case "login":
      if (status?.loggedIn === true) return unavailable(id, "signed-in", "Raft Desktop is already signed in.");
      return available(id);

    case "signOut":
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      if (!status.loggedIn) return unavailable(id, "signed-out", "Raft Desktop is not signed in.");
      return available(id);

    case "startService": {
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      if (!status.loggedIn) return unavailable(id, "signed-out", "Sign in before starting a workspace connection.");
      const server = findServer(status, input.serverId);
      if (server === null) return unavailable(id, "server-missing", "That workspace is not attached on this Computer.");
      if (server.health !== "offline" && server.daemon.running) {
        return unavailable(id, "server-not-offline", "That workspace connection is not offline.");
      }
      return available(id);
    }

    case "restartService":
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      if (!status.service.running) return unavailable(id, "service-stopped", "The Raft Desktop service is not running.");
      return available(id);

    case "restartRunner": {
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      if (!status.loggedIn) return unavailable(id, "signed-out", "Sign in before recovering a workspace connection.");
      const server = findServer(status, input.serverId);
      if (server === null) return unavailable(id, "server-missing", "That workspace is not attached on this Computer.");
      if (server.health !== "degraded") {
        return unavailable(id, "server-not-degraded", "That workspace connection does not need recovery.");
      }
      return available(id);
    }

    case "upgrade":
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      if (input.updateAvailable !== true) return unavailable(id, "update-unavailable", "No Raft Desktop update is available.");
      return available(id);

    case "viewLog":
      if (status?.service.logPath) return available(id);
      return unavailable(id, "no-log-path", "No Raft Desktop service log is available.");

    case "diagnosticsPush":
      if (status === null) return unavailable(id, "status-unavailable", "Raft Desktop status is not loaded yet.");
      return available(id);

    case "quitApp":
      if (status === null) return available(id);
      return available(id);
  }
}

export function getComputerActionAvailabilityMap(
  input: ComputerActionAvailabilityInput,
): Record<ComputerActionId, ComputerActionAvailability> {
  return Object.fromEntries(
    COMPUTER_ACTION_IDS.map((id) => [id, getComputerActionAvailability(id, input)]),
  ) as Record<ComputerActionId, ComputerActionAvailability>;
}

function findServer(status: ComputerStatusReport, serverId: string | null | undefined): ServerStatusRow | null {
  if (serverId === null || serverId === undefined) return null;
  return status.servers.find((s) => s.serverId === serverId) ?? null;
}

function available(id: ComputerActionId): ComputerActionAvailability {
  return {
    id,
    descriptor: COMPUTER_ACTION_DESCRIPTORS[id],
    available: true,
    reason: null,
    message: null,
  };
}

function unavailable(
  id: ComputerActionId,
  reason: ComputerActionUnavailableReason,
  message: string,
): ComputerActionAvailability {
  return {
    id,
    descriptor: COMPUTER_ACTION_DESCRIPTORS[id],
    available: false,
    reason,
    message,
  };
}

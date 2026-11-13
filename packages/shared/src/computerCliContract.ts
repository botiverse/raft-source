// The machine-readable surface of the official `raft-computer` CLI that Raft
// Desktop drives (Desktop runs the installed binary; it never links the
// Computer library). Every shape here is what one command prints as a single
// JSON line on stdout; Desktop parses it defensively (older Computers lack the
// newer fields). The Computer's CLI owns the producers (packages/computer
// cli.ts), this file the contract both sides type against.

/** One attached server, as `raft-computer status --json` reports it. */
export interface ComputerCliStatusServer {
  serverId: string;
  serverSlug: string | null;
  /** `machines.id` on that server; null on older servers. */
  machineId: string | null;
  /** Its runner is alive and connected to the server. */
  serverConnected?: boolean;
}

/** `raft-computer status --json`. */
export interface ComputerCliStatusJson {
  /** The version of the binary that answered. */
  cliVersion: string;
  service: {
    running: boolean;
    pid?: number | null;
    /** The running service's own version, when it reported one. */
    version?: { version?: string | null } | null;
    /** The service log (its folder holds the Computer's logs). */
    logPath?: string;
  };
  servers: ComputerCliStatusServer[];
  /** The live service's self-report (null when it is not running or did not answer). */
  attestation: { serviceExecutablePath?: string | null; servicePid?: number | null } | null;
  /**
   * Agents mid-turn on this machine now (null: a runner could not tell).
   * Absent on Computers before it.
   */
  activeTurns?: number | null;
  /**
   * What a one-time attach approval names this machine: the default Computer
   * name, the OS hostname and the OS label. Absent on Computers before it.
   */
  approvalRequest?: { machineName: string; hostname: string; os: string };
  /**
   * What this Computer's CLI offers a caller (COMPUTER_CLI_CAPABILITIES).
   * Absent on Computers before it: treat as none of them.
   */
  capabilities?: string[];
}

/** One line of `raft-computer doctor --json` (details secret-redacted). */
export interface ComputerCliDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A heading line (a server), not a check. */
  section?: boolean;
}

/** `raft-computer doctor --json [--fix]`. Exit 0 whenever it ran (see `allOk`). */
export interface ComputerCliDoctorJson {
  checks: ComputerCliDoctorCheck[];
  allOk: boolean;
  /** `--fix` ran: how many leftovers it removed. */
  cleaned: { removed: number } | null;
  cliVersion: string;
  ranAt: string;
}

/**
 * `raft-computer attach <slug> --server-id <id> --server-url <url>
 * --attach-token-stdin --json`: the single-use `dvat_*` token is read from
 * stdin (never argv, so it never shows in a process list).
 */
export interface ComputerCliAttachJson {
  serverId: string;
  serverSlug: string;
  machineId: string | null;
  resumed: boolean;
}

/** The flag that makes `attach` read a one-time attach token from stdin. */
export const COMPUTER_CLI_ATTACH_TOKEN_STDIN_FLAG = "--attach-token-stdin";

/**
 * The capabilities `raft-computer status --json` lists. Raft Desktop enables
 * a feature only when the installed Computer reports what it needs; start,
 * stop, restart, status and start-on-open work with any Computer.
 */
export const COMPUTER_CLI_CAPABILITIES = [
  /** `attach --attach-token-stdin --json` (Add This Mac). */
  "attach-token-stdin",
  /** `status --json` carries `approvalRequest` (Add This Mac). */
  "approval-request",
  /** `status --json` carries `activeTurns` (Stop when idle, the move's quiet point). */
  "active-turns",
  /** `doctor --json` (Run Diagnostics). */
  "doctor-json",
  /** `upgrade --yes`: unattended (Update Now). */
  "upgrade-yes",
] as const;

export type ComputerCliCapability = (typeof COMPUTER_CLI_CAPABILITIES)[number];

/**
 * What each Raft Desktop feature needs the installed Computer to report: the
 * one map both Desktop (computerController.ts, which enables or refuses the
 * feature) and the web (This device, which says "Update Raft Computer for …")
 * read. Start, stop, restart, status and start-on-open need nothing.
 */
export const COMPUTER_FEATURE_NEEDS = {
  addThisMac: ["attach-token-stdin", "approval-request"],
  diagnostics: ["doctor-json"],
  /** Stop when agents finish, and the move's quiet point; without it they wait briefly. */
  stopWhenIdle: ["active-turns"],
  /** Computer's own unattended update; without it Desktop runs its bundled installer (nothing to tell the person). */
  unattendedUpgrade: ["upgrade-yes"],
} as const satisfies Record<string, readonly ComputerCliCapability[]>;

export type ComputerFeature = keyof typeof COMPUTER_FEATURE_NEEDS;

/** The features a person can be told to update for (unattendedUpgrade is Desktop's own fallback). */
export const COMPUTER_USER_FEATURES = ["addThisMac", "diagnostics", "stopWhenIdle"] as const satisfies readonly ComputerFeature[];

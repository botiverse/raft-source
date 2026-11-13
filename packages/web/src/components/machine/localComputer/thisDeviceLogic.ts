// This device: one derived state for the machine Raft Desktop runs on (design
// §4.5), from what the bridge reports (the one official Raft Computer's host
// state and its service status) and what the app is doing (an Add This Mac in
// flight, the last failed operation). Every surface reads it: the This device
// panel, the Computers list row, Add Computer, onboarding. Pure, so each
// state is unit-tested.
//
// Raft Desktop does not embed Computer: there is one Raft Computer on the
// machine, the official install, which Desktop drives through its CLI. One
// primary state, most urgent first, plus orthogonal flags each shown in its
// own section (not attached here, an update, a failed diagnostics run).
import type { DesktopComputerHostState, DesktopComputerStatus } from "@botiverse/raft-shared";
import { COMPUTER_FEATURE_NEEDS, COMPUTER_USER_FEATURES } from "@botiverse/raft-shared";
import type { MessageId } from "../../../i18n/messages";

export type ThisDeviceStateKind =
  /** The bridge has not answered yet. */
  | "checking"
  /** No Raft Computer here: Add This Mac installs it. */
  | "not-installed"
  /** An Add This Mac is in flight. */
  | "setting-up"
  /** An older Desktop's embedded Computer is being moved to the official install. */
  | "migrating"
  /** That move stopped partway: Retry. */
  | "migration-failed"
  /** Older than this Raft Desktop works with: Update. It still runs, and is started / stopped as usual. */
  | "update-required"
  /** Its own update (`raft-computer upgrade`) is running. */
  | "updating"
  | "stopped"
  | "running"
  /** Installed, but its status cannot be read. */
  | "unreadable"
  /** Another service on this machine holds the same machine key. */
  | "duplicate-key";

export interface ThisDeviceFlags {
  /** This machine is not one of the current server's computers. */
  notAttachedHere: boolean;
  /** A newer Computer is published (the web's own comparison). */
  updateAvailable: boolean;
  /** The last diagnostics run had a failing check. */
  diagnosticsFailed: boolean;
  /**
   * Added to the current server (its attachment names it), but the server's
   * computers do not list this machine yet: the one thing being waited on.
   * The list row, the page and Add Computer's last step all say so; Ready
   * (and "connected") only once it is listed.
   */
  awaitingListing: boolean;
  /** The service runs (the status line says "Running · Update required" or "Stopped · …"). */
  serviceRunning: boolean;
}

export interface ThisDeviceState {
  kind: ThisDeviceStateKind;
  flags: ThisDeviceFlags;
  /** Raft Desktop may start / stop / restart it (lifecycle buttons). */
  controllable: boolean;
  /** A problem the person should act on: the row's pixel turns orange, Troubleshoot opens. */
  problem: boolean;
}

export interface ThisDeviceInput {
  /** The bridge answered status, host state and local info. */
  ready: boolean;
  host: DesktopComputerHostState | null;
  status: DesktopComputerStatus | null;
  /** An Add This Mac is in flight (this app). */
  enabling: boolean;
  /** The service runs. */
  running: boolean;
  /** This machine is one of the current server's computers. */
  attachedHere: boolean;
  updateAvailable?: boolean;
  /** The last operation's error code (classifyHostError), for the states only an operation reveals. */
  lastErrorCode?: string | null;
  diagnosticsFailed?: boolean;
  /** Its attachment names the current server (this account's), but the server does not list it yet. */
  awaitingListing?: boolean;
}

/** The states where Raft Desktop drives the Computer (lifecycle buttons). */
const CONTROLLABLE: ReadonlySet<ThisDeviceStateKind> = new Set(["stopped", "running", "updating", "update-required"]);

/** The states that need the person: orange in the list, Troubleshoot opens. */
const PROBLEMS: ReadonlySet<ThisDeviceStateKind> = new Set(["migration-failed", "update-required", "unreadable", "duplicate-key"]);

/** A Raft Desktop feature that needs a capability the installed Computer may not report. */
export type ThisDeviceFeature = (typeof COMPUTER_USER_FEATURES)[number];

/**
 * The features the installed Computer cannot do yet, by what it reports (not
 * by its version): each says "Update Raft Computer to use …". Start, stop,
 * restart and status work with any Computer.
 */
export function missingFeatures(host: Pick<DesktopComputerHostState, "installed" | "capabilities"> | null): ThisDeviceFeature[] {
  if (!host?.installed || host.capabilities === null) return [];
  return COMPUTER_USER_FEATURES
    .filter((feature) => !COMPUTER_FEATURE_NEEDS[feature].every((need) => host.capabilities!.includes(need)));
}

/** The installed Computer lacks something this Raft Desktop uses: Update. */
export function belowMinimumVersion(host: Pick<DesktopComputerHostState, "installed" | "capabilities"> | null): boolean {
  return missingFeatures(host).length > 0;
}

function primaryKind(input: ThisDeviceInput): ThisDeviceStateKind {
  const { host } = input;
  if (!input.ready) return "checking";
  if (input.enabling) return "setting-up";
  if (input.lastErrorCode === "duplicate_key") return "duplicate-key";
  if (host?.migration.state === "running") return "migrating";
  if (host?.migration.state === "failed") return "migration-failed";
  // A shell without the host state: what its status says.
  if (!host) return input.status === null ? "not-installed" : input.running ? "running" : "stopped";
  if (!host.installed) return "not-installed";
  if (host.updating) return "updating";
  if (belowMinimumVersion(host)) return "update-required";
  if (input.status === null) return "unreadable";
  return input.running ? "running" : "stopped";
}

export function deriveThisDeviceState(input: ThisDeviceInput): ThisDeviceState {
  const kind = primaryKind(input);
  const flags: ThisDeviceFlags = {
    notAttachedHere: input.ready && !input.attachedHere,
    updateAvailable: input.updateAvailable === true,
    diagnosticsFailed: input.diagnosticsFailed === true,
    awaitingListing: input.ready && input.awaitingListing === true,
    serviceRunning: input.running,
  };
  return {
    kind,
    flags,
    controllable: CONTROLLABLE.has(kind),
    problem: PROBLEMS.has(kind) || flags.diagnosticsFailed,
  };
}

/** How it comes back after a restart, for the status line ("Running · Starts when …"). */
export function startsWithMessageId(startsWith: DesktopComputerHostState["startsWith"]): MessageId {
  return startsWith === "login-item" ? "computerHost.thisDevice.startsWithLoginItem" : "computerHost.thisDevice.startsWithAppOpen";
}

/** The machine is this device: the panel replaces every command with a button. */
export function isThisDeviceMachine(host: { ready: boolean; self: { machineId: string | null } } | null, machineId: string): boolean {
  return host !== null && host.ready && host.self.machineId === machineId;
}

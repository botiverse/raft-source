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
  /** Installed but its status cannot be read, or the host state itself could not be read. */
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
  /** The shell has the host state, but reading it failed: unknown, never guessed from the service status. */
  hostReadFailed?: boolean;
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
  // The host state could not be read: unknown (Try again), never "stopped" on a guess.
  if (!host && input.hostReadFailed) return "unreadable";
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

// ── Actions (no dead end) ───────────────────────────────────────────────────
//
// Every state offers a next step, and none that is known to fail. One pure
// table, by state (a Record over ThisDeviceStateKind, so a new state does
// not compile until it says what it offers); ThisDeviceSections renders the
// status line and these buttons for both the embedded and the standalone page,
// and the Computers row offers the first one.

export type ThisDeviceActionId =
  /** Install Raft Computer (updateComputer: installs it, starts it when it is attached somewhere). */
  | "install"
  /** The same install, for an embedded Computer that never moved (leftoverAttachments): it finishes the move. */
  | "finish-move"
  /** Add to this server (install, attach, start). */
  | "add"
  /** This computer cannot run it: install it on another computer. */
  | "install-elsewhere"
  | "start"
  | "restart"
  | "stop"
  /** Below what this Raft Desktop uses (Updates section). */
  | "update"
  /** A newer Computer is published (Updates section). */
  | "update-now"
  /** Its status cannot be read: reinstall over it with the bundled installer (updateComputer). */
  | "repair"
  /** Read the host state and the status again. */
  | "retry-read"
  | "retry-migration"
  | "run-diagnostics"
  | "open-logs";

export interface ThisDeviceAction {
  id: ThisDeviceActionId;
  /** The one thing to press first (at most one per plan). */
  primary: boolean;
  /**
   * "status": beside the state (its notice, or the controls row); "updates":
   * in the Updates section; "troubleshoot": in Troubleshoot, which a problem
   * state opens, so it is not repeated in the notice above it.
   */
  place: "status" | "updates" | "troubleshoot";
}

/** What the page can do here (bridge members present, the host as read). */
export interface ThisDeviceActionHost {
  /** The host state as read; null: not read, or the read failed. */
  hostState: DesktopComputerHostState | null;
  /** Raft Desktop drives the install (host state known): lifecycle buttons. */
  management: "host" | null;
  running: boolean;
  /** Add to this server can run here (a current server, and it can install or is installed). */
  canAdd: boolean;
  can: { updateComputer: boolean; retryMigration: boolean; runDiagnostics: boolean; openLogs: boolean; retryRead: boolean };
  /** Still checking after CHECKING_STALL_MS: say it is unknown, with Try again. */
  checkingStalled?: boolean;
}

export interface ThisDeviceActionPlan {
  /** The status line's words when the state's phrase would guess (unknown, not "Stopped"). */
  statusMessageId: MessageId | null;
  actions: ThisDeviceAction[];
}

/** How long "Checking…" may last before the page says the status is unknown. */
export const CHECKING_STALL_MS = 45_000;

/**
 * Run diagnostics would run: an installed Computer that reports doctor-json,
 * or one whose capabilities are unknown on a Raft Desktop that then tries
 * `doctor --json` anyway (it publishes readError; an older one refuses).
 * Not installed: nothing to diagnose. The host state unknown: not offered
 * (Try again reads it first).
 */
export function diagnosticsUsable(hostState: DesktopComputerHostState | null, capabilities: string[] | null): boolean {
  // Unknown (the host state could not be read): what it reports is unknown too, and the shell may refuse.
  if (!hostState) return false;
  if (!hostState.installed) return false;
  if (capabilities === null) return hostState.readError !== undefined;
  return COMPUTER_FEATURE_NEEDS.diagnostics.every((need) => capabilities.includes(need));
}

const action = (id: ThisDeviceActionId, primary = false, place: ThisDeviceAction["place"] = "status"): ThisDeviceAction => ({ id, primary, place });

interface PlanContext {
  state: ThisDeviceState;
  host: ThisDeviceActionHost;
  variant: "embedded" | "standalone";
  installSupported: boolean;
  capabilities: string[] | null;
  logs: ThisDeviceAction[];
  diagnostics: ThisDeviceAction[];
}

function lifecycle({ state, host }: PlanContext, startIsFirst = true): ThisDeviceAction[] {
  if (!state.controllable || host.management !== "host") return [];
  return host.running ? [action("restart"), action("stop")] : [action("start", startIsFirst)];
}

function couldNotRead(ctx: PlanContext, repair: boolean): ThisDeviceActionPlan {
  const { host, installSupported } = ctx;
  return {
    statusMessageId: "computerHost.thisDevice.state.couldNotRead",
    actions: [
      ...(host.can.retryRead ? [action("retry-read", true)] : []),
      ...(repair && host.can.updateComputer && installSupported ? [action("repair", !host.can.retryRead)] : []),
      ...ctx.logs,
      ...(repair ? ctx.diagnostics : []),
    ],
  };
}

const plan = (actions: ThisDeviceAction[]): ThisDeviceActionPlan => ({ statusMessageId: null, actions });

const PLANS: Record<ThisDeviceStateKind, (ctx: PlanContext) => ThisDeviceActionPlan> = {
  "checking": (ctx) => (ctx.host.checkingStalled ? couldNotRead(ctx, false) : plan(ctx.logs)),
  "not-installed": (ctx) => {
    const { host, variant, installSupported } = ctx;
    if (!installSupported) return plan([action("install-elsewhere"), ...ctx.logs]);
    const install = host.can.updateComputer;
    // An older Desktop's embedded Computer that never moved: finish the move first.
    if (host.hostState?.leftoverAttachments === true && install) return plan([action("finish-move", true), ...ctx.logs]);
    if (variant === "standalone" && host.canAdd) return plan([action("add", true)]);
    if (install) return plan([action("install", true)]);
    if (host.canAdd) return plan([action("add", true)]);
    return plan([action("install-elsewhere"), ...ctx.logs]);
  },
  "setting-up": (ctx) => plan(ctx.logs),
  "migrating": (ctx) => plan(ctx.logs),
  "migration-failed": (ctx) => plan([
    ...(ctx.host.can.retryMigration ? [action("retry-migration", true)] : []),
    ...ctx.diagnostics,
    ...ctx.logs,
  ]),
  "update-required": (ctx) => plan([
    ...lifecycle(ctx, !ctx.host.can.updateComputer),
    ...(ctx.host.can.updateComputer ? [action("update", true, "updates")] : []),
  ]),
  "updating": (ctx) => plan(ctx.logs),
  "stopped": (ctx) => plan([
    ...lifecycle(ctx),
    ...(ctx.state.flags.updateAvailable && ctx.host.can.updateComputer && ctx.host.management === "host" ? [action("update-now", false, "updates")] : []),
  ]),
  "running": (ctx) => plan([
    ...lifecycle(ctx),
    ...(ctx.state.flags.updateAvailable && ctx.host.can.updateComputer && ctx.host.management === "host" ? [action("update-now", false, "updates")] : []),
  ]),
  "unreadable": (ctx) => couldNotRead(ctx, true),
  "duplicate-key": (ctx) => plan([...ctx.diagnostics, ...ctx.logs]),
};

/**
 * What This device offers in each state (every state offers at least one
 * step; none known to fail). `installSupported` and `capabilities` are the
 * host state's (unknown host: supported, capabilities null).
 */
export function thisDeviceActions(
  state: ThisDeviceState,
  host: ThisDeviceActionHost,
  variant: "embedded" | "standalone",
  installSupported: boolean,
  capabilities: string[] | null,
): ThisDeviceActionPlan {
  const ctx: PlanContext = {
    state,
    host,
    variant,
    installSupported,
    capabilities,
    logs: host.can.openLogs ? [action("open-logs")] : [],
    // A problem opens Troubleshoot, which has Run diagnostics: there, not twice.
    diagnostics: host.can.runDiagnostics && diagnosticsUsable(host.hostState, capabilities)
      ? [action("run-diagnostics", false, state.problem ? "troubleshoot" : "status")]
      : [],
  };
  const result = PLANS[state.kind](ctx);
  // A shell without the pieces a state's own steps need still offers its logs.
  if (result.actions.length === 0 && ctx.logs.length > 0) return { ...result, actions: ctx.logs };
  return result;
}

/** The plan's first step, for a surface with room for one (the Computers row). */
export function primaryThisDeviceAction(plan: ThisDeviceActionPlan): ThisDeviceAction | null {
  return plan.actions.find((candidate) => candidate.primary) ?? null;
}

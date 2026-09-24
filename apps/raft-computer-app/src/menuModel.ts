// Pure menu builder for the Raft Desktop menu-bar app (v14 IA).
//
// Inputs: AppState snapshot → output: MenuNode[] tree for the macOS NSMenu.
// "Pure" = no Electron, no fs, no env. The menu is a projection of the shared
// Computer affordance kernel; main.ts maps MenuNode[] to Menu.buildFromTemplate.
//
// Menu groups (v14 wireframe):
//   Account → identity with Sign out submenu / Session expired / Sign in
//   Workspace connections → per-workspace rows (dot + name → submenu) + Connect
//   App lifecycle → Update available (top-level) + version submenu
//     (Send diagnostics, View logs, Launch at login) + Quit
//
// Per-workspace row state (§106 locked principle — each row derives its own
// state, aggregateHealth is tray-icon only):
//   Online         = health=ok + serverConnected
//   Needs attention = health=degraded (includes sticky fatalConfig)
//   Verifying      = health=ok + !serverConnected (runner up, connecting)
//   Offline        = everything else

import {
  deriveComputerAffordances,
  deriveTrayHealth,
  deriveWorkspaceAffordanceState,
  getComputerActionConfirmation,
  semverGreaterForComputerAffordances,
  type ComputerActionConfirmation,
  type ComputerAffordanceRisk,
  type ComputerAffordances,
  type ComputerStatusReport,
  type ComputerSurfaceAction,
  type ServerStatusRow,
  type WorkspaceAffordance,
  type WorkspaceAffordanceState,
} from "@botiverse/raft-computer/lib";

import type { Action, ActionInvocation } from "./actionRunner.js";

export interface AppState {
  /** The latest `getStatus()` response. `null` before the first refresh
   *  or when the lib reader threw — caller treats null as "checking…". */
  status: ComputerStatusReport | null;
  /** CDN's manifest "latest" version, or null when the probe failed /
   *  has not run yet. */
  latestVersion: string | null;
  /** Short label shown in the status row when an action is mid-flight
   *  ("Restarting service…"). null = idle. */
  inFlight: string | null;
  /** Per-server last-crash one-line summary, keyed by serverId. Populated
   *  by main.ts running `api.doctor({serverId})` on degraded servers; the
   *  per-server submenu shows it as a non-clickable info row so the user
   *  doesn't have to dig into Run Doctor to see why a runner went red. */
  serverCrashReasons: Record<string, string>;
  /** Whether macOS launch-at-login is enabled. Read from
   *  `app.getLoginItemSettings()` by main.ts. */
  launchAtLogin: boolean;
}

export interface MenuModelDeps {
  /** Local Computer version (`COMPUTER_VERSION` from the lib). */
  localVersion: string;
  /** Dashboard origin (e.g. https://app.slock.ai). Used for browser links. */
  dashboardUrl: string;
}

export type RolledUpHealth = "ok" | "degraded" | "stopped";

/** A single menu item. Either a `separator` row (no other fields meaningful),
 *  or an actual entry with a label + optional click → Action / submenu. */
export type MenuNode = MenuItem | MenuSeparator;

export interface MenuItem {
  separator?: undefined;
  label: string;
  /** Disabled labels render the text as a non-clickable info row.
   *  Defaults to enabled when omitted. */
  enabled?: boolean;
  click?: Action;
  submenu?: MenuNode[];
  /** macOS native role (e.g. "quit"). When set, click/submenu are ignored
   *  and the OS handles the action directly. */
  role?: "quit";
  /** Checkbox state for toggle items (e.g. "Launch at login"). */
  checked?: boolean;
  /** Kernel-owned action risk consumed by the shared confirmation adapter. */
  risk?: ComputerAffordanceRisk;
  /** Shared kernel copy for a confirm-risk action. The click adapter passes
   *  this through without deriving confirmation policy from the Action kind. */
  confirmation?: ComputerActionConfirmation;
  /** Honest reason for an affordance-backed disabled action. Electron maps
   *  this directly to the native menu item's tooltip. */
  unavailableReason?: string;
}

export interface MenuSeparator {
  separator: true;
}

// ---- helpers (pure) ----

/** Compare two MAJOR.MINOR.PATCH semvers. Returns true iff `a > b`. */
export function semverGreater(a: string, b: string): boolean {
  return semverGreaterForComputerAffordances(a, b);
}

/** Worst-of(service-state, any-runner-state). The tray icon + top label
 *  pull from this so a runner-degraded never masks under service-running. */
export function aggregateHealth(report: ComputerStatusReport | null): RolledUpHealth {
  return deriveTrayHealth(report);
}

/** Tray icon basename + template flag per `RolledUpHealth`. The macOS tray
 *  uses three variants:
 *    - ok       → `iconTemplate.png` (a template image — the OS auto-tints it
 *                 for dark/light menubar)
 *    - degraded → `iconAttention.png` (orange, NOT a template so the OS does
 *                 NOT strip its color — the orange is the signal)
 *    - stopped  → `iconDimmedTemplate.png` (still a template, lower alpha;
 *                 reads as "off" without shouting)
 *
 *  This is the keystone of the honest-status story: the icon the user sees in
 *  the menubar must reflect `aggregateHealth(status)` exactly, with `degraded`
 *  the only non-template (colored) variant. Pure mapping — lives here (not in
 *  the Electron main) so it's covered by the middle-layer test matrix. The
 *  presenter (main.ts) feeds the result to `nativeImage.setTemplateImage`. */
export function trayIconBasename(health: RolledUpHealth): {
  basename: string;
  isTemplate: boolean;
} {
  switch (health) {
    case "ok":
      return { basename: "iconTemplate.png", isTemplate: true };
    case "degraded":
      return { basename: "iconAttentionTemplate.png", isTemplate: true };
    case "stopped":
      return { basename: "iconDimmedTemplate.png", isTemplate: true };
  }
}

/** A single crash record from `api.doctor({serverId}).crashes`. The lib's
 *  internal `CrashEntry` is not exported; this is its structural shape. */
export interface CrashEntry {
  at: string;
  exitCode: number | null;
  signal: string | null;
}

/** One-line crash summary for the per-server submenu's `Crash:` row. Picks the
 *  most-recent crash; prefers a signal name, falls back to `exit <code>`, then
 *  `exit ?` when the code is null too; `"no recorded crash"` when the history is
 *  empty. `formatTime` is injected (main.ts passes a locale/TZ-dependent
 *  `toLocaleString`) so this stays deterministic + testable — the structural
 *  choice (signal vs exit vs no-crash) is what we pin, NOT the localized
 *  timestamp string. */
export function crashSummary(
  crashes: CrashEntry[] | undefined,
  formatTime: (iso: string) => string,
): string {
  const last = crashes?.[crashes.length - 1];
  if (last === undefined) return "no recorded crash";
  const cause = last.signal !== null ? last.signal : `exit ${last.exitCode ?? "?"}`;
  return `${cause} (${formatTime(last.at)})`;
}

// ---- workspace row state (v14 IA per-workspace derivation) ----

/** Per-workspace row status derived from the lib's health/connected fields.
 *  `aggregateHealth` is for the tray icon only; each row derives its own
 *  state independently (#106 locked principle). */
export type WorkspaceRowState = "online" | "offline" | "needs-attention" | "verifying";

export function deriveWorkspaceState(server: ServerStatusRow): WorkspaceRowState {
  return menuWorkspaceState(deriveWorkspaceAffordanceState(server));
}

function statusDot(ws: WorkspaceRowState): string {
  switch (ws) {
    case "online": return "•";
    case "needs-attention": return "*";
    case "verifying": return "*";
    case "offline": return "◦";
  }
}

function statusLabel(ws: WorkspaceRowState): string {
  switch (ws) {
    case "online": return "Online";
    case "needs-attention": return "Needs attention";
    case "verifying": return "Verifying";
    case "offline": return "Offline";
  }
}

// ---- builder (v14 IA) ----

export function buildMenuModel(state: AppState, deps: MenuModelDeps): MenuNode[] {
  const affordances = deriveComputerAffordances({
    status: state.status,
    localVersion: deps.localVersion,
    latestVersion: state.latestVersion,
    inFlight: state.inFlight,
  });
  return affordancesToMenuItems(affordances, state, deps);
}

export function affordancesToMenuItems(
  affordances: ComputerAffordances,
  state: AppState,
  deps: MenuModelDeps,
): MenuNode[] {
  const nodes: MenuNode[] = [];

  // --- checking status (null report) ---
  if (affordances.account === "checking") {
    nodes.push({ label: "Checking status…", enabled: false });
    nodes.push({ separator: true });
    nodes.push({ label: `Raft Desktop v${deps.localVersion}`, enabled: false });
    nodes.push(actionNode("Quit Raft Desktop", requireProjectedAction(affordances, "quit-app"), state, deps));
    return nodes;
  }

  // --- account group ---
  nodes.push({ label: "Account", enabled: false });
  if (typeof affordances.account === "object") {
    nodes.push({
      label: affordances.account.signedInAs,
      submenu: [actionNode("Sign out", requireProjectedAction(affordances, "sign-out"), state, deps)],
    });
  } else {
    nodes.push(actionNode("Sign in", requireProjectedAction(affordances, "connect-workspace"), state, deps));
  }
  nodes.push({ separator: true });

  // --- server connections group (signed-in only) ---
  if (typeof affordances.account === "object") {
    nodes.push({ label: "Servers", enabled: false });
    if (affordances.workspaces.length === 0) {
      nodes.push({ label: "No servers connected", enabled: false });
    } else {
      for (const workspace of affordances.workspaces) {
        const ws = menuWorkspaceState(workspace.state);
        nodes.push({
          label: `${statusDot(ws)}  ${workspace.label}`,
          submenu: buildWorkspaceSubmenu(workspace, affordances, state, deps),
        });
      }
    }
    nodes.push(actionNode(
      "Connect server…",
      requireProjectedAction(affordances, "connect-workspace"),
      state,
      deps,
    ));
    nodes.push({ separator: true });
  }

  // --- app lifecycle + support (consolidated) ---
  nodes.push({
    label: `Raft Desktop v${deps.localVersion}`,
    submenu: buildAppSubmenu(affordances, state, deps),
  });
  const update = projectedAction(affordances, "upgrade");
  if (update !== null && update.action.kind === "upgrade") {
    nodes.push(actionNode(`Update available · v${update.action.targetVersion}`, update, state, deps));
  }
  nodes.push(actionNode("Quit Raft Desktop", requireProjectedAction(affordances, "quit-app"), state, deps));

  return nodes;
}

function buildWorkspaceSubmenu(
  workspace: WorkspaceAffordance,
  affordances: ComputerAffordances,
  state: AppState,
  deps: MenuModelDeps,
): MenuNode[] {
  const items: MenuNode[] = [];
  const ws = menuWorkspaceState(workspace.state);

  // Header: status line
  items.push({ label: statusLabel(ws), enabled: false });
  items.push({ separator: true });

  // Actions vary by state
  switch (ws) {
    case "online":
      items.push(actionNode(
        "Open workspace",
        requireProjectedAction(affordances, "open-computer", workspace.serverId),
        state,
        deps,
      ));
      break;

    case "offline":
      items.push(actionNode(
        "Recover connection",
        requireProjectedAction(affordances, "start-service", workspace.serverId),
        state,
        deps,
      ));
      items.push(actionNode(
        "Open workspace",
        requireProjectedAction(affordances, "open-computer", workspace.serverId),
        state,
        deps,
      ));
      break;

    case "needs-attention":
      items.push(actionNode(
        "Recover connection",
        requireProjectedAction(affordances, "restart-runner", workspace.serverId),
        state,
        deps,
      ));
      items.push(actionNode(
        "Open workspace",
        requireProjectedAction(affordances, "open-computer", workspace.serverId),
        state,
        deps,
      ));
      break;

    case "verifying":
      items.push(actionNode(
        "Open setup progress",
        requireProjectedAction(affordances, "connect-workspace", workspace.serverId),
        state,
        deps,
      ));
      items.push(actionNode(
        "Open workspace",
        requireProjectedAction(affordances, "open-computer", workspace.serverId),
        state,
        deps,
      ));
      break;
  }

  return items;
}

function buildAppSubmenu(affordances: ComputerAffordances, state: AppState, deps: MenuModelDeps): MenuNode[] {
  const items: MenuNode[] = [];

  const diagnostics = projectedAction(affordances, "diagnostics-push");
  if (diagnostics?.available === true) {
    items.push(actionNode("Send diagnostics", diagnostics, state, deps));
  }
  const viewLog = projectedAction(affordances, "view-log");
  if (viewLog?.available === true) {
    items.push(actionNode("View logs", viewLog, state, deps));
  }
  const launchAtLogin = requireProjectedAction(affordances, "toggle-launch-at-login");
  items.push({
    ...actionNode("Launch at login", launchAtLogin, state, deps),
    checked: state.launchAtLogin,
  });

  return items;
}

interface ProjectedAction {
  action: ComputerSurfaceAction;
  available: boolean;
  unavailableReason: string | null;
}

function actionNode(
  label: string,
  projected: ProjectedAction,
  state: AppState,
  deps: MenuModelDeps,
): MenuItem {
  const base = { label, risk: projected.action.risk };
  if (projected.available) {
    return {
      ...base,
      ...(projected.action.risk === "confirm"
        ? { confirmation: getComputerActionConfirmation(projected.action) }
        : {}),
      click: toRunnerAction(projected.action, state, deps),
    };
  }
  return {
    ...base,
    enabled: false,
    unavailableReason: projected.unavailableReason ?? "This action is unavailable.",
  };
}

export function actionInvocationForMenuItem(
  item: MenuItem,
  action: Action,
): ActionInvocation {
  if (item.risk === "safe") return { action, risk: "safe" };
  if (item.risk === "confirm" && item.confirmation !== undefined) {
    return { action, risk: "confirm", confirmation: item.confirmation };
  }
  return { action, risk: "destructive" };
}

function trim(url: string): string {
  return url.replace(/\/$/, "");
}

function computerPageUrl(action: Extract<ComputerSurfaceAction, { kind: "open-computer" }>, deps: MenuModelDeps): string {
  const hint = action.urlHint;
  const base = `${trim(deps.dashboardUrl)}/s/${hint.serverSlug ?? hint.serverId}`;
  return hint.machineId ? `${base}/computer/${hint.machineId}` : `${base}/computers`;
}

function menuWorkspaceState(state: WorkspaceAffordanceState): WorkspaceRowState {
  return state === "needs_attention" ? "needs-attention" : state;
}

function projectedAction(
  affordances: ComputerAffordances,
  kind: ComputerSurfaceAction["kind"],
  serverId: string | null = null,
): ProjectedAction | null {
  const emitted = allEmittedActions(affordances).find((action) => actionMatches(action, kind, serverId));
  if (emitted !== undefined) return { action: emitted, available: true, unavailableReason: null };

  const blocked = Object.values(affordances.blocked).find(({ action }) => actionMatches(action, kind, serverId));
  if (blocked === undefined) return null;
  return {
    action: blocked.action,
    available: false,
    unavailableReason: blocked.message ?? blocked.reason,
  };
}

function requireProjectedAction(
  affordances: ComputerAffordances,
  kind: ComputerSurfaceAction["kind"],
  serverId: string | null = null,
): ProjectedAction {
  const projected = projectedAction(affordances, kind, serverId);
  if (projected === null) {
    throw new Error(`Affordance kernel omitted required menu action: ${kind}${serverId === null ? "" : `:${serverId}`}`);
  }
  return projected;
}

function allEmittedActions(affordances: ComputerAffordances): ComputerSurfaceAction[] {
  return [
    ...affordances.globalActions,
    ...affordances.workspaces.flatMap((workspace) => [
      ...(workspace.primary === null ? [] : [workspace.primary]),
      ...workspace.secondary,
    ]),
  ];
}

function actionMatches(
  action: ComputerSurfaceAction,
  kind: ComputerSurfaceAction["kind"],
  serverId: string | null,
): boolean {
  if (action.kind !== kind) return false;
  const actionServerId = "serverId" in action ? action.serverId ?? null : null;
  return actionServerId === serverId;
}

function toRunnerAction(action: ComputerSurfaceAction, state: AppState, deps: MenuModelDeps): Action {
  switch (action.kind) {
    case "login":
      return { kind: "login" };
    case "sign-out":
      return { kind: "signOut" };
    case "connect-workspace":
      return {
        kind: "connectWorkspace",
        ...(action.serverId === undefined ? {} : { serverId: action.serverId }),
        ...(action.serverLabel === undefined ? {} : { serverLabel: action.serverLabel }),
      };
    case "start-service":
      return { kind: "startService", serverId: action.serverId, serverLabel: action.serverLabel };
    case "restart-service":
      return { kind: "restartService" };
    case "restart-runner":
      return { kind: "restartRunner", serverId: action.serverId };
    case "upgrade":
      return { kind: "upgrade", targetVersion: action.targetVersion };
    case "open-computer":
      return { kind: "openUrl", url: computerPageUrl(action, deps) };
    case "run-doctor":
      return { kind: "runDoctor" };
    case "diagnostics-push":
      return { kind: "diagnosticsPush" };
    case "view-log":
      return { kind: "viewLog", path: action.path };
    case "toggle-launch-at-login":
      return { kind: "toggleLaunchAtLogin", currentlyEnabled: state.launchAtLogin };
    case "quit-app":
      return { kind: "quitApp" };
  }
}

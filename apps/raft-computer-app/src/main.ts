// Native menu-bar app for the Raft Computer.
//
// This file owns the **Electron integration only**:
//   - app lifecycle (whenReady, dock-hide, window-all-closed, activate)
//   - Tray binding + tray icon path resolution
//   - polling cadence (status + CDN-latest)
//   - mapping our pure `MenuNode[]` tree → Electron's
//     `Menu.buildFromTemplate(...)` MenuItemConstructorOptions
//   - presenter implementation: notify (dialog.showMessageBox),
//     openUrl (shell.openExternal)
//
// No menu-shape logic: menuModel.ts owns that pure transformation.
// No action dispatch: actionRunner.ts owns that side-effect routing.
// Together the three files mirror the CLI's reducer/presenter split —
// see #wg-raft-computer:69c76b6e thread for the design.
import {
  app,
  clipboard,
  Menu,
  Tray,
  dialog,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
  type BrowserWindow,
} from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import {
  COMPUTER_VERSION,
  DEFAULT_UPGRADE_BASE_URL,
  createComputerApi,
  createComputerTracer,
  convergeAppHostLifecycle,
  fetchCdnLatestVersion,
  getComputerActionAvailability,
  resolveRaftHome,
  runResident,
  runService,
  type ComputerActionId,
  type ComputerApi,
} from "@botiverse/raft-computer/lib";

import { type Action, type ActionInvocation, runAction, type RunnerDeps } from "./actionRunner.js";
import { type AppState, type MenuNode, actionInvocationForMenuItem, aggregateHealth, buildMenuModel, crashSummary, semverGreater, trayIconBasename } from "./menuModel.js";
import { createOnboardingWindow, getOnboardingTarget, getOnboardingWindow } from "./onboardingWindow.js";
import { needsOnboarding } from "./onboardingState.js";
import { registerOnboardingIpc } from "./onboardingIpc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DASHBOARD_URL = "https://app.slock.ai";
const STATUS_POLL_INTERVAL_MS = 5_000;
const LATEST_POLL_INTERVAL_MS = 30 * 60 * 1000; // slow drumbeat

function dashboardUrl(): string {
  return process.env.RAFT_COMPUTER_APP_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
}

function assetDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "assets") : resolve(__dirname, "..", "assets");
}

function messageBoxIcon(): ReturnType<typeof nativeImage.createFromPath> {
  return nativeImage.createFromPath(join(assetDir(), "raftMark.png"));
}

// `trayIconBasename` (health → tray-icon basename + template flag) lives in the
// pure menuModel layer so the middle-layer test matrix covers it. Each basename
// has a `@2x.png` retina sibling Electron resolves automatically.

const state: AppState = {
  status: null,
  latestVersion: null,
  inFlight: null,
  serverCrashReasons: {},
  launchAtLogin: false,
};
let tray: Tray | null = null;
let api: ComputerApi | null = null;
// Single source-bound trace client for this menu-bar process. Shared between
// the action runner (action spans) and the api (route-decision spans) so both
// land in the same `<computerDir>/traces/` sink with one consistent source.
const tracer = createComputerTracer(resolveRaftHome(), "computer.menu-bar");

async function refreshState(): Promise<void> {
  if (api === null) return;
  try {
    state.status = await api.getStatus();
  } catch {
    state.status = null;
  }
  rebuildMenu();
  // Fire-and-forget: refresh crash reasons for degraded/stopped servers so
  // the per-server submenu can show "Crash: …" without the user clicking
  // Run Doctor. The status poll itself stays fast — doctor reads on disk are
  // cheap but we don't want them on the hot path. The next poll picks up
  // any newly-resolved reasons; rebuildMenu re-runs once the result lands.
  void refreshCrashReasons();
}

async function refreshCrashReasons(): Promise<void> {
  if (api === null || state.status === null) return;
  const degraded = state.status.servers.filter((s) => s.health !== "ok");
  if (degraded.length === 0) {
    if (Object.keys(state.serverCrashReasons).length > 0) {
      state.serverCrashReasons = {};
      rebuildMenu();
    }
    return;
  }
  let changed = false;
  for (const server of degraded) {
    try {
      const report = await api.doctor({ serverId: server.serverId });
      const summary = crashSummary(report.crashes, (iso) => new Date(iso).toLocaleString());
      if (state.serverCrashReasons[server.serverId] !== summary) {
        state.serverCrashReasons[server.serverId] = summary;
        changed = true;
      }
    } catch {
      // Doctor failure is best-effort context — don't poison the submenu.
    }
  }
  // Drop reasons for servers that recovered.
  for (const id of Object.keys(state.serverCrashReasons)) {
    if (!degraded.some((s) => s.serverId === id)) {
      delete state.serverCrashReasons[id];
      changed = true;
    }
  }
  if (changed) rebuildMenu();
}

async function pollLatestVersion(): Promise<void> {
  state.latestVersion = await fetchCdnLatestVersion(DEFAULT_UPGRADE_BASE_URL);
  rebuildMenu();
}

/** Build the Electron menu for the current state. The "Sync diagnostics"
 *  power/debug item lives in an always-present "Advanced" submenu (menuModel),
 *  so there is no per-click variant to compute here. */
function buildTrayMenu(): Menu {
  const tree = buildMenuModel(state, {
    localVersion: COMPUTER_VERSION,
    dashboardUrl: dashboardUrl(),
  });
  return Menu.buildFromTemplate(toElectronTemplate(tree));
}

function rebuildMenu(): void {
  if (tray === null) return;
  // Canonical reliable macOS tray pattern: attach the menu via setContextMenu
  // and let the OS open it on click. We previously tried driving every click
  // through popUpContextMenu keyed on `event.altKey` to reveal a hidden
  // diagnostics item, but the tray-click Option modifier is NOT reliably
  // populated on macOS (the KeyboardEvent modifiers are accelerator-oriented),
  // so the Option-reveal never fired in a real run (#wg-raft-computer:f2a02081).
  // The diagnostics item now lives in an always-present "Advanced" submenu, so
  // setContextMenu is both correct and the most robust choice.
  tray.setContextMenu(buildTrayMenu());
  refreshTrayIcon();
}

/** Sets `tray.image` from the rolled-up health derived off `state.status`.
 *  Idempotent: nativeImage.createFromPath is cheap, and Electron does not
 *  redraw the menubar unless the image content actually changed. */
function refreshTrayIcon(): void {
  if (tray === null) return;
  const health = aggregateHealth(state.status);
  const { basename, isTemplate } = trayIconBasename(health);
  const image = nativeImage.createFromPath(join(assetDir(), basename));
  if (isTemplate) image.setTemplateImage(true);
  tray.setImage(image);
}

function toElectronTemplate(tree: MenuNode[]): MenuItemConstructorOptions[] {
  return tree.map((node) => {
    if (node.separator) return { type: "separator" };
    const item: MenuItemConstructorOptions = { label: node.label };
    if (node.enabled === false) item.enabled = false;
    if (node.unavailableReason !== undefined) item.toolTip = node.unavailableReason;
    if (node.role === "quit") item.role = "quit";
    if (node.checked !== undefined) {
      item.type = "checkbox";
      item.checked = node.checked;
    }
    if (node.submenu) item.submenu = toElectronTemplate(node.submenu);
    if (node.click) {
      const action = node.click;
      const invocation = actionInvocationForMenuItem(node, action);
      item.click = () => void onAction(invocation);
    }
    return item;
  });
}

async function onAction(invocation: ActionInvocation): Promise<void> {
  if (api === null) return;
  const action = invocation.action;
  const deps: RunnerDeps = {
    api,
    tracer,
    notify: (kind, message, detail) => {
      void dialog.showMessageBox({
        type: kind,
        message,
        icon: messageBoxIcon(),
        ...(detail !== undefined ? { detail } : {}),
      });
    },
    openUrl: (url) => void shell.openExternal(url),
    copyToClipboard: (text) => clipboard.writeText(text),
    reviewDiagnostics: async (message, detail) => {
      const r = await dialog.showMessageBox({
        type: "info",
        message,
        detail,
        icon: messageBoxIcon(),
        buttons: ["Cancel", "Copy details", "Send diagnostics"],
        cancelId: 0,
        defaultId: 0,
      });
      if (r.response === 1) return "copy";
      if (r.response === 2) return "send";
      return "cancel";
    },
    refresh: () => refreshState(),
    setInFlight: (label) => {
      state.inFlight = label;
    },
    confirm: async (message, detail) => {
      const r = await dialog.showMessageBox({
        type: "warning",
        message,
        detail,
        icon: messageBoxIcon(),
        buttons: ["Cancel", "OK"],
        cancelId: 0,
        defaultId: 0,
      });
      return r.response === 1;
    },
    openOnboarding: (target) => {
      createOnboardingWindow(__dirname, target);
    },
    quit: () => {
      app.quit();
    },
    setLaunchAtLogin: async (enabled) => {
      const slockHome = resolveRaftHome();
      await convergeAppHostLifecycle(slockHome, enabled, {
        dispatcherPath: process.execPath,
        setOpenAtLogin: (desired) => app.setLoginItemSettings({ openAtLogin: desired }),
        getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
      });
      state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
      rebuildMenu();
    },
    getActionAvailability: (candidate) => getComputerActionAvailability(actionIdFor(candidate), {
      status: state.status,
      inFlight: state.inFlight,
      updateAvailable: state.latestVersion !== null && semverGreater(state.latestVersion, COMPUTER_VERSION),
      serverId: "serverId" in candidate ? candidate.serverId : null,
    }),
  };
  await runAction(invocation, deps);
}

function actionIdFor(action: Action): ComputerActionId {
  return action.kind;
}

// Headless-mode dispatcher — must run BEFORE `app.whenReady()` so the Electron
// process executes the supervisor (or per-server runner) loop instead of
// booting a second tray icon.
//
// `spawnDetachedService` (packages/computer/src/service.ts) re-execs us with
// `process.execPath ... <mode> [serverId]`. The token POSITION depends on
// the lib's `buildResidentSpawn` (same file):
//   - SEA binary:    `[execPath, ...execArgv, mode, serverId?]`
//                    → mode at argv[1] (no `selfEntry`)
//   - non-SEA node:  `[execPath, ...execArgv, selfEntry, mode, serverId?]`
//                    → mode at argv[2]
//   - packaged .app: Electron sets argv[1]=app path / "", `selfEntry` may
//                    be empty → mode could land at argv[1] OR argv[2]
//
// To tolerate all three layouts (Yingjun #wg-raft-computer:f2a02081
// msg=1888833a — argv-fidelity dev≠packaged), we SCAN argv for the first
// matching token after argv[0] (execPath). Any later argv entry is treated
// as positional args to that mode (currently only `__run` consumes one).
//
// We do NOT call `app.whenReady()` / construct a Tray in headless mode; we
// `process.exit` when the resident loop returns (or throws), same as the
// CLI does via `withCliExit`.
function findHeadlessMode(argv: string[]): { mode: "__service" | "__run"; rest: string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "__service" || argv[i] === "__run") {
      return { mode: argv[i] as "__service" | "__run", rest: argv.slice(i + 1) };
    }
  }
  return null;
}

function requestsVersion(argv: string[]): boolean {
  return argv.slice(1).includes("--version");
}

/**
 * Resolve the bundled `raft` CLI entry (`@botiverse/raft` → `dist/index.js`)
 * for the daemon's agent runtime (task #113). The daemon's own relative
 * `resolveRaftCliPath` CANNOT find it here: the daemon core is tsup-inlined
 * into this app bundle, so its `import.meta.url` points into the app — no
 * `cli/index.js` is adjacent. We resolve it host-side and hand the daemon the
 * real path via `RAFT_COMPUTER_CLI_PATH` (the __run child reads it in
 * `defaultCoreFactory`). Without this, the claude driver throws
 * `slockCliPath is required` and agent-start fails.
 *
 *   - packaged .app: electron-builder copies the CLI bundle to
 *     `<resources>/cli/index.js` (see electron-builder.yml extraResources).
 *   - dev / node_modules: resolve `@botiverse/raft`'s package dir → `dist/index.js`.
 *
 * Returns null when neither exists (caller leaves the env unset → daemon falls
 * back to its own resolution, same as a normal node install).
 */
function resolveBundledCliPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "cli", "index.js");
    return existsSync(packaged) ? packaged : null;
  }
  try {
    const pkgJson = createRequire(import.meta.url).resolve("@botiverse/raft/package.json");
    const devEntry = join(dirname(pkgJson), "dist", "index.js");
    return existsSync(devEntry) ? devEntry : null;
  } catch {
    return null;
  }
}

// Keep the release verifier out of the resident GUI path. This must run before
// app.whenReady() and before resolving bundled runtime dependencies so the
// packaged executable is a deterministic, side-effect-free version probe.
if (requestsVersion(process.argv)) {
  process.stdout.write(`${app.getVersion()}\n`);
  process.exit(0);
}

// Inject the CLI path BEFORE the headless dispatch / any service spawn, so the
// __service + __run children (and the GUI's spawned service) all inherit it.
// Respect an explicit override if the operator already set one.
if (!process.env.RAFT_COMPUTER_CLI_PATH) {
  const cliPath = resolveBundledCliPath();
  if (cliPath) process.env.RAFT_COMPUTER_CLI_PATH = cliPath;
}

const headless = findHeadlessMode(process.argv);
if (headless?.mode === "__service") {
  void (async () => {
    try {
      await runService();
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `raft-computer-app __service failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
} else if (headless?.mode === "__run") {
  const serverId = headless.rest[0];
  if (!serverId) {
    process.stderr.write("raft-computer-app __run requires a serverId\n");
    process.exit(2);
  }
  void (async () => {
    try {
      await runResident(serverId);
      // No process.exit(0): runResident's `core.start()` returns immediately
      // (it initiates the WS connection, doesn't block until stop). The open
      // socket keeps the process alive; SIGTERM/SIGINT handlers inside
      // runResident exit cleanly. A `process.exit(0)` here would kill the
      // just-connected daemon ~1s after "Connecting…", leaving the machine
      // offline and never reaching agent-spawn — the packaged-runner exit
      // regression Jianwei caught (task #119). Re-applies #3350, which lived
      // only on the closed in-app-attach branch and never reached staging.
    } catch (err) {
      process.stderr.write(
        `raft-computer-app __run failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  })();
} else void (async () => {
  await app.whenReady();

  const slockHome = resolveRaftHome();
  api = createComputerApi(slockHome, { tracer, hostLifecycleOwner: "app" });

  let hostLifecycleEnabled = false;
  try {
    const lifecycle = await convergeAppHostLifecycle(
      slockHome,
      app.getLoginItemSettings().openAtLogin,
      {
        dispatcherPath: process.execPath,
        setOpenAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
        getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
      },
    );
    hostLifecycleEnabled = lifecycle.enabled;
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      message: "Raft Desktop could not verify startup recovery",
      detail: error instanceof Error ? error.message : String(error),
      icon: messageBoxIcon(),
    });
  }

  if (hostLifecycleEnabled) {
    try {
      const startupStatus = await api.getStatus();
      if (startupStatus.servers.length > 0) {
        await api.start({ serverId: null, serverLabel: null });
      }
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        message: "Raft Desktop could not start Raft Computer",
        detail: error instanceof Error ? error.message : String(error),
        icon: messageBoxIcon(),
      });
    }
  }

  // Register onboarding IPC handlers before any window can be created.
  registerOnboardingIpc(
    () => api,
    () => getOnboardingWindow(),
    slockHome,
    dashboardUrl,
    () => getOnboardingTarget(),
  );

  // Hide dock icon on macOS — tray is the only surface (unless the
  // onboarding window is open, in which case the dock icon shows
  // automatically for the BrowserWindow).
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  // Tray needs an initial image to be constructed; refreshState below replaces
  // it with the health-aware variant. Use the `ok` template here as a neutral
  // placeholder — refreshState runs immediately and refreshTrayIcon() resolves
  // to the right variant before any user-perceivable delay.
  const initial = nativeImage.createFromPath(join(assetDir(), "iconTemplate.png"));
  initial.setTemplateImage(true);
  tray = new Tray(initial);
  tray.setToolTip("Raft Desktop");
  state.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  await refreshState();
  void pollLatestVersion();

  // Auto-show the onboarding window on first run (not logged in or no
  // attached servers). The tray remains active alongside. Pass __dirname
  // (= dist/) so preload.cjs and onboarding.html resolve correctly in both
  // dev and packaged builds (assetDir is for tray icons only).
  if (needsOnboarding(state.status)) {
    createOnboardingWindow(__dirname);
  }

  setInterval(() => void refreshState(), STATUS_POLL_INTERVAL_MS).unref();
  setInterval(() => void pollLatestVersion(), LATEST_POLL_INTERVAL_MS).unref();

  // No tray click handler: with setContextMenu attached, macOS opens the menu
  // itself and suppresses the `click` event, so a handler would be dead code on
  // macOS. The STATUS_POLL_INTERVAL_MS poll (refreshState → rebuildMenu →
  // setContextMenu) keeps the menu fresh.

  app.on("window-all-closed", () => {
    /* tray-resident; never quit */
  });
})();

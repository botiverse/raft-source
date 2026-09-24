// Raft Desktop (bundled app) — main process.
//
// This is the APP-version main: it loads the desktop's own bundled frontend
// locally (dist/frontend/index.html) and talks to the Raft backend directly.
// It is NOT the old thin shell that wrapped the remote website — there is no
// manifest preflight, no per-document handshake, and no remote-origin gating,
// because the content is our own first-party bundle.
//
// It keeps the genuinely reusable native pieces: window-state persistence, the
// application menu, single-instance, the auto-updater, and clean teardown.

import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { BrowserWindow, app, ipcMain, nativeImage, protocol, session, shell } from "electron";
import { runResident, runService } from "@botiverse/raft-computer/lib";
import { installApplicationMenu } from "../main/appMenu.js";
import {
  applyDownloadedUpdate,
  checkForUpdatesManually,
  getUpdateStatus,
  initializeAutoUpdater,
  onUpdateStatus,
  triggerBackgroundCheck,
} from "../main/autoUpdater.js";
import { INITIAL_LIFECYCLE_STATE, reduceLifecycle } from "../main/lifecycle.js";
import type { LifecycleEvent } from "../main/lifecycle.js";
import { loadZoomLevel, saveZoomLevel } from "../main/viewPrefs.js";
import { loadWindowState, trackWindowState } from "../main/windowState.js";
import { armOAuthLoopback, cancelOAuthLoopback, isAllowedAuthorizationUrl } from "./oauthLoopback.js";
import { createOAuthCoordinator } from "./oauthCoordinator.js";
import { ComputerHost } from "./computerHost.js";
import { installStatusMonitorLifecycle } from "../main/statusMonitorLifecycle.js";
import { createStatusMonitor } from "../main/statusMonitor.js";
import { createAppProtocolHandler } from "../main/appProtocol.js";
import type { ComputerStatusReport } from "@botiverse/raft-computer/lib";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.join(moduleDir, "frontend");
// The bundled SPA uses ES module scripts, which Chromium refuses to load over
// file:// (no real origin). A privileged app:// scheme gives it a proper secure
// origin, exactly like cumora/grok-bot serve their bundled content.
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://raft`;
const BACKGROUND_COLOR = "#fffaef";
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
// Center the ~14px macOS traffic lights in the desktop top toolbar (h-12 =
// 48px), inset from the left edge. The toolbar reserves the left inset via its
// data-raft-titlebar padding so content never sits under the lights.
const TRAFFIC_LIGHT_INSET_X = 16;
const TRAFFIC_LIGHT_INSET_Y = 16;

const APP_VERSION = app.getVersion();

// ─── Computer host (raft-computer) argv dispatch ──────────────────────────────
// The detached Computer service re-execs THIS binary with a hidden `__service` /
// `__run <serverId>` argv (spawnDetachedService in packages/computer). We must
// route those to runService/runResident BEFORE any GUI setup — otherwise the
// child just opens a second window and the supervisor never starts (raft-computer
// BUG 5). The token position varies across dev/packaged layouts, so we scan.
function findHeadlessMode(argv: string[]): { mode: "__service" | "__run"; rest: string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "__service" || argv[i] === "__run") {
      return { mode: argv[i] as "__service" | "__run", rest: argv.slice(i + 1) };
    }
  }
  return null;
}

// The `__run` child hands the bundled `raft` CLI to each agent runtime as
// slockCliPath; without it the runtime throws "slockCliPath is required". Resolve
// it before any service spawn (packaged: <resources>/cli/index.js; dev: the
// workspace @botiverse/raft dist).
function resolveBundledCliPath(): string | null {
  if (app.isPackaged) return path.join(process.resourcesPath, "cli", "index.js");
  try {
    const pkg = createRequire(import.meta.url).resolve("@botiverse/raft/package.json");
    return path.join(path.dirname(pkg), "dist", "index.js");
  } catch {
    return null;
  }
}
if (!process.env.RAFT_COMPUTER_CLI_PATH) {
  const cliPath = resolveBundledCliPath();
  if (cliPath && existsSync(cliPath)) process.env.RAFT_COMPUTER_CLI_PATH = cliPath;
  else {
    // Without this, every __run child later throws "slockCliPath is required"
    // with no host-side clue — leave a one-line breadcrumb.
    console.warn(`[raft-desktop] bundled raft CLI not found (${cliPath ?? "unresolved"}); agent runtimes will fail until RAFT_COMPUTER_CLI_PATH is set.`);
  }
}

const headlessMode = findHeadlessMode(process.argv);

let computerHost: ComputerHost | null = null;
let mainWindow: BrowserWindow | null = null;
let lifecycle = INITIAL_LIFECYCLE_STATE;
let appReady = false;
const pendingDeepLinks: string[] = [];

const DEEP_LINK_SCHEME = "raft";

function deliverDeepLink(uri: string): void {
  if (!uri.startsWith(`${DEEP_LINK_SCHEME}://`)) return;
  const window = focusedWindow();
  if (!appReady || !window) {
    pendingDeepLinks.push(uri);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("app:deep-link", uri);
}

function flushDeepLinks(): void {
  if (!appReady || !focusedWindow()) return;
  while (pendingDeepLinks.length > 0) {
    const uri = pendingDeepLinks.shift();
    if (uri) deliverDeepLink(uri);
  }
}

// The bundled frontend runs on the app:// origin but calls the Raft API on a
// different origin, so the browser enforces CORS. The API's allowlist is the
// web origins, not app://. Since this is our own first-party app talking to our
// own backend, inject permissive CORS headers onto the API's responses so the
// browser accepts them (this is the standard Electron approach for a bundled
// first-party client; it does not weaken the API itself).
const API_ORIGINS = new Set([
  "https://api.raft.build",
  "https://api-aws-staging.botiverse.dev",
]);

function installApiCorsBridge(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: [...API_ORIGINS].map((origin) => `${origin}/*`) }, (details, callback) => {
    // Match on the parsed origin, not a raw-URL prefix — a prefix test would
    // also match look-alike hosts like https://api.raft.build.evil.com.
    let origin: string;
    try {
      origin = new URL(details.url).origin;
    } catch {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!API_ORIGINS.has(origin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const headers = { ...(details.responseHeaders ?? {}) };
    // Drop any server-set variants (case-insensitively) before setting ours.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("access-control-")) delete headers[key];
    }
    // The client uses Bearer tokens, not cookies, so no credentials are sent —
    // a wildcard origin is valid. IMPORTANT: per the Fetch spec, the `*`
    // wildcard in Access-Control-Allow-Headers does NOT cover `Authorization`;
    // it must be named explicitly, or every authenticated (Bearer) request
    // fails its CORS preflight. List it alongside the wildcard.
    headers["Access-Control-Allow-Origin"] = ["*"];
    headers["Access-Control-Allow-Methods"] = ["*"];
    headers["Access-Control-Allow-Headers"] = ["*, Authorization"];
    callback({ responseHeaders: headers });
  });
}

// Detect the web social-login start URL (…/auth/<provider>/start) so the
// desktop can intercept it and run the native PKCE flow instead.
const OAUTH_PROVIDERS = new Set(["google", "github", "apple"]);
function socialProviderFromStartUrl(rawUrl: string): string | null {
  try {
    const provider = new URL(rawUrl).pathname.match(/\/auth\/([a-z]+)\/start$/)?.[1];
    if (provider && OAUTH_PROVIDERS.has(provider)) return provider;
  } catch {
    // not a URL we care about
  }
  return null;
}

// Desktop OAuth coordinator — pure logic (token/sender scoping + URL allowlist)
// lives in oauthCoordinator so it's unit-testable; here it's wired to the real
// loopback + shell.openExternal. Tokens are never handled here — the renderer
// exchanges the handoff code over HTTPS /complete.
const oauthCoordinator = createOAuthCoordinator({
  arm: armOAuthLoopback,
  cancel: cancelOAuthLoopback,
  openExternal: (url) => shell.openExternal(url),
  isAllowedUrl: isAllowedAuthorizationUrl,
  randomToken: randomUUID,
});

function registerIpcHandlers(): void {
  ipcMain.handle("oauth:arm", (e, nonce: unknown) => oauthCoordinator.arm(nonce, e.sender.id));
  ipcMain.handle("oauth:open-await", (e, payload: unknown) => oauthCoordinator.openAwait(payload, e.sender.id));
  ipcMain.on("oauth:cancel", (e, token: unknown) => oauthCoordinator.cancel(token, e.sender.id));
  ipcMain.on("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on("window:toggle-maximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle("app:is-focused", (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? false);
  ipcMain.on("app:set-badge", (_e, count: unknown) => {
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    app.setBadgeCount(n);
  });
  ipcMain.on("app:focus-window", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
}

// Computer host IPC — the renderer's window.raftDesktop.computer bridge. All
// calls delegate to the single ComputerHost; results are secret-free (attach
// returns a redacted prefix, never an apiKey). Status is both pull (computer:
// status) and push (computer:status-update, broadcast on a 5s poll).
const COMPUTER_STATUS_POLL_MS = 5_000;
let computerStatusMonitor: ReturnType<typeof createStatusMonitor<ComputerStatusReport>> | null = null;

function broadcastComputerStatus(status: ComputerStatusReport): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("computer:status-update", status);
  }
}

function registerComputerIpc(host: ComputerHost): void {
  // The local OS hostname lets the renderer correlate THIS machine to its row in
  // the server-derived machine list (so the self-card IS that computer, not a
  // separate entry) even when the local attachment predates the machineId field.
  ipcMain.handle("computer:local-info", () => ({ hostname: osHostname() }));
  const monitor = createStatusMonitor({
    read: () => host.getStatus(),
    publish: broadcastComputerStatus,
    intervalMs: COMPUTER_STATUS_POLL_MS,
  });
  computerStatusMonitor = monitor;
  installStatusMonitorLifecycle(monitor, () => lifecycle.quitting);
  ipcMain.handle("computer:status", () => monitor.read());
  ipcMain.handle("computer:enable", (_e, input: unknown) => monitor.afterOperation(() => host.enable(input as never)));
  ipcMain.handle("computer:start", () => monitor.afterOperation(() => host.start()));
  ipcMain.handle("computer:stop", () => monitor.afterOperation(() => host.stop()));
  ipcMain.handle("computer:restart", () => monitor.afterOperation(() => host.restart()));
  ipcMain.handle("computer:upgrade-info", () => host.getUpgradeInfo());
  ipcMain.handle("computer:upgrade", () => monitor.afterOperation(() => host.upgrade()));
  ipcMain.handle("computer:upgrade-fresh-install", (_e, version: unknown) =>
    monitor.afterOperation(() => host.upgradeViaFreshInstall(typeof version === "string" ? version : "")),
  );
  ipcMain.handle("computer:management", () => host.getManagement());
}

// App self-update IPC — the renderer's window.raftDesktop.appUpdate bridge. The
// updater auto-downloads in the background; the renderer renders a non-intrusive
// "restart to update" affordance from this status stream (no native modal).
function broadcastAppUpdateStatus(status: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("app-update:status-update", status);
  }
}

function registerAppUpdateIpc(deps: { markQuitting(): void }): void {
  ipcMain.handle("app-update:status", () => getUpdateStatus());
  ipcMain.on("app-update:check", () => void triggerBackgroundCheck(deps));
  ipcMain.on("app-update:restart", () => applyDownloadedUpdate(deps));
  onUpdateStatus(broadcastAppUpdateStatus);
}

// Register before app-ready. `standard` gives it URL semantics, `secure` makes
// it a secure context (crypto/service workers), `supportFetchAPI` allows fetch.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, createAppProtocolHandler(FRONTEND_ROOT));
}

function createMainWindow(): BrowserWindow {
  const restored = loadWindowState();
  const window = new BrowserWindow({
    width: restored.bounds?.width ?? 1280,
    height: restored.bounds?.height ?? 800,
    x: restored.bounds?.x,
    y: restored.bounds?.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    titleBarStyle: "hiddenInset",
    // Electron defaults this to false for our hidden-titlebar window, which
    // silently disables native fullscreen (the green button falls back to
    // zoom = "fills the screen"). Force it on so the traffic-light green button
    // and View → Toggle Full Screen enter real macOS fullscreen.
    fullscreenable: true,
    // Align the macOS traffic lights to the center of our 62px top bar (the
    // login brand bar and the app's panel-header row are both h-panel-header =
    // 62px), so the lights sit inside a real title-bar strip instead of
    // floating over content. Matches grok-bot's trafficLightPosition approach.
    trafficLightPosition: { x: TRAFFIC_LIGHT_INSET_X, y: TRAFFIC_LIGHT_INSET_Y },
    fullscreen: false,
    webPreferences: {
      preload: path.join(moduleDir, "app-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Our own realtime UI relies on the socket firing while backgrounded.
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  trackWindowState(window);

  window.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code === -3) return; // aborted (e.g. superseded navigation)
    console.warn(`[raft-desktop] load failed ${code} ${desc} ${url}`);
  });
  window.webContents.on("render-process-gone", (_e, details) =>
    console.warn(`[raft-desktop] renderer gone: ${details.reason}`),
  );

  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.webContents.setZoomLevel(loadZoomLevel());
    if (restored.fullscreen) window.setFullScreen(true);
    else if (restored.maximized) window.maximize();
    window.show();
  });

  // External links open in the system browser; the app itself never navigates
  // away from its bundled frontend.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // The app stays on app://. A social-login button navigates the page at the
  // web OAuth start URL (…/auth/<provider>/start); on desktop we don't follow
  // it — we intercept and run the native PKCE + loopback flow instead. Any other
  // off-app:// http(s) navigation opens in the system browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return;
    event.preventDefault();
    const provider = socialProviderFromStartUrl(url);
    if (provider) {
      window.webContents.send("app:oauth-start", provider);
      return;
    }
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  // Native focus state → renderer (reliable substitute for document.hasFocus).
  window.on("focus", () => window.webContents.send("app:focus-state", true));
  window.on("blur", () => window.webContents.send("app:focus-state", false));

  // Flush any deep links buffered before this window was ready. Wired per
  // window (not just the first) so a raft:// link that arrives while the app is
  // running windowless — the macOS "closed but resident" state — is delivered
  // when the next window opens rather than sitting in the buffer forever.
  window.webContents.once("did-finish-load", () => flushDeepLinks());

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Load at the app root (not /index.html) so BrowserRouter's initial pathname
  // is "/". The protocol handler serves index.html for it.
  void window.loadURL(`${APP_ORIGIN}/`);
  return window;
}

function focusedWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function zoom(direction: "in" | "out" | "reset"): void {
  const window = focusedWindow();
  if (!window) return;
  const contents = window.webContents;
  if (direction === "reset") {
    contents.setZoomLevel(0);
    saveZoomLevel(0);
    return;
  }
  const next = Math.max(
    ZOOM_MIN,
    Math.min(ZOOM_MAX, contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5)),
  );
  contents.setZoomLevel(next);
  saveZoomLevel(next);
}

function applyLifecycle(event: LifecycleEvent): void {
  const { state, decision } = reduceLifecycle(lifecycle, event, process.platform);
  lifecycle = state;
  if (decision === "quit") app.quit();
  if (decision === "reboot" && !mainWindow) createMainWindow();
}

function markQuitting(): void {
  computerStatusMonitor?.setActive(false);
  applyLifecycle({ type: "before-quit" });
}

if (headlessMode) {
  // A headless service/runner child re-launched this bundle. It has no GUI, so
  // keep it off the Dock (it would otherwise show a spurious second icon).
  if (process.platform === "darwin") app.dock?.hide();
}
if (headlessMode?.mode === "__service") {
  // Detached supervisor process — run the service, then exit. No GUI, no lock.
  void runService()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`[raft-desktop] __service failed: ${String(error)}\n`);
      process.exit(1);
    });
} else if (headlessMode?.mode === "__run") {
  // Per-server daemon child. runResident must NOT be followed by process.exit:
  // its open WebSocket keeps the process alive.
  const serverId = headlessMode.rest[0];
  if (!serverId) {
    process.stderr.write("[raft-desktop] __run requires a serverId\n");
    process.exit(2);
  } else {
    void runResident(serverId).catch((error: unknown) => {
      process.stderr.write(`[raft-desktop] __run failed: ${String(error)}\n`);
      process.exit(1);
    });
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  // macOS deep links arrive via open-url (may fire before ready).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });
  // Windows/Linux: a raft:// launch arrives as argv of the (second) instance.
  const coldStartLink = process.argv.slice(1).find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (coldStartLink) pendingDeepLinks.push(coldStartLink);

  app.on("second-instance", (_event, commandLine) => {
    const window = focusedWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const link = commandLine.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (link) deliverDeepLink(link);
  });

  app.on("before-quit", () => {
    computerStatusMonitor?.setActive(false);
    applyLifecycle({ type: "before-quit" });
  });
  app.on("window-all-closed", () => applyLifecycle({ type: "window-all-closed" }));
  app.on("activate", () =>
    applyLifecycle({ type: "activate", hasServerWindows: mainWindow !== null }),
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => app.quit());
  }

  void app.whenReady().then(() => {
    // In dev (unpacked), macOS shows the default Electron dock icon — the real
    // brand mark only ships inside the packaged .app (build/icon.icns). Set it
    // explicitly so `pnpm start` also shows the Raft icon. Packaged builds get
    // the bundle icon automatically, so skip there.
    if (process.platform === "darwin" && !app.isPackaged) {
      const brandIcon = nativeImage.createFromPath(path.join(app.getAppPath(), "build", "icon.png"));
      if (!brandIcon.isEmpty()) app.dock?.setIcon(brandIcon);
    }
    registerAppProtocol();
    installApiCorsBridge();
    registerIpcHandlers();
    installApplicationMenu({
      openAbout: () => {
        // A native About panel; the app's own UI can add a richer one later.
        app.setAboutPanelOptions({
          applicationName: "Raft Desktop",
          applicationVersion: APP_VERSION,
          version: `Electron ${process.versions.electron}`,
        });
        app.showAboutPanel();
      },
      checkForUpdates: () => void checkForUpdatesManually({ markQuitting }),
      reload: () => focusedWindow()?.webContents.reload(),
      zoom,
      focusedServerWindow: () => focusedWindow(),
    });

    initializeAutoUpdater({ markQuitting });
    registerAppUpdateIpc({ markQuitting });

    // Become the OS-supervised host of the local Computer service. The heavy
    // __service/__run tree stays detached and login-item supervised, so quitting
    // this window never stops running agents; we only control + observe it.
    // Safety valve: RAFT_DESKTOP_DISABLE_COMPUTER_HOST=1 skips host init entirely
    // (no lifecycle mutation, no service spawn) — for dev/CI smoke boots on a
    // machine that already runs a Computer service. Default is enabled.
    if (process.env.RAFT_DESKTOP_DISABLE_COMPUTER_HOST !== "1") {
      computerHost = new ComputerHost();
      registerComputerIpc(computerHost);
      // Read-only mode observes + surfaces an already-installed Computer (the
      // "adopt" path) but does NOT converge host lifecycle — no launch-at-login
      // mutation, no service spawn. Safe to run on a machine already hosting a
      // live Computer service. Full mode (default) converges + can boot it.
      if (process.env.RAFT_DESKTOP_COMPUTER_READONLY !== "1") {
        void computerHost.converge().then((result) => {
          if (!result.ok) console.warn(`[raft-desktop] computer host converge: ${result.error ?? "failed"}`);
        });
      }
    }

    appReady = true;
    // createMainWindow wires its own per-window did-finish-load → flushDeepLinks.
    createMainWindow();
  });
}

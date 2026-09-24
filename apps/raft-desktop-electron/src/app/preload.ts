// Preload for the bundled desktop frontend. The frontend is our own
// first-party code, so this exposes a native-integration bridge directly
// (no capability gating needed — it's not untrusted remote content).

import { contextBridge, ipcRenderer } from "electron";

function subscribe<T>(channel: string, handler: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T) => handler(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

// Deep links can arrive before the frontend mounts its listener (cold start,
// or before login). Buffer them here from preload load and replay on subscribe
// so none are lost.
const pendingDeepLinks: string[] = [];
let deepLinkHandler: ((uri: string) => void) | null = null;
ipcRenderer.on("app:deep-link", (_event, uri: string) => {
  if (deepLinkHandler) deepLinkHandler(uri);
  else pendingDeepLinks.push(uri);
});

contextBridge.exposeInMainWorld("raftDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  // Window controls (for a custom title bar; the hiddenInset traffic lights
  // stay available too).
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
  },

  // Native focus state (reliable substitute for document.hasFocus()).
  isFocused: (): Promise<boolean> => ipcRenderer.invoke("app:is-focused"),
  onFocusChange: (handler: (focused: boolean) => void) =>
    subscribe<boolean>("app:focus-state", handler),

  // Dock unread badge (0 clears it).
  setBadgeCount: (count: number) => ipcRenderer.send("app:set-badge", count),

  // Bring the window forward (e.g. when an OS notification is clicked).
  focusWindow: () => ipcRenderer.send("app:focus-window"),

  // Desktop OAuth (native half). The renderer owns PKCE + the /start & /complete
  // HTTPS calls; this bridges the loopback + system browser only.
  oauth: {
    // Arm the loopback with the desktop nonce; returns the chosen local port and
    // a one-time token that scopes the rest of this attempt to this renderer.
    arm: (nonce: string): Promise<{ port: number; token: string }> =>
      ipcRenderer.invoke("oauth:arm", nonce),
    // Open the provider authorization URL in the system browser and resolve with
    // the one-time handoff code once the browser completes. The token must match
    // the arm call; the URL is validated against a host allowlist in main.
    openAndAwait: (authorizationUrl: string, token: string): Promise<{ code: string }> =>
      ipcRenderer.invoke("oauth:open-await", { authorizationUrl, token }),
    // Cancel only this attempt (token-scoped, so a stale flow can't cancel a
    // newer one in the same renderer).
    cancel: (token: string) => ipcRenderer.send("oauth:cancel", token),
    // Fired when a social-login button is clicked (the shell intercepted the web
    // start URL); the renderer runs the desktop flow for this provider.
    onStart: (handler: (provider: string) => void) => subscribe<string>("app:oauth-start", handler),
  },

  // Local Computer host — this app is also the OS-supervised host of the local
  // raft-computer service. The renderer surfaces/controls it through here; the
  // heavy service is detached (survives app quit). Present => host-capable build.
  computer: {
    hostCapable: true,
    // Local machine identity (OS hostname) so the renderer can correlate THIS
    // machine to its row in the server-derived list and merge them.
    getLocalInfo: (): Promise<{ hostname: string }> => ipcRenderer.invoke("computer:local-info"),
    // Read the aggregate service + per-server status once.
    getStatus: (): Promise<unknown> => ipcRenderer.invoke("computer:status"),
    // Live status pushed on the main-process poll (every 5s). Returns unsubscribe.
    onStatus: (handler: (status: unknown) => void): (() => void) =>
      subscribe<unknown>("computer:status-update", handler),
    // One-click "make this computer available for <server>" using the caller's
    // existing chat session (no separate device-code login). Returns a
    // secret-free AttachResult.
    enable: (input: {
      serverSlug: string;
      serverUrl: string;
      accessToken: string;
      refreshToken: string;
      name?: string;
    }): Promise<unknown> => ipcRenderer.invoke("computer:enable", input),
    start: (): Promise<void> => ipcRenderer.invoke("computer:start"),
    stop: (): Promise<void> => ipcRenderer.invoke("computer:stop"),
    restart: (): Promise<void> => ipcRenderer.invoke("computer:restart"),
    // The latest Computer version on the CDN — the renderer compares it to the
    // running service version to decide whether to offer a local update.
    getUpgradeInfo: (): Promise<{ latestVersion: string | null }> => ipcRenderer.invoke("computer:upgrade-info"),
    // Upgrade THIS machine's service to the CDN latest (local action). Progress
    // is surfaced via getStatus().upgrade in the normal status stream.
    upgrade: (): Promise<void> => ipcRenderer.invoke("computer:upgrade"),
    // Force a fresh install of a specific version via the official installer —
    // the desktop-executed fallback for a standalone computer whose source can't
    // remote self-upgrade (what the web can only show as a copy-paste command).
    upgradeViaFreshInstall: (version: string): Promise<void> =>
      ipcRenderer.invoke("computer:upgrade-fresh-install", version),
    // How the local computer is managed: "app" = its binary is this app (upgrade
    // via the app updater); "standalone" = an external install (remote/fresh
    // install); "unknown" = not determinable yet.
    getManagement: (): Promise<{ model: "app" | "standalone" | "unknown" }> =>
      ipcRenderer.invoke("computer:management"),
  },

  // App self-update (electron-updater). The app auto-downloads updates silently
  // in the background; the renderer surfaces a non-intrusive "restart to update"
  // affordance from this status stream — no native modal. Inert (state
  // "unsupported") in dev/unsigned builds with no update feed.
  appUpdate: {
    getStatus: (): Promise<unknown> => ipcRenderer.invoke("app-update:status"),
    onStatus: (handler: (status: unknown) => void): (() => void) =>
      subscribe<unknown>("app-update:status-update", handler),
    // Restart now to apply a fully-downloaded update.
    restartToApply: () => ipcRenderer.send("app-update:restart"),
    // Trigger a silent check; the outcome arrives via onStatus.
    checkNow: () => ipcRenderer.send("app-update:check"),
  },

  // raft:// deep links routed to the app. Replays any buffered links (received
  // before this subscription) so a cold-start link is never dropped.
  onDeepLink: (handler: (uri: string) => void): (() => void) => {
    deepLinkHandler = handler;
    while (pendingDeepLinks.length > 0) {
      const uri = pendingDeepLinks.shift();
      if (uri) handler(uri);
    }
    return () => {
      if (deepLinkHandler === handler) deepLinkHandler = null;
    };
  },
});

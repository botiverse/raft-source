// Auto-update via electron-updater. Self-contained and safe by default:
// - No-ops in dev / unsigned builds where there is no update feed, so it can
//   be wired unconditionally.
// - A ready update shows a native restart dialog (no web coordination needed);
//   status is also broadcast so the web can render its own update UI if it wants.
// - Heals a corrupted download cache (SHA512 mismatch) by wiping userData/pending
//   and retrying once, instead of failing every future update forever.
// - Handles the macOS quitAndInstall quirk: it goes through Browser::Shutdown()
//   and skips before-quit, so we flip the lifecycle's quitting flag first.
//
// electron-updater is required lazily: importing it in dev tries to read
// app-update.yml and would throw before the guard runs.

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";

const CHECK_DELAY_MS = 3000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 500;
const PROGRESS_MIN_DELTA = 1; // percent

export type UpdateStatus =
  | { state: "unsupported" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

interface UpdaterDeps {
  markQuitting(): void;
}

type ElectronUpdater = typeof import("electron-updater")["autoUpdater"];

let started = false;
let selfHealed = false;
let currentStatus: UpdateStatus = { state: "idle" };
let instance: ElectronUpdater | null = null;
let instancePromise: Promise<ElectronUpdater | null> | null = null;
let manualInFlight = false;
let lastProgressAt = 0;
let lastProgressPct = -1;
const listeners = new Set<(status: UpdateStatus) => void>();

function hasUpdateConfig(): boolean {
  // Packaged builds ship app-update.yml next to the app resources; a dev
  // override can live at the repo root as dev-app-update.yml.
  if (app.isPackaged) {
    return existsSync(path.join(process.resourcesPath, "app-update.yml"));
  }
  return existsSync(path.join(app.getAppPath(), "dev-app-update.yml"));
}

function setStatus(status: UpdateStatus): void {
  currentStatus = status;
  for (const listener of listeners) {
    try {
      listener(status);
    } catch {
      // a bad listener must not break the updater
    }
  }
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadInstance(deps: UpdaterDeps): Promise<ElectronUpdater | null> {
  if (instance) return instance;
  if (instancePromise) return instancePromise;
  instancePromise = import("electron-updater")
    .then((mod) => {
      const fallback = (mod as { default?: { autoUpdater?: ElectronUpdater } }).default;
      const autoUpdater = mod.autoUpdater ?? fallback?.autoUpdater;
      if (!autoUpdater) return null;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      wireEvents(autoUpdater, deps);
      instance = autoUpdater;
      return autoUpdater;
    })
    .catch((error) => {
      console.warn(`[raft-desktop] updater unavailable: ${String(error)}`);
      return null;
    });
  return instancePromise;
}

function wireEvents(autoUpdater: ElectronUpdater, deps: UpdaterDeps): void {
  autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setStatus({ state: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => setStatus({ state: "none" }));
  autoUpdater.on("download-progress", (progress) => {
    const now = Date.now();
    const pct = Math.round(progress.percent);
    // Throttle: emit only every 500ms or on a ≥1% step (and always 100%).
    if (
      pct !== 100 &&
      now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS &&
      Math.abs(pct - lastProgressPct) < PROGRESS_MIN_DELTA
    ) {
      return;
    }
    lastProgressAt = now;
    lastProgressPct = pct;
    setStatus({ state: "downloading", percent: pct });
  });
  autoUpdater.on("update-downloaded", (info) => {
    // Best practice (VSCode/Slack/Cumora): do NOT interrupt with a modal. Just
    // broadcast "ready"; the app surfaces a subtle, dismissible "Restart to
    // update" affordance, and `autoInstallOnAppQuit` applies it on the next
    // natural quit regardless. The user restarts when convenient.
    setStatus({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (error) => {
    const message = String(error?.message ?? error);
    // A corrupted cache rejects every future download; wipe it and retry once.
    if (!selfHealed && /sha512|checksum|integrity/i.test(message)) {
      selfHealed = true;
      try {
        rmSync(path.join(app.getPath("userData"), "pending"), { recursive: true, force: true });
      } catch {
        // best effort
      }
      void autoUpdater.checkForUpdates().catch(() => {});
      return;
    }
    setStatus({ state: "error", message });
  });
}

export function initializeAutoUpdater(deps: UpdaterDeps): void {
  if (started) return;
  started = true;
  if (!hasUpdateConfig()) {
    setStatus({ state: "unsupported" });
    return;
  }
  // Defer the SDK import as well as the network check: loading the updater
  // immediately competes with the first window's startup. Manual checks still
  // call loadInstance directly and do not wait for this timer.
  const check = () => {
    void loadInstance(deps).then((autoUpdater) => {
      void autoUpdater?.checkForUpdates().catch(() => {});
    });
  };
  setTimeout(check, CHECK_DELAY_MS).unref();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

/**
 * User-initiated "Check for Updates…". Shows a native dialog for the terminal
 * outcomes so the menu item always gives feedback; automatic checks stay silent.
 */
export async function checkForUpdatesManually(deps: UpdaterDeps): Promise<void> {
  if (!hasUpdateConfig()) {
    dialog.showMessageBox({
      type: "info",
      message: "Updates are not available in this build",
      detail: "This build has no update feed configured.",
    });
    return;
  }
  if (manualInFlight) return;
  manualInFlight = true;
  try {
    const autoUpdater = await loadInstance(deps);
    if (!autoUpdater) return;
    const result = await autoUpdater.checkForUpdates();
    // If nothing newer, tell the user; download/downloaded paths surface their
    // own dialogs via the wired events.
    if (!result || currentStatus.state === "none") {
      dialog.showMessageBox({
        type: "info",
        message: "You're up to date",
        detail: `Raft Desktop ${app.getVersion()} is the latest version.`,
      });
    }
  } catch (error) {
    dialog.showMessageBox({
      type: "warning",
      message: "Couldn't check for updates",
      detail: String(error),
    });
  } finally {
    manualInFlight = false;
  }
}

/**
 * Apply a downloaded update now by restarting — invoked by the in-app
 * "Restart to update" affordance. No-op unless an update is fully downloaded.
 */
export function applyDownloadedUpdate(deps: UpdaterDeps): boolean {
  if (currentStatus.state !== "downloaded" || !instance) return false;
  // macOS quitAndInstall goes through Browser::Shutdown() and skips before-quit,
  // so flip the lifecycle's quitting flag first (same as the auto path).
  deps.markQuitting();
  instance.quitAndInstall(false, true);
  return true;
}

/**
 * Silent background check for the app's own "Check for updates" UI: the outcome
 * flows through the status stream (no native dialogs, unlike the menu item).
 */
export async function triggerBackgroundCheck(deps: UpdaterDeps): Promise<void> {
  if (!hasUpdateConfig()) return;
  const autoUpdater = await loadInstance(deps);
  await autoUpdater?.checkForUpdates().catch(() => {});
}

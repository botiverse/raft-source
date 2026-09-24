// ComputerHost — the ONLY place in the desktop main process that touches
// `@botiverse/raft-computer/lib` (aside from the `__service`/`__run` argv guard
// in index.ts). It makes this app the OS-supervised host of the local Computer
// service without becoming the runtime owner: the heavy `__service`/`__run`
// daemon tree is detached and login-item supervised, so quitting the app never
// stops running agents. This module only *controls* it (converge lifecycle,
// attach, start/stop) and *observes* it (status polling), exactly the surface
// the CLI drives.
//
// Identity unification (the elegant core): the standalone Computer flow needs a
// separate device-code login because it has no session of its own. This app is
// already authenticated for chat, so we bridge the renderer's existing chat
// tokens into the lib's shared `user-session.json` (the exact on-disk shape
// `services/login.ts` writes). Then `api.attach(...)` — whose auth path reads
// that session via `ensureUsableUserSession` — just works, with no second login.

import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { app } from "electron";
import {
  connectService,
  convergeAppHostLifecycle,
  createComputerApi,
  DEFAULT_UPGRADE_BASE_URL,
  fetchCdnLatestVersion,
  resolveRaftHome,
  userSessionPath,
  type AttachResult,
  type ComputerApi,
  type ComputerStatusReport,
} from "@botiverse/raft-computer/lib";
import { createUpgradeInfoReader } from "../main/upgradeInfo.js";
import { isValidEnableInput, type EnableComputerInput } from "./enableInput.js";

// Mirrors `paths.ts` CURRENT_SCHEMA_VERSION (readers tolerate a missing value,
// but we stamp it like login.ts does).
const USER_SESSION_SCHEMA_VERSION = 1;

// A fresh install downloads + verifies + swaps a binary and restarts the
// resident; give it a generous ceiling but never hang forever.
const FRESH_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Is `exe` this app's own executable (i.e. an app-embedded Computer)? The
 * embedded service re-execs `process.execPath`; a standalone lives elsewhere
 * (~/.local/bin/raft-computer or a K slot). Matches the exact path or the same
 * `.app` bundle so the packaged app's helper paths still count as embedded.
 */
function isAppBundledExecutable(exe: string): boolean {
  const appExe = process.execPath;
  if (exe === appExe) return true;
  const marker = ".app/Contents/";
  const idx = appExe.indexOf(marker);
  if (idx < 0) return false; // non-.app layout (dev linux): only exact match is embedded
  return exe.startsWith(appExe.slice(0, idx + 4)); // shared ".app" bundle root
}

// A secret-free host state snapshot for the renderer. Never carries apiKeys.
export interface ComputerHostSnapshot {
  hostCapable: true;
  status: ComputerStatusReport | null;
}

class ComputerHost {
  private readonly slockHome = resolveRaftHome();
  private readonly api: ComputerApi = createComputerApi(this.slockHome, { hostLifecycleOwner: "app" });
  private readonly readUpgradeInfo = createUpgradeInfoReader(
    () => fetchCdnLatestVersion(DEFAULT_UPGRADE_BASE_URL),
  );
  private lastStatus: ComputerStatusReport | null = null;

  /**
   * Converge the app-owned host lifecycle (this app becomes the login item that
   * owns "launch at login"; any CLI-owned launchd carrier is removed), then, if
   * launch-at-login is on and there is already an attachment, boot the detached
   * service. Called once at app-ready. Failures are returned, not thrown, so a
   * lifecycle hiccup never blocks the chat app from starting.
   */
  async converge(): Promise<{ ok: boolean; error?: string }> {
    try {
      const lifecycle = await convergeAppHostLifecycle(
        this.slockHome,
        app.getLoginItemSettings().openAtLogin,
        {
          // The stable app-bundle executable is the dispatcher: the `__service`/
          // `__run` re-exec relaunches this binary and the argv guard routes it.
          dispatcherPath: process.execPath,
          setOpenAtLogin: (enabled: boolean) => app.setLoginItemSettings({ openAtLogin: enabled }),
          getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
        },
      );
      if (lifecycle.enabled) {
        const status = await this.api.getStatus();
        this.lastStatus = status;
        if (status.servers.length > 0) {
          await this.api.start({ serverId: null, serverLabel: null });
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  async getStatus(): Promise<ComputerStatusReport> {
    const status = await this.api.getStatus();
    this.lastStatus = status;
    return status;
  }

  /**
   * One-click "make this computer available for <server>" using the caller's
   * existing chat session — no device-code login. Writes the shared user session
   * from the passed tokens, attaches, then starts the service for the new server.
   */
  async enable(input: EnableComputerInput): Promise<AttachResult> {
    // Validate BEFORE touching the shared session on disk — never overwrite a
    // working session with an empty/garbage one from a malformed call.
    if (!isValidEnableInput(input)) throw new Error("enable_missing_fields");
    await this.writeUserSession(input);
    const attached = await this.api.attach({
      serverSlug: input.serverSlug,
      serverUrl: input.serverUrl,
      ...(input.name ? { name: input.name } : {}),
    });
    // Boot (or converge) the detached service so the just-attached server gets a
    // running daemon child.
    await this.api.start({ serverId: attached.serverId, serverLabel: input.serverSlug });
    return attached;
  }

  async start(): Promise<void> {
    await this.api.start({ serverId: null, serverLabel: null });
  }

  async stop(): Promise<void> {
    await this.api.stop();
  }

  /** Bring a degraded service back (the reference app's "restart"). */
  async restart(): Promise<void> {
    await this.api.resetService();
  }

  /** The latest Computer version on the CDN (null if unreachable). The renderer
   *  compares it to the running service version to decide whether to offer an
   *  update — a local check, no server rollout dependency. */
  async getUpgradeInfo(): Promise<{ latestVersion: string | null }> {
    return this.readUpgradeInfo();
  }

  /**
   * Upgrade THIS machine's local service to the CDN's latest version — a local
   * action (same plane as start/stop/restart), routed to the running service
   * over local IPC. The service performs the download/verify/apply/restart and
   * reports progress through getStatus().upgrade (polled + pushed to the card).
   */
  async upgrade(): Promise<void> {
    const latest = await fetchCdnLatestVersion(DEFAULT_UPGRADE_BASE_URL);
    if (!latest) throw new Error("no_update_available");
    const result = await this.api.tryUpgradeViaService(latest, undefined, { trigger: "tray" });
    if (!result.routed) {
      throw new Error(result.reason === "no-service" ? "service_not_running" : "service_unreachable");
    }
  }

  /**
   * How the local Computer is managed, so the renderer can route [Update]:
   *  - "app": the live service binary IS this app's executable (the __service
   *    argv guard re-execs process.execPath) → it upgrades WITH the app.
   *  - "standalone": an external raft-computer (a PATH install or a K slot) the
   *    app only controls → remote self-upgrade or fresh-install.
   *  - "unknown": the service didn't attest a path (not reachable / older).
   * Authoritative signal: the live service self-reports its executable path via
   * the machine-attestation IPC (never release metadata).
   */
  async getManagement(): Promise<{ model: "app" | "standalone" | "unknown" }> {
    try {
      const client = await connectService(this.slockHome);
      try {
        const attestation = await client.request("machine-attestation", undefined);
        const exe = typeof attestation.serviceExecutablePath === "string" ? attestation.serviceExecutablePath : "";
        if (!exe) return { model: "unknown" };
        return { model: isAppBundledExecutable(exe) ? "app" : "standalone" };
      } finally {
        await client.close();
      }
    } catch {
      return { model: "unknown" };
    }
  }

  /**
   * Fresh-install a specific published version via the OFFICIAL installer, then
   * let the installer restart the resident onto it. This is the desktop-executed
   * fallback for a STANDALONE computer whose source can't remote self-upgrade —
   * exactly what the web can only show as a copy-paste shell command, run by the
   * app instead. Mirrors the web command (no install-dir override → the standard
   * ~/.local/bin, where the CLI installer puts the binary).
   *
   * MUST NOT be called for an app-embedded computer (the router guards on the
   * management model): the installer provisions a STANDALONE binary and would
   * fork a second, competing owner. We also deliberately do NOT call
   * api.resetService() afterward — that would re-exec the APP binary and undo the
   * standalone install; install.sh restarts the resident onto the new bytes.
   */
  async upgradeViaFreshInstall(version: string): Promise<void> {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error("bad_version");
    // Defense in depth at the execution boundary (the renderer router already
    // guards): the installer provisions a STANDALONE binary, so refuse unless we
    // can CONFIRM this computer is standalone. "app" would fork a competing
    // owner; "unknown" (service unreachable) is not a confirmation.
    const { model } = await this.getManagement();
    if (model !== "standalone") throw new Error("not_standalone_computer");
    const command = `curl -fsSL ${DEFAULT_UPGRADE_BASE_URL}/install.sh | RAFT_COMPUTER_VERSION=${version} sh`;
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/sh", ["-c", command], { timeout: FRESH_INSTALL_TIMEOUT_MS }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`fresh_install_failed: ${String(stderr || error.message).slice(0, 400)}`));
        else resolve();
      });
    });
  }

  // Write the lib's shared `user-session.json` from the renderer's chat tokens,
  // in the exact shape `services/login.ts` writes (kind/schemaVersion/tokens/
  // serverUrl + identity), mode 0600. This is what makes `api.attach`
  // authenticate as the already-signed-in human without a second login.
  //
  // ATOMIC (temp file + rename), matching lib/userSession.ts, because the live
  // detached service reads/refreshes this same file concurrently — a bare
  // writeFile could expose a truncated file mid-write and log the service out.
  private async writeUserSession(input: EnableComputerInput): Promise<void> {
    const file = userSessionPath(this.slockHome);
    await mkdir(dirname(file), { recursive: true });
    const body = JSON.stringify(
      {
        kind: "user-session",
        schemaVersion: USER_SESSION_SCHEMA_VERSION,
        // Identity so ComputerStatusReport.userId/userName/userEmail resolve
        // (a device-code login persists these too).
        ...(input.userId ? { userId: input.userId } : {}),
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        serverUrl: input.serverUrl,
        ...(input.userEmail ? { email: input.userEmail } : {}),
        ...(input.userName ? { name: input.userName } : {}),
        ...(input.userDisplayName ? { displayName: input.userDisplayName } : {}),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    );
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { ComputerHost };

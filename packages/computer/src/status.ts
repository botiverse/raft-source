// `raft-computer status` — Computer-level aggregate view (RFC v0.8
// contract v4 §1/§6/§9). One Computer = one SLOCK_HOME = N server
// attachments + their per-server daemons + one service. `status`
// lists all of them in a single table.
//
// READ-ONLY and SECRET-FREE (§3.3.1, our axis-locked redline): the
// report carries server attachment IDENTITY and pid/liveness derived
// from filesystem state, but NEVER the user access token or any
// sk_computer_* key — none of those values ever enter the report object.
import { readFile, access } from "node:fs/promises";
import {
  resolveRaftHome,
  userSessionPath,
  serviceLogPath,
  serviceVersionPath,
  serverRunnerLogPath,
  serverRunnerVersionPath,
  serverRunnerPidReadFallback,
  serverRunnerLogReadFallback,
  serverConnectedMarkerPath,
} from "./paths.js";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState.js";
import { canonicalizeServerUrl } from "./serverUrl.js";
import { readPidfileAt, isProcessAlive } from "./internal/process-primitives.js";
import { findLiveServicePidReadOnly } from "./internal/service-pid-fallback.js";
import { isDegraded, readTerminalUnlinked } from "./health.js";
import { info } from "./output.js";
import { COMPUTER_VERSION } from "./version.js";
import { readProcessVersionEvidence } from "./versionEvidence.js";
import {
  loadOperation,
  type OperationOutcome,
  type OperationPhase,
} from "@botiverse/k-carrier";
import { kStateDir } from "./kPaths.js";
import {
  readHostLifecycleRecoveryStatus,
  type HostLifecycleRecoveryStatus,
} from "./macosLoginCarrier.js";

type UserSessionReadResult =
  | { state: "missing"; session: null; error: null }
  | { state: "invalid"; session: null; error: string }
  | { state: "present"; session: Record<string, unknown>; error: null };

async function readUserSession(path: string): Promise<UserSessionReadResult> {
  try {
    // migrate-on-read: the parsed session is kept as an opaque object and is
    // never rejected for a missing `schemaVersion` (existing deployed files
    // have none → treated as version 1 / current). When CURRENT_SCHEMA_VERSION
    // is bumped (>1), migrate here when session.schemaVersion < it.
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { state: "present", session: parsed as Record<string, unknown>, error: null };
    }
    return { state: "invalid", session: null, error: "not a JSON object" };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { state: "missing", session: null, error: null };
    }
    return {
      state: "invalid",
      session: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function canonicalServerUrlOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? canonicalizeServerUrl(v) : null;
}

export type DaemonState = { running: true; pid: number } | { running: false };
export type ServerHealth = "ok" | "degraded" | "offline" | "unlinked";

export interface ProcessVersionStatus {
  version: string | null;
  evidencePath: string;
  evidencePid: number | null;
  evidenceWrittenAt: string | null;
  /** Supervised-boot shell env import outcome ("inherited" | "unavailable:<code>"). */
  shellEnvironment: string | null;
}

export interface ComputerUpgradeStatus {
  requestId: string;
  fromVersion: string;
  targetVersion: string;
  /** Exact K phase; terminal phases are never rewritten as in-flight aliases. */
  phase: OperationPhase;
  /** Exact terminal result, or null while the operation is active. */
  outcome: OperationOutcome | null;
  startedAt: string;
  updatedAt: string;
  source: "k";
  /** Versioned origin scope. Unmarked historical receipts remain explicit. */
  scope: "local" | "remote" | "legacy";
  message: string | null;
  percent: number | null;
}

async function pidStatus(pidfile: string): Promise<DaemonState> {
  const pid = await readPidfileAt(pidfile);
  return pid !== null && isProcessAlive(pid) ? { running: true, pid } : { running: false };
}

async function runnerPidStatus(slockHome: string, serverId: string): Promise<DaemonState> {
  for (const pidfile of serverRunnerPidReadFallback(slockHome, serverId)) {
    const state = await pidStatus(pidfile);
    if (state.running) return state;
  }
  return { running: false };
}

async function visibleRunnerLogPath(slockHome: string, serverId: string): Promise<string> {
  for (const file of serverRunnerLogReadFallback(slockHome, serverId)) {
    if (await access(file).then(() => true, () => false)) return file;
  }
  return serverRunnerLogPath(slockHome, serverId);
}

/**
 * Read-only Computer service liveness across the on-disk layout
 * migration window. Walks the pidfile fallback chain by liveness so a
 * legacy service (still running under `<installRoot>/service.pid` or
 * `supervisor.pid` after the user upgraded the CLI binary) is correctly
 * surfaced as running — never clearing or otherwise mutating the chain
 * (§3.3.1 read-only + secret-free invariant).
 */
async function serviceState(slockHome: string): Promise<DaemonState> {
  const { pid } = await findLiveServicePidReadOnly(slockHome);
  return pid !== null ? { running: true, pid } : { running: false };
}

async function processVersionStatus(
  path: string,
  daemon: DaemonState,
): Promise<ProcessVersionStatus> {
  const evidence = await readProcessVersionEvidence(path);
  const liveEvidence =
    daemon.running && evidence?.pid === daemon.pid ? evidence : null;
  return {
    version: liveEvidence?.version ?? null,
    evidencePath: path,
    evidencePid: liveEvidence?.pid ?? null,
    evidenceWrittenAt: liveEvidence?.writtenAt ?? null,
    shellEnvironment: liveEvidence?.shellEnvironment ?? null,
  };
}

async function upgradeStatus(slockHome: string): Promise<ComputerUpgradeStatus | null> {
  const kOperation = await loadOperation(kStateDir(slockHome));
  if (
    kOperation.kind === "observed"
    && (kOperation.operation.outcome === null || kOperation.operation.acknowledgedAtMs === null)
  ) {
    return {
      requestId: kOperation.operation.id,
      fromVersion: kOperation.operation.fromVersion,
      targetVersion: kOperation.operation.targetVersion,
      phase: kOperation.operation.phase,
      outcome: kOperation.operation.outcome,
      startedAt: new Date(kOperation.operation.startedAtMs).toISOString(),
      updatedAt: new Date(kOperation.operation.updatedAtMs).toISOString(),
      source: "k",
      scope: kOperation.operation.metadata.upgradeScopeVersion === "1"
        && (kOperation.operation.metadata.upgradeScope === "local"
          || kOperation.operation.metadata.upgradeScope === "remote")
        ? kOperation.operation.metadata.upgradeScope
        : "legacy",
      message: kOperation.operation.reason,
      percent: null,
    };
  }
  return null;
}

/**
 * Derive `health` enum from daemon liveness + recent crash history.
 * Per v6 §11:
 *  - `unlinked` = server rejected this saved runner.state.json with
 *                 computer_machine_unlinked; setup must recreate/link it.
 *  - `degraded` = repeated-crash threshold tripped (service stopped
 *                 auto-restart; daemon may have been killed by the
 *                 supervisor and is therefore NOT live, or it may still be
 *                 running and about to be killed). Either way, this is the
 *                 user-visible "needs attention, click to recover" state.
 *  - `offline`  = daemon not running and crash budget NOT tripped (either
 *                 service not managing this attachment, or stopped cleanly)
 *  - `ok`       = daemon running and no degraded marker
 *
 * **Order matters.** `degraded` is checked before liveness because a
 * crash-budget-tripped runner has no live pid (the supervisor parks it
 * after the threshold). If we judged liveness first, every degraded runner
 * would surface as `offline` — which masks the recovery action behind a
 * label that looks terminal, and (more importantly) lets the menubar tray
 * icon paint a "fix-this" runner as a "missing" runner. The user-visible
 * reading is "degraded, recoverable", not "gone".
 */
async function deriveHealth(
  slockHome: string,
  serverId: string,
  serverMachineId: string,
  daemon: DaemonState,
): Promise<ServerHealth> {
  if (await readTerminalUnlinked(slockHome, serverId, serverMachineId)) return "unlinked";
  if (await isDegraded(slockHome, serverId)) return "degraded";
  if (!daemon.running) return "offline";
  return "ok";
}

export interface ServerStatusRow {
  serverId: string;
  serverSlug: string | null;
  serverMachineId: string;
  /** Linked `machines.id` on the server (= `computers.machineId`). The
   *  dashboard route `/s/<slug>/computer/:machineId` resolves against
   *  this — the menu-bar's "Open This Computer in Browser" link uses it.
   *  null when speaking to a pre-#99 server or reading a pre-#99
   *  attachment file; consumers MUST handle that case
   *  (#wg-raft-computer:f2a02081 bug 2). */
  machineId: string | null;
  serverUrl: string;
  attachedAt: string | null;
  serverRunnerLogPath: string;
  runnerVersion: ProcessVersionStatus;
  daemon: DaemonState;
  /** v6 §11 health enum surfaced in `status` table (PR-H §3.3). */
  health: ServerHealth;
  /** Runner's live WebSocket is connected to the server. Sourced from a
   *  local marker file written by the runner's onConnect/onDisconnect
   *  callbacks — not a server-side query. Required for Desktop v1:
   *  `Online` = health ok + serverConnected true. */
  serverConnected: boolean;
}

export interface ComputerStatusReport {
  slockHome: string;
  loggedIn: boolean;
  userId: string | null;
  /** The signed-in user's display identity, surfaced from the session so
   *  surfaces show a real name instead of a raw UUID (task #112). Stored at
   *  login via `GET /api/auth/me`; null on older sessions or when /me was
   *  unreachable — presenters fall back to `userId`. */
  userName: string | null;
  userDisplayName: string | null;
  userEmail: string | null;
  loginServerUrl: string | null;
  userSessionError: string | null;
  // Global per-Computer service (one per SLOCK_HOME).
  cliVersion: string;
  service: DaemonState & { logPath: string; version: ProcessVersionStatus };
  upgrade: ComputerUpgradeStatus | null;
  hostLifecycle: HostLifecycleRecoveryStatus | null;
  // One row per attached server (v4 §6 aggregate). Empty array when the
  // Computer has no attachments yet.
  servers: ServerStatusRow[];
}

/**
 * Build the Computer-level aggregate status report from an explicit
 * install root. Lib-pure: no env reads, no process.exit, no info()/fail().
 * The CLI wrappers (`runStatus`, `runDoctor`) and the IPC `service-status`
 * handler (PR-impl-2, D-stage) both pass an `installRoot` resolved by
 * their respective entry points.
 */
export async function buildStatusReport(installRoot: string): Promise<ComputerStatusReport> {
  const sessionRead = await readUserSession(userSessionPath(installRoot));
  const session = sessionRead.session;
  const attachments = await listServerAttachments(installRoot);
  const service = {
    ...(await serviceState(installRoot)),
    logPath: serviceLogPath(installRoot),
  };
  const serviceWithVersion = {
    ...service,
    version: await processVersionStatus(serviceVersionPath(installRoot), service),
  };

  const servers: ServerStatusRow[] = [];
  for (const a of attachments) {
    const daemon = await runnerPidStatus(installRoot, a.serverId);
    const markerExists = await access(serverConnectedMarkerPath(installRoot, a.serverId)).then(() => true, () => false);
    const serverConnected = markerExists && daemon.running;
    servers.push({
      serverId: a.serverId,
      serverSlug: a.serverSlug ?? null,
      serverMachineId: a.serverMachineId,
      machineId: a.machineId ?? null,
      serverUrl: a.serverUrl,
      attachedAt: a.attachedAt ?? null,
      serverRunnerLogPath: await visibleRunnerLogPath(installRoot, a.serverId),
      runnerVersion: await processVersionStatus(
        serverRunnerVersionPath(installRoot, a.serverId),
        daemon,
      ),
      daemon,
      health: await deriveHealth(installRoot, a.serverId, a.serverMachineId, daemon),
      serverConnected,
    });
  }

  const loggedIn =
    session?.kind === "user-session" && typeof session.accessToken === "string" && session.accessToken.length > 0;

  return {
    slockHome: installRoot,
    loggedIn,
    userId: session ? str(session.userId) : null,
    userName: session ? str(session.name) : null,
    userDisplayName: session ? str(session.displayName) : null,
    userEmail: session ? str(session.email) : null,
    loginServerUrl: session ? canonicalServerUrlOrNull(session.serverUrl) : null,
    userSessionError: sessionRead.state === "invalid" ? sessionRead.error : null,
    cliVersion: COMPUTER_VERSION,
    service: serviceWithVersion,
    upgrade: await upgradeStatus(installRoot),
    hostLifecycle: await readHostLifecycleRecoveryStatus(installRoot),
    servers,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function formatVersionStatus(version: ProcessVersionStatus): string {
  return version.version ?? "unknown (no live version evidence)";
}

/**
 * Human formatter for a `ComputerStatusReport`. CLI-layer presentation only —
 * separated from `buildStatusReport` (the pure logic) so the CLI action can do
 * `api.getStatus()` then `formatStatusReport(report)`. Writes to stdout via
 * `info()`; never reads env or mutates state.
 */
export function formatStatusReport(report: ComputerStatusReport): void {
  info("");
  info(`SLOCK_HOME:   ${report.slockHome}`);
  const loginDetail = report.userSessionError
    ? "no — user session file is invalid; re-run `raft-computer login`"
    : report.loggedIn
      ? `yes (user ${report.userId ?? "?"})`
      : "no — run `raft-computer login`";
  info(
    `Logged in:    ${loginDetail}`,
  );
  if (report.loginServerUrl) info(`Login server: ${report.loginServerUrl}`);
  info(`CLI version:  ${report.cliVersion}`);
  info(
    `Service:   ${report.service.running ? `running (pid ${report.service.pid})` : "stopped — run `raft-computer start`"}`,
  );
  info(`Service version: ${formatVersionStatus(report.service.version)}`);
  if (report.service.version.shellEnvironment?.startsWith("unavailable:")) {
    const code = report.service.version.shellEnvironment.slice("unavailable:".length);
    info(
      `  Warning: terminal shell environment import failed (${code}). The service is using the baseline environment; tools available only in your terminal (custom PATH, exported variables) are invisible to agents until your shell init is fixed and the Computer service restarts.`,
    );
  }
  if (
    report.service.running &&
    report.service.version.version &&
    report.service.version.version !== report.cliVersion
  ) {
    info(
      `  Warning: running service version ${report.service.version.version} differs from this app/CLI version ${report.cliVersion}. Restart the Computer service from the current app/CLI.`,
    );
  }
  info(`Service log: ${report.service.logPath}`);
  if (report.upgrade) {
    const percent = report.upgrade.percent === null ? "" : ` (${report.upgrade.percent}%)`;
    info(
      report.upgrade.outcome === null
        ? `Upgrade: K operation in flight (id ${report.upgrade.requestId})`
        : `Upgrade: K terminal receipt, unacknowledged (id ${report.upgrade.requestId})`,
    );
    info(`  Target: ${report.upgrade.fromVersion} -> ${report.upgrade.targetVersion}`);
    info(`  Phase:  ${report.upgrade.phase}${percent}`);
    if (report.upgrade.outcome !== null) {
      info(`  Outcome: ${report.upgrade.outcome}`);
      info(
        `  Acknowledge: raft-computer operation acknowledge ${report.upgrade.requestId}`,
      );
    }
    if (report.upgrade.message) info(`  Detail: ${report.upgrade.message}`);
    info(`  Updated: ${report.upgrade.updatedAt}`);
  } else {
    info("Upgrade: none in flight");
  }
  if (report.hostLifecycle) {
    info(
      `Host lifecycle: ${report.hostLifecycle.status} (${report.hostLifecycle.errorCode ?? "replacement interrupted"})`,
    );
    info("  Run `raft-computer doctor` before retrying start or upgrade.");
  } else {
    info("Host lifecycle: healthy");
  }
  info("");
  if (report.servers.length === 0) {
    info("Attachments:  none — run `raft-computer attach /<serverSlug>` (e.g. `/myserver`).");
  } else {
    info("Attachments:");
    info(`  ${pad("SERVER", 24)}${pad("HEALTH", 12)}${pad("CONNECTED", 12)}${pad("DAEMON", 24)}${pad("MACHINE", 38)}URL`);
    for (const s of report.servers) {
      const dcol = s.daemon.running ? `running (pid ${s.daemon.pid})` : "stopped";
      info(
        `  ${pad(formatServerSlugDisplay(s.serverSlug), 24)}${pad(s.health, 12)}${pad(s.serverConnected ? "yes" : "no", 12)}${pad(dcol, 24)}${pad(s.serverMachineId, 38)}${s.serverUrl}`,
      );
      info(`    Runner version: ${formatVersionStatus(s.runnerVersion)}`);
      info(`    Server runner log: ${s.serverRunnerLogPath}`);
    }
    if (report.servers.some((s) => s.health === "degraded")) {
      info("");
      info(
        "  Note: one or more servers are `degraded` (repeated crashes; auto-restart paused).",
      );
      info(
        "  After fixing the underlying issue, run `raft-computer restart /<serverSlug>` (e.g. `/myserver`) to try again.",
      );
    }
    if (report.servers.some((s) => s.health === "unlinked")) {
      info("");
      info(
        "  Note: one or more servers are `unlinked` (server deleted/unlinked this Computer or machine).",
      );
      info(
        "  Run `raft-computer setup /<serverSlug>` to recover/rebind, then verify with `raft-computer status /<serverSlug>`.",
      );
    }
  }
  info("");
}

/**
 * CLI wrapper kept as a thin presenter: build the report (pure) + format it.
 * The logic home is `createComputerApi(...).getStatus()` (which delegates to
 * `buildStatusReport`); this wrapper exists for callers/tests that drive the
 * end-to-end stdout path directly.
 */
export async function runStatus(): Promise<void> {
  formatStatusReport(await buildStatusReport(resolveRaftHome()));
}

import { readRuntimeCliNotices } from "./runtimeCliNotices";
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
import { startedAfterRecord } from "@botiverse/raft-shared";
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
} from "./paths";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState";
import { canonicalizeServerUrl } from "./serverUrl";
import { readPidfileAt, isProcessAlive, readProcessStartTimeMs } from "./internal/process-primitives";
import { findLiveServicePidReadOnly, type ServicePidIdentityDeps } from "./internal/service-pid-fallback";
import { isDegraded, readTerminalUnlinked } from "./health";
import { info } from "./output";
import { COMPUTER_VERSION } from "./version";
import { SHELL_ENV_CAPTURE_TIMEOUT_MS } from "./shellEnvCapture";
import { readProcessVersionEvidence } from "./versionEvidence";
import { deferredLockOwner, type DeferredOwnerIdentity } from "./runnerLockConflict";
import { formatProcJobsStatus, listRunningProcJobs, type ProcJobsDeps } from "./procJobs";

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


async function pidStatus(pidfile: string): Promise<DaemonState> {
  const pid = await readPidfileAt(pidfile);
  return pid !== null && isProcessAlive(pid) ? { running: true, pid } : { running: false };
}

/**
 * How a live recorded pid is told from the process that wrote it; tests
 * replace these instead of using real processes. A start is read (once per
 * pid per report):
 *  - for the service pid, when service-version.json names it and nothing
 *    answers on the service's IPC endpoint (`endpointAnswers`);
 *  - for a runner pid with version evidence of its own, while the service is
 *    stopped;
 *  - for a lock owner the service deferred to, when runner-version.json names
 *    its pid: every report, also under a running service (the deferral is
 *    rare, and nothing about that owner is cached).
 * A healthy running service and its own runners cost no read. On Linux no
 * start is read at all, and every case is shown as before starts were read.
 */
export type StatusReportDeps = ServicePidIdentityDeps;

/** What a server's files say about its runner process. */
interface RunnerProcess {
  daemon: DaemonState;
  connected: boolean;
  lockHeldByPid?: number;
  deferredOwner?: DeferredOwnerIdentity;
}

/**
 * A live pid in runner.pid is not yet this server's runner. Two things put
 * another process there:
 *
 *  - A runner that died without its service (sign-out, a kill) leaves its
 *    pidfile behind, and Windows hands the pid to an unrelated program. The
 *    runner wrote its version evidence after it started, so a process that
 *    started later than that reused the pid (the machine lock's start-time
 *    rule). A start that cannot be read is not reuse.
 *  - The service, deferring to whoever holds the daemon machine lock, writes
 *    that holder's pid (runnerLockConflict.ts). It started no runner, and a
 *    live pid in a lock says nothing about what the process is. Who it is
 *    comes from `deferredLockOwner`, the one answer status, doctor, stop and
 *    detach share. "own-runner" is shown as the runner, connected or not by
 *    its own marker, and so is "unread" (its start could not be read: shown
 *    as before starts were read). "another-program" and "unknown" are the
 *    lock's holder, nothing more.
 *
 * A live pid with neither record stays running, as before. When a start is
 * read: StatusReportDeps.
 */
async function runnerProcess(
  slockHome: string,
  serverId: string,
  serviceRunning: boolean,
  processStartTimeMs: NonNullable<StatusReportDeps["processStartTimeMs"]>,
): Promise<RunnerProcess> {
  const evidence = await readProcessVersionEvidence(serverRunnerVersionPath(slockHome, serverId));
  const lockOwner = await deferredLockOwner(slockHome, serverId, { processStartTimeMs });
  let lockHeldByPid: number | undefined;
  let deferredOwner: DeferredOwnerIdentity | undefined;
  for (const pidfile of serverRunnerPidReadFallback(slockHome, serverId)) {
    const state = await pidStatus(pidfile);
    if (!state.running) continue;
    if (lockOwner?.pid === state.pid) {
      switch (lockOwner.identity) {
        case "own-runner":
        case "unread":
          return { daemon: state, connected: lockOwner.connected, deferredOwner: lockOwner.identity };
        case "another-program":
        case "unknown":
          // Still the holder with the service stopped: its pid stays in runner.pid until a later start.
          lockHeldByPid = state.pid;
          deferredOwner = lockOwner.identity;
          continue;
      }
    }
    let isRunner = true;
    if (evidence?.pid === state.pid) {
      const recordedAtMs = Date.parse(evidence.writtenAt);
      // Not for a running service's own runner. Reading a start is a
      // PowerShell start per server on Windows, and Raft Desktop asks for
      // status every 5 s. Under a running service runner.pid is that
      // service's own: `start` forgets what an earlier service left before it
      // spawns one, and the service clears it when its runner exits.
      const readStart = !serviceRunning && Number.isFinite(recordedAtMs);
      isRunner = !(readStart && startedAfterRecord(recordedAtMs, await processStartTimeMs(state.pid)));
    }
    if (isRunner) {
      return {
        daemon: state,
        connected: await access(serverConnectedMarkerPath(slockHome, serverId)).then(() => true, () => false),
      };
    }
  }
  return {
    daemon: { running: false },
    connected: false,
    ...(lockHeldByPid !== undefined ? { lockHeldByPid } : {}),
    ...(deferredOwner !== undefined ? { deferredOwner } : {}),
  };
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
async function serviceState(slockHome: string, identity: ServicePidIdentityDeps): Promise<DaemonState> {
  // A live pid that is another program's (after a sign-out or reboot:
  // service-pid-fallback.ts) is not found: the service is stopped, and the
  // runner pids it left behind are checked the same way.
  const { pid } = await findLiveServicePidReadOnly(slockHome, identity);
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
  /**
   * Set when runner.pid names the process the service deferred to because it
   * holds this machine's daemon lock, and that process has not shown itself
   * to be this server's runner (`daemon.running` is false). It may be another
   * Raft daemon or, its pid reused, an unrelated program.
   */
  lockHeldByPid?: number;
  /**
   * Set when the pid in this row (`daemon.pid`, or `lockHeldByPid`) is the
   * daemon lock's owner the service deferred to, not a runner it started:
   * who that owner is (runnerLockConflict.ts). The service never stops,
   * restarts or signals such a process.
   */
  deferredOwner?: DeferredOwnerIdentity;
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
  // One row per attached server (v4 §6 aggregate). Empty array when the
  // Computer has no attachments yet.
  servers: ServerStatusRow[];
  /** Runtimes whose detected CLI version went down since an earlier start, with the fix. */
  runtimeCliNotices?: string[];
}

/**
 * Build the Computer-level aggregate status report from an explicit
 * install root. Lib-pure: no env reads, no process.exit, no info()/fail().
 * The CLI wrappers (`runStatus`, `runDoctor`) and the IPC `service-status`
 * handler (PR-impl-2, D-stage) both pass an `installRoot` resolved by
 * their respective entry points.
 */
export async function buildStatusReport(installRoot: string, deps: StatusReportDeps = {}): Promise<ComputerStatusReport> {
  const sessionRead = await readUserSession(userSessionPath(installRoot));
  const session = sessionRead.session;
  const attachments = await listServerAttachments(installRoot);
  // One start read per pid within a report: it spawns a command on Windows and macOS.
  const starts = new Map<number, Promise<number | undefined>>();
  const processStartTimeMs = (pid: number): Promise<number | undefined> => {
    let start = starts.get(pid);
    if (!start) starts.set(pid, (start = (deps.processStartTimeMs ?? readProcessStartTimeMs)(pid)));
    return start;
  };
  const service = {
    ...(await serviceState(installRoot, { endpointAnswers: deps.endpointAnswers, processStartTimeMs })),
    logPath: serviceLogPath(installRoot),
  };
  const serviceWithVersion = {
    ...service,
    version: await processVersionStatus(serviceVersionPath(installRoot), service),
  };

  // Together: each server's runner pid may need its start read.
  const runners = await Promise.all(attachments.map((a) => runnerProcess(installRoot, a.serverId, service.running, processStartTimeMs)));
  const servers: ServerStatusRow[] = [];
  for (const [index, a] of attachments.entries()) {
    const { daemon, connected: serverConnected, lockHeldByPid, deferredOwner } = runners[index]!;
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
      ...(lockHeldByPid !== undefined ? { lockHeldByPid } : {}),
      ...(deferredOwner !== undefined ? { deferredOwner } : {}),
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
    servers,
    runtimeCliNotices: await readRuntimeCliNotices(installRoot),
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
  // A user session is no longer needed: each server is added with a
  // one-time approval (`raft-computer attach`). Only older servers and the
  // legacy-daemon migration in setup still sign in.
  const loginDetail = report.userSessionError
    ? "no — user session file is invalid (not needed: add a server with `raft-computer attach /<server>`)"
    : report.loggedIn
      ? `yes (user ${report.userId ?? "?"})`
      : "no (not needed: add a server with `raft-computer attach /<server>`)";
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
    const cause = code === "SHELL_ENV_TIMEOUT" ? ` Your login shell did not hand back its environment within ${SHELL_ENV_CAPTURE_TIMEOUT_MS / 1000} seconds.` : "";
    info(
      `  Warning: terminal shell environment import failed when the service started (${code}).${cause} The service is using the baseline environment, so tools available only in your terminal (custom PATH, exported variables) may be invisible to agents.`,
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
  for (const notice of report.runtimeCliNotices ?? []) info(`  Warning: ${notice}`);
  info(`Service log: ${report.service.logPath}`);
  info("");
  if (report.servers.length === 0) {
    info("Attachments:  none — run `raft-computer attach /<serverSlug>` (e.g. `/myserver`).");
  } else {
    info("Attachments:");
    info(`  ${pad("SERVER", 24)}${pad("HEALTH", 12)}${pad("CONNECTED", 12)}${pad("DAEMON", 24)}${pad("MACHINE", 38)}URL`);
    for (const s of report.servers) {
      const dcol = s.daemon.running
        ? `running (pid ${s.daemon.pid})`
        : s.lockHeldByPid !== undefined ? `lock held (pid ${s.lockHeldByPid})` : "stopped";
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
    if (report.servers.some((s) => s.lockHeldByPid !== undefined)) {
      info("");
      info(
        "  Note: one or more servers show `lock held`: a process the Computer service did not start holds this machine's daemon lock and could not be confirmed as that server's runner, so the service started no runner for them.",
      );
      info(
        "  Run `raft-computer doctor` for how to check that process and start the runner again.",
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
  const home = resolveRaftHome();
  formatStatusReport(await buildStatusReport(home));
  await printProcJobsStatus(home);
}

/**
 * `raft proc` (#proj-raft-computer:#59): the agents' running jobs, after the
 * report (agent short id, name, pid, running time) and how to stop them.
 * Read from the daemons' ledgers (procJobs.ts); none on Windows.
 */
export async function printProcJobsStatus(home: string, deps: ProcJobsDeps & { now?: () => number } = {}): Promise<void> {
  if ((deps.platform ?? process.platform) === "win32") return;
  const jobs = await listRunningProcJobs(home, deps).catch(() => []);
  for (const line of formatProcJobsStatus(jobs, (deps.now ?? Date.now)())) info(line);
  info("");
}

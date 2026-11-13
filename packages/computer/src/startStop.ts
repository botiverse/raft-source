// `raft-computer start` / `raft-computer stop` — CLI presenters over the
// ComputerApi (CLI-over-lib convergence). The supervisor/service internals
// stay in service.ts; these presenters were extracted so the supervisor no
// longer imports the lib/api facade (import-cycle decycle R0,
// #wg-raft-computer:18ab6541). Output remains adapter-owned, and the
// RunStartDeps/RunStopDeps shapes are preserved for the existing test harness.
import { resolveRaftHome, serverRunnerLogPath, serviceLogPath } from "./paths";
import { CliExit, info, present } from "./output";
import { createComputerApi } from "./lib/api";
import { isComputerError } from "./lib/errors";
import { noteStartCommandForRemoteUpgrade } from "./remoteUpgradeTrace";
import type { StartReadinessReport } from "./machineReadiness";
import { COMPUTER_VERSION } from "./version";
import {
  formatProcJobsLeftRunning,
  formatProcJobsStopped,
  listRunningProcJobs,
  stopRunningProcJobs,
  type ProcJobsDeps,
} from "./procJobs";
import { isProcessAlive, readPidfileAt, readProcessStartTimeMsBeforeActing } from "./internal/process-primitives";
import { deferredLockOwner, describeDeferredOwnerNotStopped } from "./runnerLockConflict";
import { formatServerSlugDisplay, listServerAttachments } from "./serverState";
import { isSeaBinary, type ResidentCoreFactory, type spawnDetachedService } from "./service";
import { formatLogindSessionRisk, type LogindSessionRisk } from "./logindSessionRisk";
import { liveSeaExecutablePath } from "./liveExecutable";
import { resolveSelfExec, selfExecHostFromProcess } from "@botiverse/raft-shared/src/selfExec";
import type { MacosHostLifecycleDeps } from "./macosLoginCarrier";
import type { convergeCliHostLifecycle } from "./macosLoginCarrier";

type RunStartDeps = {
  /** Record this start as a step of the web upgrade that ran it (`startNotesUpgradeStep`). */
  noteUpgradeStep?: boolean;
  noteStartCommand?: typeof noteStartCommandForRemoteUpgrade;
  coreFactory?: ResidentCoreFactory;
  spawnDetachedService?: typeof spawnDetachedService;
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  sleep?: (ms: number) => Promise<void>;
  ensureTimeoutMs?: number;
  ensurePollIntervalMs?: number;
  acceptPartialReady?: boolean;
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
};

/**
 * How long `start` waits for every runner to be ready when the external
 * installer runs it (`RAFT_COMPUTER_INSTALLER_LIFECYCLE=1`, set by
 * raft-computer-installer rust/computer.rs). The 15 s default made a slow
 * board's upgrade exit 1 (START_DAEMON_TIMEOUT) while the new service was in
 * fact starting, and the installer rolled it back (e0340021, 1.0.59 -> 1.0.60,
 * 2026-11-02). The installer gives `start` 45 s in all, lock wait and setup
 * included, so this stays well inside that. Undefined: the default.
 */
export const INSTALLER_LIFECYCLE_START_WAIT_MS = 30_000;
export function startWaitForCaller(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return env.RAFT_COMPUTER_INSTALLER_LIFECYCLE === "1" ? INSTALLER_LIFECYCLE_START_WAIT_MS : undefined;
}

/**
 * Under the external installer a start with some runners ready succeeds
 * (services/start.ts `acceptPartialReady`): a machine still registered on a
 * server it can no longer reach otherwise fails every upgrade's start and is
 * rolled back (88602a54, 9e56ad23, 2026-11-02). A person's `start` still
 * fails when any runner is missing.
 */
export function startAcceptsPartialReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAFT_COMPUTER_INSTALLER_LIFECYCLE === "1";
}

/**
 * Under the external installer this start's exit code decides whether the
 * upgrade is promoted or rolled back, so the start records what it judged in
 * the upgrade's step log (remoteUpgradeTrace.ts `start_command`). A working
 * upgrade rolled back on a failed start left only "start (exit 1)" behind
 * (#proj-raft-computer:#77, 2026-11-13).
 */
export function startNotesUpgradeStep(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAFT_COMPUTER_INSTALLER_LIFECYCLE === "1";
}

/**
 * The installer's `start` that never reached `runStart`: refused for the
 * mutation lock (`CONCURRENT_OPERATION`, …). Noted too, so a lock refusal is
 * not mistaken for a start the installer killed.
 */
export async function noteStartNeverRan(
  err: unknown,
  note: typeof noteStartCommandForRemoteUpgrade = noteStartCommandForRemoteUpgrade,
): Promise<void> {
  try {
    const code = err instanceof CliExit || isComputerError(err) ? err.code : undefined;
    await note(resolveRaftHome(), { version: COMPUTER_VERSION, outcome: "failed", errorCode: code ?? "unknown" });
  } catch {
    // Telemetry only.
  }
}

/** Format the user-visible "ready" summary line. Stays in the adapter
 *  (per liuliu msg=bb503633 narrow split) — service emits structured
 *  events with the ready Map + managed targets, this layer formats. */
function formatReadySummary(
  ready: Map<string, number>,
  serverIds: string[],
  opts: { serverId?: string | null; serverLabel?: string | null },
): string {
  if (opts.serverId && serverIds.length === 1) {
    const pid = ready.get(opts.serverId);
    return `Daemon for server ${opts.serverLabel ?? opts.serverId} is running${pid ? ` (pid ${pid})` : ""}.`;
  }
  return `Daemons for ${serverIds.length} managed server(s) are running.`;
}

// ---------- `start [serverId]` user-facing command ----------

/**
 * `raft-computer start [serverId]` CLI adapter. Thin wrapper over the
 * StartService (`./services/start.ts`); see service file header for the
 * locked shape (RFC v0.8 contract v4 §6 line 80 — typed events +
 * AbortSignal pre/post-spawn boundary + closed-set § codes byte-identical).
 *
 * This adapter's responsibilities:
 *   1. Map start.* events → info() lines byte-identical to the
 *      pre-extraction implementation.
 *   2. Map ComputerServiceError → fail(code, message), preserving
 *      CliExit semantics for the test harness.
 *   3. Render `formatReadySummary` (kept in adapter on purpose:
 *      user-visible text formatter, not service axis).
 *
 * The pre-extraction `RunStartDeps` shape is preserved so existing
 * service.test.ts test cases keep working — we forward the deps
 * straight into the service.
 */
/**
 * What `start` prints for a service it put in the background. A service the
 * CLI spawned detached is not started again by anything (no login item,
 * scheduled task or unit: macosLoginCarrier.ts), and on Windows it ends with
 * the sign-in session, so the line says when to run `start` again. Raft
 * Desktop starts an installed Computer each time it opens, on every platform,
 * unless the person stopped it (from Raft Desktop or with `raft-computer
 * stop`); whether it opens at sign-in is its own login item (macOS and
 * Windows).
 */
export function formatServiceStarted(
  servicePid: number,
  opts: { cliDetached: boolean; logindSessionRisk: boolean; platform?: NodeJS.Platform },
): string {
  const started = `Service started (pid ${servicePid}); keeps running after this terminal closes`;
  const sessionEnd = ", but stops when this login session ends";
  if (!opts.cliDetached) return `${started}${opts.logindSessionRisk ? sessionEnd : ""}.`;
  const again = "run `raft-computer start` again then, or use Raft Desktop, which starts it whenever Raft Desktop opens unless you stopped it.";
  if (opts.logindSessionRisk) return `${started}${sessionEnd}: ${again}`;
  return (opts.platform ?? process.platform) === "win32"
    ? `${started}. It stops when you sign out of Windows or the machine restarts: ${again}`
    : `${started}. It does not start by itself after the machine restarts: ${again}`;
}

export async function runStart(
  opts: {
    foreground?: boolean;
    serverId?: string | null;
    serverLabel?: string | null;
    recordLifecycleIntent?: boolean;
    hostLifecycleOwner?: "cli" | "app" | "none";
  } = {},
  deps: RunStartDeps = {},
): Promise<void> {
  // CLI presenter over `api.start` (CLI-over-lib convergence): the api drives
  // the StartService lifecycle (and maps ComputerServiceError → ComputerError);
  // this presenter supplies the event sink (info() formatting incl.
  // formatReadySummary — a user-visible text formatter, kept presenter-side)
  // and `present()` maps a thrown ComputerError → the shared stderr contract. The
  // RunStartDeps shape is preserved + forwarded so existing service.test.ts
  // cases keep working.
  const slockHome = resolveRaftHome();
  const api = createComputerApi(slockHome);

  // Track whether the service took the background-spawn path so we know
  // to emit the trailing "Managing N of M …" / "Per-server daemon logs"
  // / "Check state with …" block. The already_running and foreground paths
  // skip those lines.
  let spawnedBackground: {
    managedCount: number;
    attachedCount: number;
    logPath: string;
    runnerLogPaths: string[];
  } | null = null;
  const seen: { risk: LogindSessionRisk | null } = { risk: null };

  // A foreground start is the service itself: it never returns an exit code to the installer.
  const notesStep = deps.noteUpgradeStep === true && !opts.foreground;
  let readiness: StartReadinessReport | null = null;
  const noteStep = async (outcome: "ok" | "failed" | "skipped", errorCode?: string): Promise<void> => {
    if (!notesStep) return;
    try {
      await (deps.noteStartCommand ?? noteStartCommandForRemoteUpgrade)(slockHome, {
        version: COMPUTER_VERSION,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        readiness,
      });
    } catch {
      // Telemetry only: the start's own result stands.
    }
  };

  await present(async () => {
    const result = await api.start(
      {
        foreground: opts.foreground,
        serverId: opts.serverId ?? null,
        serverLabel: opts.serverLabel ?? null,
        recordLifecycleIntent: opts.recordLifecycleIntent,
        hostLifecycleOwner: opts.hostLifecycleOwner,
      },
      (event) => {
        if (event.kind === "start.already_running") {
          info(`Service already running (pid ${event.servicePid}).`);
        } else if (event.kind === "start.running") {
          info(
            `Running service in the foreground (managing ${event.managedTargets.length} of ${event.attachedCount} attached server(s)). Ctrl-C to stop.`,
          );
        } else if (event.kind === "start.logind_session_risk") {
          // Printed after the ready summary, where it is not scrolled away.
          seen.risk = event.risk;
        } else if (event.kind === "start.spawned") {
          info(formatServiceStarted(event.servicePid, {
            logindSessionRisk: seen.risk !== null,
            // A systemd unit starts by its own rules, and an app that hosts the Computer brings it back itself.
            cliDetached: opts.hostLifecycleOwner === "cli" && event.supervisorUnit === undefined,
          }));
          spawnedBackground = {
            managedCount: event.managedTargets.length,
            attachedCount: event.attachedCount,
            logPath: serviceLogPath(slockHome),
            runnerLogPaths: event.managedTargets.map((serverId) =>
              serverRunnerLogPath(slockHome, serverId),
            ),
          };
        } else if (event.kind === "start.skipped_unlinked") {
          for (const serverId of event.serverIds) {
            info(
              `Skipped ${serverId}: the server unlinked this Computer. Run \`raft-computer setup ${serverId}\` to reconnect it.`,
            );
          }
        } else if (event.kind === "start.ready") {
          info(formatReadySummary(event.ready, event.managedTargets, opts));
        } else if (event.kind === "start.partial_ready") {
          info(formatReadySummary(event.ready, event.managedTargets, opts));
          info(`Not ready yet on ${event.notReady.length} server(s): ${event.notReady.join(", ")}. Started anyway (run by the installer); check them with \`raft-computer status\`.`);
        } else if (event.kind === "host_lifecycle.skipped") {
          info(`Note: macOS startup cleanup skipped (${event.code ?? event.message}); ${event.operation} continues.`);
        }
      },
      {
        spawnDetachedService: deps.spawnDetachedService,
        readPidfile: deps.readPidfile,
        isProcessAlive: deps.isProcessAlive,
        sleep: deps.sleep,
        ensureTimeoutMs: deps.ensureTimeoutMs,
        ensurePollIntervalMs: deps.ensurePollIntervalMs,
        acceptPartialReady: deps.acceptPartialReady,
        signal: deps.signal,
        convergeHostLifecycle: deps.convergeHostLifecycle,
        hostLifecycleDeps: deps.hostLifecycleDeps,
        ...(notesStep ? { onReadiness: (report: StartReadinessReport) => { readiness = report; } } : {}),
      },
    ).catch(async (err: unknown) => {
      await noteStep("failed", isComputerError(err) ? err.code : "unknown");
      throw err;
    });
    // Aborted: the caller lost its lock after the spawn; readiness was not judged.
    await (result.status === "aborted" ? noteStep("skipped", "aborted") : noteStep("ok"));
  });

  if (spawnedBackground) {
    const sb: {
      managedCount: number;
      attachedCount: number;
      logPath: string;
      runnerLogPaths: string[];
    } = spawnedBackground;
    info(
      `Managing ${sb.managedCount} of ${sb.attachedCount} attached server(s). Logs: ${sb.logPath}`,
    );
    info(`Per-server runner logs: ${sb.runnerLogPaths.join(", ")}`);
    info(`Check state with \`raft-computer status\`.`);
  }
  const risk = seen.risk;
  if (risk) {
    const isSea = isSeaBinary();
    const self = resolveSelfExec([], selfExecHostFromProcess(process, isSea, isSea ? liveSeaExecutablePath() : process.execPath));
    for (const line of formatLogindSessionRisk(risk, { command: [self.command, ...self.args], raftHome: slockHome })) info(line);
  }
}

// ---------- `stop` user-facing command ----------

/**
 * v0.0.8 — root `raft-computer stop` command.
 *
 * Stop the persistent service process gracefully (SIGTERM → wait for
 * pidfile clear). Idempotent: missing or stale pidfile reports
 * "Service not running" and exits 0; the existing service signal
 * handler clears its own pidfile on shutdown (service.ts shutdown
 * handler around L680).
 *
 * Wired into the legacy upgrade-ephemeral-context remediation sequence
 * (ephemeral gate redirect, msg=fb9e5675 Hao): the root
 * service-level `stop` must exist so old npm-installed Computers can be
 * stopped before moving to the SEA install path. Pre-0.0.8 the only `stop`
 * was `runners stop <agentId>`.
 *
 * Failure surfaces (Tier-2 stderr-only per §4.4 dual-tier note):
 *   - SIGTERM throws (e.g. EPERM) → STOP_SIGNAL_FAILED with actionable
 *   - SIGTERM succeeds + service doesn't exit within `timeoutMs` →
 *     STOP_TIMEOUT with `kill -9 <pid>` hint
 *
 * Dep-injectable for tests so we can simulate pidfile state + kill /
 * isAlive transitions without launching a real service.
 */
export interface RunStopDeps {
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  killService?: (pid: number) => void;
  /** When the process holding the recorded service pid started (services/stop.ts). */
  processStartTimeMs?: (pid: number) => Promise<number | undefined>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  recordLifecycleIntent?: boolean;
  signal?: AbortSignal;
  hostLifecycleOwner?: "cli" | "app" | "none";
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
  /**
   * The agents' `raft proc` jobs (procJobs.ts), once the service is stopped:
   * `stop` (`raft-computer stop --jobs`) stops them too; `report` (a plain
   * `raft-computer stop`) leaves them running and says how many and the
   * command that stops them. Absent (restart, setup): nothing about them.
   */
  jobs?: "stop" | "report";
  procJobs?: ProcJobsDeps;
}

export async function runStop(deps: RunStopDeps = {}): Promise<void> {
  // CLI presenter over `api.stop`. The api drives the StopService lifecycle;
  // this supplies the info() sink and `present()` maps a thrown ComputerError
  // → the shared stderr contract. RunStopDeps is preserved + forwarded for the tests.
  const home = resolveRaftHome();
  const api = createComputerApi(home);
  await present(async () => {
    await api.stop(
      (event) => {
        if (event.kind === "stop.not_running") {
          info("Service not running.");
        } else if (event.kind === "stop.stale_pidfile_cleared") {
          info(event.otherProgram
            ? `Service not running: pid ${event.pid} in its pid file is another program now and was not signalled (cleared the stale pid file).`
            : `Service not running (cleared stale pid file for pid ${event.pid}).`);
        } else if (event.kind === "stop.stopped") {
          info(`Stopped service (pid ${event.pid}).`);
        } else if (event.kind === "host_lifecycle.skipped") {
          info(`Note: macOS startup cleanup skipped (${event.code ?? event.message}); ${event.operation} continues.`);
        }
      },
      {
        readPidfile: deps.readPidfile,
        isProcessAlive: deps.isProcessAlive,
        killService: deps.killService,
        processStartTimeMs: deps.processStartTimeMs,
        sleep: deps.sleep,
        pollIntervalMs: deps.pollIntervalMs,
        timeoutMs: deps.timeoutMs,
        now: deps.now,
        signal: deps.signal,
        convergeHostLifecycle: deps.convergeHostLifecycle,
        hostLifecycleDeps: deps.hostLifecycleDeps,
      },
      {
        recordLifecycleIntent: deps.recordLifecycleIntent,
        hostLifecycleOwner: deps.hostLifecycleOwner,
      },
    );
    // Like the jobs below, only for a plain `stop` (restart and setup start again and report the lock there).
    if (!deps.jobs) return;
    // The service signals only runners it started. A lock owner it had
    // deferred to is left running, whoever it is: name each, and say it is
    // this server's runner only when its start was read and says so.
    for (const attachment of await listServerAttachments(home).catch(() => [])) {
      const owner = await deferredLockOwner(home, attachment.serverId, {
        isAlive: deps.isProcessAlive,
        processStartTimeMs: deps.processStartTimeMs ?? readProcessStartTimeMsBeforeActing,
      });
      if (!owner) continue;
      const label = attachment.serverSlug ? formatServerSlugDisplay(attachment.serverSlug) : attachment.serverId;
      info(`${label}: ${describeDeferredOwnerNotStopped(owner)}`);
    }
    // `raft proc`: after the service (no daemon starts another job meanwhile).
    if ((deps.procJobs?.platform ?? process.platform) === "win32") return;
    if (deps.jobs === "stop") {
      for (const line of formatProcJobsStopped(await stopRunningProcJobs(home, deps.procJobs))) info(line);
    } else {
      for (const line of formatProcJobsLeftRunning(await listRunningProcJobs(home, deps.procJobs).catch(() => []))) info(line);
    }
  });
}

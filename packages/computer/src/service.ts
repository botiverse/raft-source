// Computer service + per-server daemon children (RFC v0.8 contract
// v4 §1/§6).
//
// Process model:
//
//   raft-computer start [serverId]              ← user command (foreground; exits after spawn)
//      └── raft-computer __service            ← detached, long-running service (one per SLOCK_HOME)
//           ├── raft-computer __run <serverIdA> ← per-server DaemonCore child (one per attached server)
//           └── raft-computer __run <serverIdB>
//
// The service reconciles `listAttachedServerIds()` against the set
// of live children: it spawns missing children, restarts crashed
// children with a small backoff, and reaps children whose attachment
// disappears after future explicit recovery tooling. It is the host-level owner
// of all per-server daemons in a single Computer / SLOCK_HOME.
//
// §3.3.1 redline: each per-server sk_computer_* lives only in its own
// child's memory (loaded from `servers/<serverId>/runner.state.json`);
// it is never read by the service, never logged, never printed.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { COMPUTER_VERSION } from "./version.js";
import { clearResidentConnectedMarker, readResidentConnectedMarker, writeResidentConnectedMarker } from "./residentConnectionMarker.js";
import { residentCoreIdentity } from "./residentCoreIdentity.js";
import { mkdir, writeFile, open, stat, unlink } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import {
  resolveRaftHome,
  serviceRunDir,
  servicePidPath,
  serviceLogPath,
  serverRunnerPidPath,
  serverRunnerLogPath,
  assertValidServerId,
  serverConnectedMarkerPath,
} from "./paths.js";
import {
  listManagedServerIds,
  readServerAttachment,
} from "./serverState.js";
import { fail, formatHumanError, info, present } from "./output.js";
import { runFullCleanup } from "./cleanup.js";
import { rotateLogIfNeeded } from "./logRotation.js";
import {
  recordCrash,
  isDegraded,
  markFatalConfig,
  markTerminalUnlinked,
  readTerminalUnlinked,
  emitRunnerStateTransition,
  classifyTerminalHandshakeRejection,
} from "./health.js";
import {
  canSpawn,
  nextRunnerStateOnExit,
  exitTrigger,
  rehydrateRunnerRecord,
  applyRunnerReset,
  clearExternalRunnerPidIfDead,
  RUNNER_TRIGGER,
  type RunnerRecord,
  type ChildExitClass,
} from "./lib/runnerStateMachine.js";
import type { RunnerState } from "./lib/state.js";
import {
  readPidfileAt,
  isProcessAlive,
  writePidfileAt,
  clearPidfileAt,
} from "./internal/process-primitives.js";
import { readRunnerLogDiagnosticText } from "./internal/runner-log-diagnostics.js";
import type { IpcServer } from "./internal/ipc-server.js";
import {
  ServiceClientError,
} from "./lib/types.js";
import { resetService, resetRunner } from "./reset.js";
import { currentDate } from "@botiverse/raft-shared";
import type { DaemonCoreOptions } from "@botiverse/raft-daemon/core";
import { enqueueLifecycleOperation } from "./lifecycleOperations.js";
import { shutdownService } from "./lib/serviceShutdown.js";
import { createReplacementHandoff, type ReplacementHandoffRequest } from "./lib/replacementHandoff.js";
import {
  clearPendingRestartMarker,
  readPendingRestartMarker,
  shouldReconcilePendingRestart,
  writePendingRestartMarker,
} from "./restartMarker.js";
import { readLiveServiceSnapshot, resolveSourceServicePid } from "./machineServiceAttestation.js";
import { prepareResidentLifecycleBridge } from "./residentLifecycleBridge.js";
import { writeRunnerVersionEvidence } from "./runningVersionEvidence.js";
import { startServiceReconcileLoop } from "./serviceReconcileLoop.js";
import {
  publishServiceIdentityAfterIpcBind,
  type ServiceIdentityPublishDeps,
} from "./lib/serviceIdentity.js";
import { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle.js";
import { buildRunnerChildEnv, PARENT_LOCK_HELD_ENV_VAR, SOURCE_SERVICE_PID_ENV_VAR } from "./runnerChildEnv.js";
import { handleRunnerLockConflict } from "./runnerLockConflict.js";
import {
  checkServiceControlAvailability,
  performServiceSelfRestart,
  requestServiceRestartViaIpc,
  requestServiceUpgradeViaIpc,
  type InFlightServiceControl,
  type ServiceSelfRestartControlDeps,
} from "./serviceControl.js";
import { resolveKResidentBinary } from "./kResidentBinary.js";
import {
  spawnPendingKUpgradeRecovery,
} from "./kUpgradeProcess.js";
import {
  createServiceUpgradeStart,
  type ServiceUpgradeStartSeams,
} from "./serviceUpgradeStart.js";
import { readKRunnerHold } from "./kRunnerHold.js";
import { reconcileKUpgradeOnConnect } from "./kUpgradeReconcile.js";
import { adoptLegacyKUpgradeOrigin } from "./legacyKOriginAdoption.js";
import {
  createServiceIpcSeam,
  listenServiceIpcSeam,
  type ServiceIpcMutations,
} from "./serviceIpcSeam.js";
export {
  checkServiceControlAvailability,
  requestServiceRestartViaIpc,
  requestServiceUpgradeViaIpc,
} from "./serviceControl.js";
export type {
  InFlightServiceControl,
  ManagedUpgradeRelayContext,
  ManagedUpgradeRelayDeps,
} from "./serviceControl.js";
export { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle.js";
export { startServiceIpcSeam, type ServiceIpcMutations } from "./serviceIpcSeam.js";
export { buildRunnerChildEnv, PARENT_LOCK_HELD_ENV_VAR, SOURCE_SERVICE_PID_ENV_VAR } from "./runnerChildEnv.js";
export {
  readServiceVersionEvidence,
  type ServiceVersionEvidence,
} from "./runningVersionEvidence.js";

// ---------- self-re-exec argv builder (pure / unit-tested) ----------

const seaRequire = createRequire(import.meta.url);
let cachedIsSea: boolean | undefined;
export const RESIDENT_CLI_PATH_ENV_VAR = "RAFT_COMPUTER_CLI_PATH";

/**
 * True when running as a single-executable application (SEA) binary, where
 * `process.execPath` IS the bundled app and there is no JS script entry.
 */
export function isSeaBinary(): boolean {
  if (cachedIsSea !== undefined) return cachedIsSea;
  try {
    cachedIsSea = (seaRequire("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    cachedIsSea = false;
  }
  return cachedIsSea;
}

export function buildResidentSpawn(
  mode: "__service" | "__run",
  serverId: string | null,
  selfEntry = process.argv[1] ?? "",
  execArgv: string[] = process.execArgv,
  isSea = isSeaBinary(),
  seaExecutable = process.execPath,
): { command: string; args: string[] } {
  // Carry parent execArgv so the dev-mode tsx loader survives re-exec.
  const tail = serverId ? [mode, serverId] : [mode];
  // In a SEA binary, process.execPath IS the bundled app — there is no script
  // entry to pass, and `process.argv[1]` is the first user arg (not a script
  // path). Re-exec the binary directly with the mode flag, which the commander
  // `__service`/`__run` commands dispatch. Passing the SEA argv[1] would corrupt
  // the child argv.
  if (isSea) {
    return { command: seaExecutable, args: [...execArgv, ...tail] };
  }
  return { command: process.execPath, args: [...execArgv, selfEntry, ...tail] };
}

/**
 * Env-var marker telling the spawned service's startup recovery pass
 * that the parent CLI still holds `~/.slock/computer/.lock` (because it
 * is running under `withMutationLock`). When this marker is present the
 * service MUST skip stale-lock cleanup. Detached replacement children inherit
 * this marker. Cleanup itself remains ownership-safe for unmarked manual or
 * legacy starts.
 *
 * Dayu blocker (#wg-raft-computer:b43b36fb msg=ff69d33f): both
 * `runStart` and the K host adapter invoke `spawnDetachedService` while
 * the parent CLI is under `withMutationLock`. Without this marker, the
 * child service's startup recovery would force-release the parent's
 * lock during PR-E's long-running upgrade window. The latent same-class
 * risk also exists for the pre-PR-E `start` path, but its window is
 * shorter so it had not been flagged. Fixing here covers both callsites.
 *
 * The marker is intentionally NOT inherited by `__run` children (those
 * are launched by the service itself, after the parent has already
 * exited and released its lock). The service explicitly does not
 * propagate this env var when calling `buildResidentSpawn("__run", ...)`.
 */
export function parentMutationLockHeld(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PARENT_LOCK_HELD_ENV_VAR] === "1";
}

export function buildDetachedServiceEnv(
  baseEnv: NodeJS.ProcessEnv,
  opts: SpawnDetachedServiceOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (opts.parentMutationLockHeld === false) {
    delete env[PARENT_LOCK_HELD_ENV_VAR];
  } else {
    env[PARENT_LOCK_HELD_ENV_VAR] = "1";
  }
  if (opts.sourceServicePid !== undefined) {
    env[SOURCE_SERVICE_PID_ENV_VAR] = String(opts.sourceServicePid);
  } else {
    delete env[SOURCE_SERVICE_PID_ENV_VAR];
  }
  // A detached Computer replacement is never owned by a legacy OS manager,
  // even when the incumbent was originally launched by one.
  delete env[OS_SUPERVISOR_KIND_ENV_VAR];
  return env;
}

/**
 * Spawn a detached `raft-computer __service` child. The detached child
 * survives the parent process exit, writes its stdio to the service
 * log, and registers its pid in `service.pid`. Returns the pid.
 *
 * Shared by legacy CLI start and unsupervised SEA restart/rollback. Installed
 * Computers delegate restart ownership to the OS manager instead.
 *
 * Both current callsites (`runStart`, K handoff) invoke this while
 * holding `withMutationLock`, so the spawn always sets the parent-lock
 * marker to suppress the child service's stale-lock reclaim category. See
 * env-var docstring above.
 *
 * NOT for use inside `__service` itself (the service is already the
 * detached process). NOT for use inside `restartPhase` defaults: the
 * orchestrator's `deps.spawnFreshService` callback is the integration
 * point so unit tests can stub it without spawning real children.
 *
 * Throws if the OS refuses the spawn (no pid available).
 */
export interface SpawnDetachedServiceOptions {
  /**
   * Set when the spawning process still owns the mutation lock. CLI `start`
   * uses this so the child service does not delete the parent's live lock.
   * Service self-restart after a completed SEA swap must leave it false: the
   * service is not running under a parent CLI lock and the new service should
   * perform normal stale-lock recovery.
   */
  parentMutationLockHeld?: boolean;
  /** Exact service process that this replacement is taking over from. */
  sourceServicePid?: number;
  /** Test seam for the SEA-only K resident selector. */
  isSeaBinaryFn?: typeof isSeaBinary;
  /** Test seam for the K stable/experiment resolver. */
  resolveKResidentBinaryFn?: typeof resolveKResidentBinary;
}

export async function spawnDetachedService(
  slockHome: string,
  opts: SpawnDetachedServiceOptions = {},
): Promise<number> {
  await mkdir(serviceRunDir(slockHome), { recursive: true });
  // Rotate the service log on (re)start if over the size cap, before the
  // detached service inherits the fd (rotate-on-spawn — see logRotation.ts).
  await rotateLogIfNeeded(serviceLogPath(slockHome));
  const supLogFd = await open(serviceLogPath(slockHome), "a");
  const isSea = (opts.isSeaBinaryFn ?? isSeaBinary)();
  const residentBinary = await (opts.resolveKResidentBinaryFn ?? resolveKResidentBinary)(slockHome, process.execPath, isSea);
  const { command, args } = buildResidentSpawn(
    "__service", null, process.argv[1] ?? "", process.execArgv, isSea, residentBinary,
  );
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", supLogFd.fd, supLogFd.fd],
    windowsHide: true,
    env: buildDetachedServiceEnv(process.env, opts),
  });
  child.on("error", (err) => {
    process.stderr.write(formatHumanError("SUPERVISOR_SPAWN_FAILED", err.message));
  });
  const pid = child.pid;
  child.unref();
  await supLogFd.close();
  if (!pid) {
    throw new Error("SUPERVISOR_SPAWN_FAILED: could not spawn the service process");
  }
  // The service itself will rewrite service.pid with its own pid on
  // startup; we write here too so a fast `status` between spawn and the
  // child's write still sees a live pid.
  await writePidfileAt(servicePidPath(slockHome), pid);
  return pid;
}

export interface ServiceSelfRestartDeps extends Omit<ServiceSelfRestartControlDeps, "spawnDetachedServiceFn"> {
  spawnDetachedServiceFn?: typeof spawnDetachedService;
  /** Compatibility-only seam; legacy OS manager markers are ignored. */
  env?: NodeJS.ProcessEnv;
}

export async function requestServiceSelfRestart(
  slockHome: string,
  deps: ServiceSelfRestartDeps = {},
): Promise<void> {
  const { spawnDetachedServiceFn = spawnDetachedService, env: _env, ...controlDeps } = deps;
  await performServiceSelfRestart(slockHome, { ...controlDeps, spawnDetachedServiceFn });
}

export const requestServiceSelfRestartAfterUpgrade = requestServiceSelfRestart;

// ---------- per-server daemon child (the `__run <serverId>` mode) ----------

export interface ResidentCore {
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}
export type ResidentCoreFactory = (creds: {
  serverId: string;
  serverMachineId: string;
  apiKey: string;
  serverUrl: string;
}) => ResidentCore | Promise<ResidentCore>;

/**
 * Stable exit code for "the per-server daemon child can't even start
 * because its required dependency tree is missing or corrupt." Picked
 * to match the BSD `EX_CONFIG = 78` convention used by many CLIs.
 *
 * The service recognises this code and (a) does NOT charge the crash
 * toward the repeated-crash budget (the daemon hasn't actually crashed
 * — it never ran), (b) marks the server `degraded` immediately so the
 * status/doctor surface explains why, and (c) does NOT auto-restart
 * (a missing dep won't fix itself by retrying).
 *
 * Triggered by Jianwei field test (#wg-raft-computer:0d6f6c15 finding
 * #2): a fresh source-run setup before `pnpm --filter @botiverse/raft-daemon
 * build` produced infinite ERR_MODULE_NOT_FOUND crash-restart-spin until
 * the 60s/3-crash threshold kicked in. With EX_CONFIG fail-closed, the
 * first attempt logs the actionable error and stops.
 */
export const EX_CONFIG_EXIT_CODE = 78;
export const COMPUTER_MACHINE_UNLINKED_EXIT_CODE = 77;

/**
 * The bundled `pi` runtime (`@earendil-works/pi-coding-agent`) reads its OWN
 * `package.json` at module-init (config.js → `JSON.parse(readFileSync(...))`)
 * just to learn its version. In a SEA single-binary there is no package.json
 * next to the executable, so that read throws ENOENT and crashes `__run` at
 * startup — the daemon's driver registry eager-loads pi the moment
 * `@botiverse/raft-daemon/core` is imported. pi honors `PI_PACKAGE_DIR` as an
 * override, so for a SEA binary we point it at a tiny generated dir holding a
 * minimal package.json BEFORE importing core. No-op for non-SEA installs
 * (a real package.json sits next to the dist) and when already set.
 */
async function ensureSeaRuntimePackageDir(): Promise<void> {
  if (!isSeaBinary() || process.env.PI_PACKAGE_DIR) return;
  try {
    const dir = joinPath(resolveRaftHome(), "runtime-pkg");
    await mkdir(dir, { recursive: true });
    await writeFile(
      joinPath(dir, "package.json"),
      `${JSON.stringify({ name: "raft-computer-sea-runtime", version: COMPUTER_VERSION })}\n`,
    );
    process.env.PI_PACKAGE_DIR = dir;
  } catch {
    // best-effort — if this fails, pi surfaces its own ENOENT as before.
  }
}

/**
 * The CLI path to hand the daemon for the agent runtime (cliTransport). Pure
 * so it's unit-testable (task #113):
 *   - SEA single-binary → `"__cli"` sentinel (in-process re-exec).
 *   - Non-SEA → an explicit `RAFT_COMPUTER_CLI_PATH` if a bundled host (e.g.
 *     the Electron app) injected one; else `undefined` (normal node installs
 *     leave it unset → the daemon resolves its own bundled CLI dist).
 * The bundled-Electron case MUST inject the path because the daemon core is
 * inlined into the host bundle, so its relative `resolveRaftCliPath` fails.
 */
export function resolveResidentSlockCliPath(
  isSea: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isSea) return "__cli";
  const override = env[RESIDENT_CLI_PATH_ENV_VAR];
  return typeof override === "string" && override.length > 0 ? override : undefined;
}

const defaultCoreFactory: ResidentCoreFactory = async (creds) => {
  // Run before the dynamic core import, which eager-loads pi (see ensureSeaRuntimePackageDir).
  await ensureSeaRuntimePackageDir();
  let coreMod: { DaemonCore: new (o: DaemonCoreOptions) => ResidentCore };
  try {
    coreMod = (await import("@botiverse/raft-daemon/core")) as typeof coreMod;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const isModuleMissing =
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND" ||
      (err instanceof Error && /Cannot find (module|package)/i.test(err.message));
    if (isModuleMissing) {
      process.stderr.write(
          `raft-computer: per-server daemon failed to load \`@botiverse/raft-daemon/core\`.\n` +
          `  Reason: ${err instanceof Error ? err.message : String(err)}\n` +
          `  This usually means a source-run workspace without a built daemon dist.\n` +
          `  Fix: run \`pnpm --filter @botiverse/raft-daemon build\` once, then \`raft-computer restart <server>\`.\n` +
          `  (Packaged/npx installs ship the dist already — this only affects local source-run setups.)\n`,
      );
      process.exit(EX_CONFIG_EXIT_CODE);
    }
    throw err;
  }
  // Tell the runner it is launched by a managed Computer so it reports the
  // Computer bundle version distinctly from the underlying daemon version.
  // Pass both identities explicitly; inherited environment is not identity.
  const slockHome = resolveRaftHome();
  const markerPath = serverConnectedMarkerPath(slockHome, creds.serverId);
  const liveService = await readLiveServiceSnapshot(slockHome);
  const lifecycleBridge = await prepareResidentLifecycleBridge(slockHome, creds.serverId);
  return new coreMod.DaemonCore({
    ...residentCoreIdentity(creds),
    localTrace: true,
    lifecycleHooks: {
      onConnect: () => { writeResidentConnectedMarker(markerPath); },
      onDisconnect: () => { try { clearResidentConnectedMarker(markerPath); } catch {} },
      onHandshakeRejected: (event) => {
        const terminalReason = classifyTerminalHandshakeRejection(event.statusCode, event.reason);
        if (!terminalReason) return;
        const slockHome = resolveRaftHome();
        process.stderr.write(`raft-computer: server rejected this runner as ${terminalReason}; marking ${creds.serverId} terminal and stopping retries.\n`);
        void markTerminalUnlinked(slockHome, creds.serverId, creds.serverMachineId, event.statusCode, terminalReason)
          .catch(() => {})
          .finally(() => {
            process.exit(COMPUTER_MACHINE_UNLINKED_EXIT_CODE);
          });
      },
    },
    // CLI path resolution for the agent runtime (cliTransport):
    //   - SEA single-binary: inject the `__cli` sentinel — the agent CLI
    //     wrapper execs `<exe> __cli "$@"`, re-execing this binary in CLI mode
    //     (runBundledRaftCli). No sidecar script exists to resolve.
    //   - Bundled into a non-SEA host (e.g. the Electron menu-bar app): the
    //     daemon's relative `resolveRaftCliPath` CANNOT work — the daemon core
    //     is tsup-inlined into the host bundle, so `import.meta.url` points into
    //     the host bundle where no `cli/index.js` is adjacent. The host MUST
    //     hand us the CLI's real location via `RAFT_COMPUTER_CLI_PATH` (env is
    //     the seam: the __run child inherits it from the host process). Without
    //     it the claude driver throws `slockCliPath is required`. (task #113)
    //   - Normal node install (env unset, not SEA): leave undefined → the
    //     daemon resolves the bundled CLI dist relative to its own dist, as before.
    slockCliPath: resolveResidentSlockCliPath(isSeaBinary()),
    getComputerLifecycleAcks: lifecycleBridge.getAcknowledgements,
    getComputerLifecycleReadyAcks: lifecycleBridge.getReadyAcknowledgements,
    onComputerLifecycleReceipt: lifecycleBridge.acknowledgeReceipt,
    reconcileComputerLifecycleOrigin: () => adoptLegacyKUpgradeOrigin({ slockHome, serverId: creds.serverId }),
    computerControlViaSupervisor: lifecycleBridge.supervisorMutationsAttested,
    // Managed-Computer remote control (server → WS → runner). This runner
    // is the service's in-process `__run` child, so:
    //   restart → ask the supervisor IPC seam to spawn a replacement service
    //     and then terminate itself. This matches `raft-computer restart` at
    //     the service boundary; it is not just a per-server runner respawn.
    //   upgrade → relay requestId to the supervisor's `upgrade-start` IPC
    //     mutation and forward its progress/terminal events over this live WS.
    //     The runner never downloads, swaps, or kills itself; supervisor and
    //     CLI therefore share one machine-wide implementation.
    onComputerControl: async (action, ctx) => {
      const operationId = ctx.operationId ?? ctx.requestId;
      if (operationId) {
        await enqueueLifecycleOperation(resolveRaftHome(), creds.serverId, {
          operationId,
          action,
          pendingPhases: ["shutdown", "ready"],
        });
      }
      if (action === "restart") {
        if (!ctx.requestId) {
          throw new Error("managed restart requires a requestId for terminal readback");
        }
        await requestServiceRestartViaIpc(resolveRaftHome(), {
          requestId: ctx.requestId,
          originServerId: creds.serverId,
        });
        return;
      }
      if (ctx.requestId) {
        return requestServiceUpgradeViaIpc(resolveRaftHome(), creds.serverId, ctx.requestId, ctx);
      }
      console.warn(
        "[Computer] Ignoring upgrade request without requestId; " +
          "managed upgrade requires a requestId for progress and terminal readback.",
      );
    },
    // Project K's one terminal operation receipt to the exact origin server.
    onComputerUpgradeReconcile: async (emitDone, emitProgress) => {
      void emitProgress;
      await reconcileKUpgradeOnConnect({
        slockHome,
        serverId: creds.serverId,
        runnerVersion: COMPUTER_VERSION,
        emitDone,
      });
    },
    onComputerRestartReconcile: async (emitDone) => {
      const slockHome = resolveRaftHome();
      const marker = await readPendingRestartMarker(slockHome);
      if (!marker || !shouldReconcilePendingRestart(marker, creds.serverId)) return;
      emitDone({ requestId: marker.requestId, ok: true });
      await clearPendingRestartMarker(slockHome);
    },
  });
};

/**
 * Classify a per-server daemon child exit so the service's restart
 * loop can react proportionally.
 *
 *   `graceful`     — code 0, or terminated by SIGTERM/SIGINT. Treat as
 *                    an expected stop (service itself, external user
 *                    kill, or daemon's own clean shutdown). Don't count
 *                    toward crash budget; service still restarts if
 *                    the server is still in the MANAGED set.
 *   `config-error` — code 78 (EX_CONFIG_EXIT_CODE). Daemon child gave
 *                    up before running because its dep tree is broken
 *                    (e.g. source-run without `pnpm --filter
 *                    @botiverse/raft-daemon build`). Mark degraded
 *                    immediately, don't restart, don't count as crash.
 *   `already-running`
 *                  — daemon machine lock is held by another live daemon
 *                    process. Adopt/defer to that incumbent instead of
 *                    counting a crash or retrying into a spawn storm.
 *   `unlinked-terminal` — code 77. Server rejected the managed runner
 *                    handshake with computer_machine_unlinked, meaning the
 *                    server-side Computer/machine was deleted or unlinked.
 *                    Persisted terminal marker parks the runner; retrying the
 *                    same runner.state.json would loop forever.
 *   `crash`        — anything else. Count toward crash budget.
 *
 * Pure function — extracted from the service exit handler so it can
 * be unit-tested without spawning real processes.
 */
export type { ChildExitClass } from "./lib/runnerStateMachine.js";

const DAEMON_ALREADY_RUNNING_RE = /Another Slock daemon is already running/i;
const DAEMON_LOCK_OWNER_PID_RE = /\bpid=(\d+)\b/;

export function parseDaemonLockConflictOwnerPid(text: string): number | null {
  const pid = DAEMON_ALREADY_RUNNING_RE.test(text) ? Number(DAEMON_LOCK_OWNER_PID_RE.exec(text)?.[1] ?? 0) : 0;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function classifyRunnerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  diagnosticText = "",
): ChildExitClass {
  if (DAEMON_ALREADY_RUNNING_RE.test(diagnosticText)) return "already-running";
  if (code === COMPUTER_MACHINE_UNLINKED_EXIT_CODE) return "unlinked-terminal";
  if (code === EX_CONFIG_EXIT_CODE) return "config-error";
  if (signal === "SIGTERM" || signal === "SIGINT") return "graceful";
  if (code === 0) return "graceful";
  return "crash";
}

export interface HandleRunnerExitForSupervisorOptions {
  slockHome: string;
  serverId: string;
  rec: RunnerRecord;
  code: number | null;
  signal: NodeJS.Signals | null;
  diagnosticText?: string;
  shuttingDown?: boolean;
  isOwnerProcessAlive?: (pid: number) => boolean;
  emitTransition?: (
    serverId: string,
    from: RunnerState,
    to: RunnerState,
    trigger: string,
  ) => void;
  scheduleReconcile?: (delayMs: number) => void;
  writeStderr?: (text: string) => void;
  nowMs?: () => number;
}

export async function handleRunnerExitForSupervisor({
  slockHome,
  serverId,
  rec,
  code,
  signal,
  diagnosticText = "",
  shuttingDown = false,
  isOwnerProcessAlive = isProcessAlive,
  emitTransition = () => {},
  scheduleReconcile = () => {},
  writeStderr = (text) => {
    process.stderr.write(text);
  },
  nowMs = () => Date.now(),
}: HandleRunnerExitForSupervisorOptions): Promise<void> {
  // Operator stop / service shutdown asked this child to exit (managed.flag
  // cleared, killChild set `stopping`) → terminal `stopped`, no restart.
  if (rec.stopping) {
    const trigger = shuttingDown
      ? RUNNER_TRIGGER.shutdownStop
      : RUNNER_TRIGGER.operatorStop;
    const prev = rec.lifecycle;
    rec.lifecycle = "stopped";
    emitTransition(serverId, prev, "stopped", trigger);
    return;
  }

  const exitClass = classifyRunnerExit(code, signal, diagnosticText);

  // Config-error fail-closed: the daemon couldn't load its deps (e.g.
  // source-run with missing daemon dist). Not a crash-budget event — the
  // daemon never ran — but force `degraded` so doctor/status surfaces the
  // cause, and don't restart (a missing dep won't fix itself by retrying).
  if (exitClass === "config-error") {
    try {
      await markFatalConfig(slockHome, serverId, code, signal);
    } catch {
      /* health logging best-effort */
    }
    const prev = rec.lifecycle;
    rec.lifecycle = "degraded";
    emitTransition(serverId, prev, "degraded", RUNNER_TRIGGER.exitConfigError);
    writeStderr(
      `Service: server ${serverId} child exited with EX_CONFIG (${EX_CONFIG_EXIT_CODE}); ` +
        `marked degraded, NOT auto-restarting. ` +
        `See ${serverRunnerLogPath(slockHome, serverId)} for the actionable error.\n`,
    );
    return;
  }

  if (exitClass === "already-running") {
    const ownerPid = parseDaemonLockConflictOwnerPid(diagnosticText);
    await handleRunnerLockConflict({
      slockHome,
      serverId,
      rec,
      ownerPid,
      isOwnerProcessAlive,
      emitTransition,
      scheduleReconcile,
      writeStderr,
      nowMs,
      retryDelayMs: CHILD_RESTART_BACKOFF_MS,
    });
    return;
  }

  // Server-side delete/unlink is terminal for this runner.state.json.
  // Do not charge crash budget and do not retry: the same machine
  // credential will get the same 401 forever.
  if (exitClass === "unlinked-terminal") {
    try {
      const attachment = await readServerAttachment(slockHome, serverId);
      if (attachment && !(await readTerminalUnlinked(slockHome, serverId, attachment.serverMachineId))) {
        await markTerminalUnlinked(slockHome, serverId, attachment.serverMachineId, null);
      }
    } catch {
      /* health logging best-effort */
    }
    const prev = rec.lifecycle;
    rec.lifecycle = "degraded";
    emitTransition(serverId, prev, "degraded", RUNNER_TRIGGER.exitUnlinked);
    writeStderr(
      `Service: server ${serverId} was unlinked/deleted server-side; ` +
        `marked terminal, NOT auto-restarting. Run \`raft-computer setup ${serverId}\` ` +
        `to recover/rebind, then verify with \`raft-computer status ${serverId}\`.\n`,
    );
    return;
  }

  // Crash: record toward the budget first so the threshold check sees it.
  if (exitClass === "crash") {
    try {
      await recordCrash(slockHome, serverId, code, signal);
    } catch {
      /* health logging best-effort; never blocks recovery */
    }
  }
  const budgetBreached =
    exitClass === "crash" ? await isDegraded(slockHome, serverId) : false;
  const prev = rec.lifecycle;
  const to = nextRunnerStateOnExit(exitClass, budgetBreached);
  rec.lifecycle = to;
  emitTransition(serverId, prev, to, exitTrigger(exitClass, budgetBreached));

  if (to === "degraded") {
    writeStderr(
      `Service: server ${serverId} marked degraded (>=3 crashes in 60s); ` +
        `skipping auto-restart. Run \`raft-computer restart ${serverId}\` ` +
        `after fixing the underlying issue to try again.\n`,
    );
    return;
  }
  // crashed (under budget) or stopped (graceful exit while still wanted):
  // arm the backoff and schedule ONE reconcile. The reconcile re-reads
  // `wanted` (so clearing managed intent during the window is a no-op) and consults
  // canSpawn (so it cannot double-spawn). There is exactly one spawn path.
  rec.backoffUntil = nowMs() + CHILD_RESTART_BACKOFF_MS;
  scheduleReconcile(CHILD_RESTART_BACKOFF_MS);
}

/**
 * The per-server daemon child. Loads exactly THAT server's attachment
 * (per-server isolation: never reads another server's state), runs
 * DaemonCore in-process. SIGTERM/SIGINT → core.stop().
 */
export async function runResident(
  serverId: string,
  deps: { coreFactory?: ResidentCoreFactory } = {},
): Promise<void> {
  assertValidServerId(serverId);
  const slockHome = resolveRaftHome();
  const a = await readServerAttachment(slockHome, serverId);
  if (!a) {
    fail(
      "NO_ATTACHMENT",
      `No attachment for server ${serverId}. Run \`raft-computer attach ${serverId}\` first.`,
    );
  }
  const core = await (deps.coreFactory ?? defaultCoreFactory)({
    serverId: a.serverId,
    serverMachineId: a.serverMachineId,
    apiKey: a.apiKey,
    serverUrl: a.serverUrl,
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await core.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await core.start();
  // A contender that loses the core.start() machine lock cannot overwrite the owner's evidence.
  await writeRunnerVersionEvidence(slockHome, serverId);
}

// ---------- service loop (the `__service` mode) ----------
const CHILD_RESTART_BACKOFF_MS = 2_000;
const RUNNER_READY_POLL_INTERVAL_MS = 100;

// RunnerRecord + canSpawn own spawn eligibility/backoff; no side restarting set.
/**
 * PR-H §3.1 — service startup recovery pass (extracted so the
 * lock-preservation invariant can be unit-tested without launching the
 * full reconcile loop).
 *
 * A starting service is not proof that no CLI mutator is mid-flight. An
 * unmarked manual or legacy start therefore only reclaims a stale `.lock` by
 * first acquiring it through proper-lockfile; a fresh/live lock remains
 * untouched.
 *
 * Failures are tolerated: cleanup is best-effort self-heal, not a gate on
 * service liveness. A failed cleanup logs a breadcrumb but does not
 * abort startup.
 *
 * Detached replacement services inherit the parent-lock marker and skip the
 * entire lock cleanup category. A real mutation can exceed 60s; the marker
 * avoids even attempting stale acquisition while that known parent owns it.
 */
export async function runServiceStartupRecovery(slockHome: string): Promise<void> {
  const parentHoldsLock = parentMutationLockHeld();
  try {
    if (parentHoldsLock) {
      process.stderr.write(
        "Service startup: parent CLI holds mutation lock — skipping lock cleanup.\n",
      );
    }
    const report = await runFullCleanup(slockHome, { skipLockCleanup: parentHoldsLock });
    if (report.anyAction) {
      process.stderr.write(
        `Service startup recovery: cleaned ${report.stalePidfiles.length} pidfile(s), ${report.powerLossRecovered.length} quarantined, ${report.tmpFilesCleared.length} tmp file(s), ${report.staleLocks.length} stale lock(s).\n`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Service startup recovery pass failed: ${msg}. Continuing; cleanup will retry on next service restart.\n`,
    );
  }
}

export async function hasRunnerReadyEvidence(
  slockHome: string,
  serverId: string,
  pid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<boolean> {
  if (!isAlive(pid)) return false;
  return readResidentConnectedMarker(serverConnectedMarkerPath(slockHome, serverId))?.pid === pid;
}

export interface RunServiceDeps extends ServiceUpgradeStartSeams {
  requestSelfRestart?: ReplacementHandoffRequest;
  serviceSelfRestartDeps?: Omit<
    ServiceSelfRestartDeps,
    "releaseServiceOwnership" | "restoreServiceOwnership"
  >;
  serviceIdentityPublishDeps?: ServiceIdentityPublishDeps;
  isSeaBinaryFn?: typeof isSeaBinary;
  resolveKResidentBinaryFn?: typeof resolveKResidentBinary;
  spawnPendingKUpgradeRecoveryFn?: typeof spawnPendingKUpgradeRecovery;
  readKRunnerHoldFn?: typeof readKRunnerHold;
  onMutationsReady?: (mutations: ServiceIpcMutations) => void | Promise<void>;
  stopAfterMutationsReady?: boolean;
  shutdownServiceFn?: typeof shutdownService;
  afterIpcReady?: (shutdown: () => Promise<void>) => void | Promise<void>;
}

/**
 * RFC v9.8 §3/§4 IPC seam — bind the typed-RPC server inside the long-running
 * service process. Reader methods delegate to the shared lib readers so the
 * wire surface is the same shape downstream consumers (Electron app, future
 * SDKs) get from `import { readServiceStatus } from "@botiverse/raft-computer/lib"`.
 *
 * `restart-service` / `reset-service` / `reset-runner` are wired to the injected `mutations`
 * surface (single-writer: the supervisor owns the mutation so its in-memory
 * runner state is updated, not just disk). With no `mutations` they fall back
 * to the lib-pure disk-only handlers where that is safe. Live supervisor-only
 * mutations surface `IPC_MALFORMED_FRAME` when no mutation surface is present.
 *
 * The IPC endpoint is the service ownership boundary. Bind failure is fatal:
 * a loser must not supervise runners or publish service identity evidence.
 */
export async function runService(deps: RunServiceDeps = {}): Promise<void> {
  const slockHome = resolveRaftHome();
  await mkdir(serviceRunDir(slockHome), { recursive: true });
  await runServiceStartupRecovery(slockHome);
  const sourceServicePid = await resolveSourceServicePid(
    slockHome,
    process.env[SOURCE_SERVICE_PID_ENV_VAR],
  );
  let ipc: IpcServer | null = null;
  // Explicit §3.2 runner state machine as the supervisor's runtime model: one
  // RunnerRecord per server, keyed by serverId. Replaces the old
  // `children: Map<ChildHandle>` + side `restarting: Set` pair.
  const runners = new Map<string, RunnerRecord>();
  let shuttingDown = false;
  let inFlightControl: InFlightServiceControl | null = null;
  let inFlightControlOwner: symbol | null = null;
  let kRecoveryChild: ChildProcess | null = null;
  const requestSelfRestart = deps.requestSelfRestart ?? ((expectedComputerVersion, beforeCommitExit) => requestServiceSelfRestart(slockHome, {
    ...deps.serviceSelfRestartDeps,
    releaseServiceOwnership: async () => {
      if (!ipc) {
        throw new ServiceClientError(
          "SELF_RELAUNCH_UNAVAILABLE",
          "SELF_RELAUNCH_UNAVAILABLE: live IPC ownership is unavailable",
        );
      }
      await ipc.releaseListener();
    },
    restoreServiceOwnership: async () => {
      if (!ipc) {
        throw new ServiceClientError(
          "SELF_RELAUNCH_UNAVAILABLE",
          "SELF_RELAUNCH_UNAVAILABLE: incumbent IPC server is unavailable for restoration",
        );
      }
      await publishServiceIdentityAfterIpcBind(slockHome, () => ipc!.listen());
    },
    ...(expectedComputerVersion ? { expectedComputerVersion } : {}),
    ...(beforeCommitExit ? { beforeCommitExit } : {}),
  }));
  const replacementHandoff = createReplacementHandoff(requestSelfRestart);

  // Strip the parent-mutation-lock marker before spawning per-server
  // `__run` daemons so the control flag never leaks into daemon /
  // runtime / agent process environments. The marker is a startup-only
  // hint for a child SUPERVISOR; daemons don't run startup recovery and
  // shouldn't observe it. Defensive even though `runResident` doesn't
  // currently read this var. See Dayu nit (msg=29336624).
  const childEnv = buildRunnerChildEnv(process.env);

  const emitTransition = (
    serverId: string,
    from: RunnerState,
    to: RunnerState,
    trigger: string,
  ): void => {
    // Best-effort §7.5 trace; emitRunnerStateTransition swallows its own errors.
    void emitRunnerStateTransition(slockHome, serverId, from, to, trigger);
  };

  // Assigned after `reconcile` is defined; the exit handler / spawn-failure
  // path call it to drive the single spawn path after a backoff.
  let scheduleReconcile: (delayMs: number) => void = () => {};

  const markRunnerReadyIfConnected = async (serverId: string, rec: RunnerRecord): Promise<boolean> => {
    const pid = rec.child?.pid;
    if (!pid) return false;
    if (!(await hasRunnerReadyEvidence(slockHome, serverId, pid))) return false;
    const prev = rec.lifecycle;
    rec.lifecycle = "running";
    rec.backoffUntil = undefined;
    await writePidfileAt(serverRunnerPidPath(slockHome, serverId), pid);
    emitTransition(serverId, prev, "running", RUNNER_TRIGGER.ready);
    return true;
  };

  const spawnChild = async (serverId: string): Promise<void> => {
    if (shuttingDown) return;
    const existing = runners.get(serverId);
    // Idempotency: a live child already registered → never spawn a second
    // (it would lose the machine-lock race and crash-spin).
    if (existing?.child) return;
    // Mark `starting` SYNCHRONOUSLY (before any await) so an interleaved
    // reconcile sees the runner is no longer spawn-eligible — canSpawn rejects
    // `starting`. This single-owner handoff is what the old `restarting` set
    // provided, now expressed as an explicit lifecycle state.
    const fromState: RunnerState = existing?.lifecycle ?? "stopped";
    const record: RunnerRecord =
      existing ?? { serverId, lifecycle: "stopped", stopping: false };
    record.lifecycle = "starting";
    record.stopping = false;
    record.backoffUntil = undefined;
    record.child = undefined;
    runners.set(serverId, record);
    emitTransition(serverId, fromState, "starting", RUNNER_TRIGGER.spawn);

    const logPath = serverRunnerLogPath(slockHome, serverId);
    await mkdir(dirname(logPath), { recursive: true });
    // Rotate this runner's log if over the cap before the child inherits the
    // fd — bounds chatty/crash-looping runners at each (re)spawn.
    await rotateLogIfNeeded(logPath);
    const logStartOffset = await stat(logPath).then((s) => s.size, () => 0);
    const logFd = await open(logPath, "a");
    const isSea = (deps.isSeaBinaryFn ?? isSeaBinary)();
    const residentBinary = await (deps.resolveKResidentBinaryFn ?? resolveKResidentBinary)(slockHome, process.execPath, isSea);
    const { command, args } = buildResidentSpawn(
      "__run", serverId, process.argv[1] ?? "", process.execArgv, isSea, residentBinary,
    );
    const child = spawn(command, args, {
      stdio: ["ignore", logFd.fd, logFd.fd],
      windowsHide: true,
      env: childEnv,
    });
    await logFd.close();
    if (!child.pid) {
      // Spawn produced no process → treat as a crash so the backoff fires and
      // we don't hot-loop a failing spawn.
      record.lifecycle = "crashed";
      record.backoffUntil = Date.now() + CHILD_RESTART_BACKOFF_MS;
      emitTransition(serverId, "starting", "crashed", RUNNER_TRIGGER.spawnFailed);
      scheduleReconcile(CHILD_RESTART_BACKOFF_MS);
      return;
    }
    record.child = child;
    // Keep the runner in `starting` until the daemon's handshake/onConnect path
    // writes its connected marker. A spawned process is not readiness evidence:
    // lock-conflict children can exit almost immediately with "already running"
    // while a real incumbent runner is healthy. `runner.pid` is therefore also
    // written only after connected-marker evidence exists, which keeps
    // `raft-computer start` from returning on a 6ms fake-ready spawn.
    scheduleReconcile(RUNNER_READY_POLL_INTERVAL_MS);
    child.on("exit", (code, signal) => {
      void (async () => {
        const rec = runners.get(serverId);
        if (!rec) return;
        rec.child = undefined;
        await clearPidfileAt(serverRunnerPidPath(slockHome, serverId)); // PID-bound stale connection evidence fails closed.

        // Operator stop / service shutdown asked this child to exit (managed.flag
        // cleared, killChild set `stopping`) → terminal `stopped`, no restart.
        if (rec.stopping) {
          const trigger = shuttingDown
            ? RUNNER_TRIGGER.shutdownStop
            : RUNNER_TRIGGER.operatorStop;
          const prev = rec.lifecycle;
          rec.lifecycle = "stopped";
          emitTransition(serverId, prev, "stopped", trigger);
          return;
        }

        const diagnosticText = await readRunnerLogDiagnosticText(logPath, logStartOffset);
        await handleRunnerExitForSupervisor({
          slockHome,
          serverId,
          rec,
          code,
          signal,
          diagnosticText,
          shuttingDown,
          emitTransition,
          scheduleReconcile,
        });
      })();
    });
  };

  const killChild = (rec: RunnerRecord): void => {
    rec.stopping = true;
    try {
      rec.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (rec.externalPid !== undefined) {
      try {
        process.kill(rec.externalPid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };

  const reconcile = async (): Promise<void> => {
    if (shuttingDown) return;
    // HostAdapter lifecycle state: resume() removes it only when the successor
    // may repopulate the parked managed set K attests before promotion.
    const holdRunnersForK = await (deps.readKRunnerHoldFn ?? readKRunnerHold)(slockHome);
    // Contract v4 §6 line 80: the service keeps daemons running for servers in
    // the MANAGED subset (attached + managed.flag set), not every attached
    // server. `start [serverId]` writes managed.flag for the targeted
    // server(s); `start` without serverId writes it for all attached.
    const wanted = new Set(await listManagedServerIds(slockHome));
    const now = Date.now();
    let hasPendingReadyProbe = false;
    for (const id of wanted) {
      const existing = runners.get(id);
      if (existing?.externalPid !== undefined && clearExternalRunnerPidIfDead(existing, isProcessAlive)) {
        await clearPidfileAt(serverRunnerPidPath(slockHome, id));
        emitTransition(id, "running", existing.lifecycle, RUNNER_TRIGGER.exitGraceful);
      }
      if (existing?.child && existing.lifecycle === "starting") {
        const ready = await markRunnerReadyIfConnected(id, existing);
        if (!ready) hasPendingReadyProbe = true;
      }
      // Spawn-eligibility is the pure canSpawn(record, wanted, now): a runner
      // mid-backoff is crashed/stopped with a future backoffUntil and is
      // rejected here, so the periodic reconcile cannot race a scheduled
      // respawn — the old double-spawn window does not exist.
      if (!holdRunnersForK && canSpawn(runners.get(id), true, now)) await spawnChild(id);
    }
    for (const [id, rec] of runners) {
      if (!wanted.has(id) && rec.child) killChild(rec);
      if (!wanted.has(id) && rec.externalPid !== undefined) killChild(rec);
    }
    if (kRecoveryChild === null && (deps.isSeaBinaryFn ?? isSeaBinary)()) {
      const recovery = await (deps.spawnPendingKUpgradeRecoveryFn ?? spawnPendingKUpgradeRecovery)(
        slockHome,
        process.execPath,
      ).catch(() => null);
      if (recovery) {
        kRecoveryChild = recovery;
        recovery.once("exit", () => {
          if (kRecoveryChild === recovery) kRecoveryChild = null;
        });
      }
    }
    if (hasPendingReadyProbe || holdRunnersForK) scheduleReconcile(RUNNER_READY_POLL_INTERVAL_MS);
  };

  scheduleReconcile = (delayMs: number): void => {
    setTimeout(() => void reconcile(), Math.max(0, delayMs));
  };

  // Single-writer mutation surface: the supervisor owns reset so its
  // in-memory runner state is updated, not just disk. After ②, spawn
  // eligibility is derived from the in-memory RunnerState; a disk-only
  // reset would clear health.json but leave the cached lifecycle
  // `degraded`, so canSpawn would never respawn the recovered runner
  // until the next service restart. Routing reset through here transitions
  // the cached lifecycle `degraded → stopped` and reconciles, so the runner
  // comes back live without a restart.
  const upgradeStart = createServiceUpgradeStart({
    slockHome,
    currentBinaryPath: process.execPath,
    servicePid: process.pid,
    isSeaBinaryFn: deps.isSeaBinaryFn ?? isSeaBinary,
    readChannelFn: deps.readChannelFn,
    resolveUpgradeTargetVersionFn: deps.resolveUpgradeTargetVersionFn,
    spawnKUpgradeCoordinatorFn: deps.spawnKUpgradeCoordinatorFn,
    inspectKUpgradeStartFn: deps.inspectKUpgradeStartFn,
    waitForKUpgradeStartFn: deps.waitForKUpgradeStartFn,
    priorProcessIdentities: () => [...runners.entries()].flatMap(([serverId, record]) => {
      const pid = record.child?.pid ?? record.externalPid;
      return pid ? [`runner:${serverId}:${pid}`] : [];
    }),
    checkControlAvailability: (requestId) =>
      checkServiceControlAvailability(inFlightControl, "upgrade", requestId),
    claimControl: (requestId) => {
      const owner = Symbol(`upgrade:${requestId}`);
      inFlightControl = { action: "upgrade", requestId };
      inFlightControlOwner = owner;
      return owner;
    },
    releaseControl: (owner) => {
      if (inFlightControlOwner !== owner) return false;
      inFlightControl = null;
      inFlightControlOwner = null;
      return true;
    },
  });
  const mutations: ServiceIpcMutations = {
    restartService: async (params) => {
      const requestId = params?.requestId ?? "local-restart";
      if (checkServiceControlAvailability(inFlightControl, "restart", requestId) === "replay") {
        return { status: "accepted" };
      }
      const owner = Symbol(`restart:${requestId}`);
      inFlightControl = { action: "restart", requestId };
      inFlightControlOwner = owner;
      try {
        if (params) {
          const acceptedManagedServerIds = await listManagedServerIds(slockHome);
          const oldRunnerPids = Object.fromEntries([...runners.entries()].flatMap(([serverId, record]) => {
            const pid = record.child?.pid ?? record.externalPid;
            return pid ? [[serverId, pid] as const] : [];
          }));
          await writePendingRestartMarker(slockHome, {
            requestId: params.requestId,
            originServerId: params.originServerId,
            startedAt: currentDate().toISOString(),
            oldServicePid: process.pid,
            oldRunnerPids,
            acceptedManagedServerIds,
          });
        }
        await replacementHandoff.request();
      } catch (err) {
        process.stderr.write(
          `Service: failed to restart service: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        if (params) await clearPendingRestartMarker(slockHome).catch(() => {});
        if (inFlightControlOwner === owner) {
          inFlightControl = null;
          inFlightControlOwner = null;
        }
        throw err;
      }
      return { status: "accepted" };
    },
    resetService: () => resetService(slockHome),
    resetRunner: async (serverId) => {
      const result = await resetRunner(slockHome, serverId);
      if (result.status === "ok") {
        const rec = runners.get(serverId);
        if (rec && applyRunnerReset(rec)) {
          emitTransition(serverId, "degraded", "stopped", RUNNER_TRIGGER.reset);
          scheduleReconcile(0);
        }
      }
      return result;
    },
    upgradeStart,
  };
  await deps.onMutationsReady?.(mutations);
  if (deps.stopAfterMutationsReady) return;
  // Store the ownership handle before listen() exposes the endpoint. A client
  // may dispatch immediately after the OS accepts the bind, while identity
  // evidence is still being published; that request must observe the exact
  // live server it reached rather than the pre-bind null sentinel.
  ipc = createServiceIpcSeam(slockHome, mutations, sourceServicePid);
  await publishServiceIdentityAfterIpcBind(
    slockHome,
    () => listenServiceIpcSeam(ipc!),
    deps.serviceIdentityPublishDeps,
  );

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await (deps.shutdownServiceFn ?? shutdownService)({
      runners,
      closeIpc: () => ipc?.close(),
      isProcessAlive,
      clearServicePidfile: () => clearPidfileAt(servicePidPath(slockHome)),
      restartRequested: replacementHandoff.requested(),
    });
  };
  if (deps.afterIpcReady) return void (await deps.afterIpcReady(shutdown));
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Rehydrate durable runner health before the first reconcile: a server that
  // was `degraded` before this service stopped/upgraded MUST stay degraded
  // across the restart, otherwise the boot reconcile would respawn it and
  // resume the crash-spin the degrade was meant to stop. health.json is the
  // canonical record; this seeds the in-memory cache from it. This is the
  // in-memory side of "degraded survives a service restart/upgrade", which the
  // daemon-upgrade-compat behavior depends on.
  for (const id of await listManagedServerIds(slockHome)) {
    const attachment = await readServerAttachment(slockHome, id);
    const parked =
      await isDegraded(slockHome, id) ||
      (await readTerminalUnlinked(slockHome, id, attachment?.serverMachineId ?? null)) !== null;
    runners.set(id, rehydrateRunnerRecord(id, parked));
  }

  // The stale-upgrade attestation at the end of the initial pass is strictly
  // bounded, so periodic supervision is always installed.
  await startServiceReconcileLoop(reconcile);
  // Block forever; signals do the cleanup.
  await new Promise<void>(() => {
    /* never resolves */
  });
}

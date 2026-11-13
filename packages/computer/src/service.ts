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
import { readChannel } from "./lib/channelState";
import { startServiceMemorySampler } from "./serviceMemory";
import type { UpgradeStartParams, UpgradeStartResult } from "./lib/types";
import { compareComputerVersions } from "./computerVersionOrder";
import { readInstallerRepairHint } from "./installerRepairHint";
import { acknowledgeMigratedFrom, readMigratedFromForServer } from "./migratedFromMarker";
import { installerArgs, launchInstallerDetached, scrubInstallerOperationEnv, readInstallerVersion, readLastRemoteUpgradeReceipt, REMOTE_UPGRADE_FAILURE_WATCH_MS, UNIT_ESCAPING_INSTALLER_VERSION, type InstallerDownloadStats, recordRemoteUpgradeLaunch, recordRemoteUpgradeRefusal, waitForRemoteUpgradeFailureReceipt, watchRemoteUpgradeOutcome } from "./externalInstaller";
import { clearUpgradeDrainRequests, waitForUpgradeDrain, writeUpgradeDrainRequest, type UpgradeDrainRunner } from "./upgradeDrain";
import { appendRemoteUpgradeStep, collectRemoteUpgradeSteps, noteServiceTransitionForRemoteUpgrade, upgradeErrorCode, type RemoteUpgradeStepRecord } from "./remoteUpgradeTrace";
import {
  SUPERVISED_RELAUNCH_EXIT_CODE,
  UPGRADE_SAFE_KILL_MODES,
  clearSupervisorRecord,
  describeKillModeRequirement,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  runSystemctl,
  showUnitProperty,
  writeSupervisorRecord,
  type ExternalSupervisorRecord,
} from "./externalSupervisor";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { COMPUTER_VERSION } from "./version";
import { clearResidentConnectedMarker, readResidentConnectedMarker, writeResidentConnectedMarker } from "./residentConnectionMarker";
import { residentCoreIdentity } from "./residentCoreIdentity";
import { mkdir, writeFile, open, stat, unlink } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import {
  resolveRaftHome,
  serviceRunDir,
  servicePidPath,
  serviceLogPath,
  serverRunnerPidPath,
  serverRunnerLockConflictPath,
  serverRunnerLogPath,
  assertValidServerId,
  serverConnectedMarkerPath,
  serverRunnerMemoryPath,
  serverActivityPath,
  serviceMemoryPath,
  serverRunnerStopIntentPath,
  serverUpgradeDrainRequestPath,
  serverUpgradeDrainStatePath,
} from "./paths";
import {
  listManagedServerIds,
  readServerAttachment,
} from "./serverState";
import { fail, formatHumanError, info, present } from "./output";
import { runFullCleanup } from "./cleanup";
import { rotateLogIfNeeded } from "./logRotation";
import {
  recordCrash,
  isDegraded,
  markFatalConfig,
  markTerminalUnlinked,
  readTerminalUnlinked,
  emitRunnerStateTransition,
  classifyTerminalHandshakeRejection,
} from "./health";
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
} from "./lib/runnerStateMachine";
import type { RunnerState } from "./lib/state";
import {
  readPidfileAt,
  isProcessAlive,
  writePidfileAt,
  clearPidfileAt,
} from "./internal/process-primitives";
import { readRunnerLogDiagnosticText } from "./internal/runner-log-diagnostics";
import type { IpcServer } from "./internal/ipc-server";
import {
  ServiceClientError,
} from "./lib/types";
import { resetService, resetRunner } from "./reset";
import { clampComputerUpgradeDrain, currentDate, privacyModeFromEnv } from "@botiverse/raft-shared";
import { resolveSelfExec, selfExecHostFromProcess, type SelfExecHost } from "@botiverse/raft-shared/src/selfExec";
import { liveSeaExecutablePath } from "./liveExecutable";
export { executableFileIdentity, liveSeaExecutablePath } from "./liveExecutable";
import type { DaemonCoreOptions } from "@botiverse/raft-daemon/core";
import { enqueueLifecycleOperation } from "./lifecycleOperations";
import { shutdownService } from "./lib/serviceShutdown";
import { takeResidentStopIntent, writeResidentStopIntent, type ResidentStopSource } from "./residentStopIntent";
import { stopAfterMachineKeyRevoked, type MachineKeyRevokedStopResult } from "./residentRevokedStop";
import { createReplacementHandoff, type ReplacementHandoffRequest } from "./lib/replacementHandoff";
import {
  clearPendingRestartMarker,
  readPendingRestartMarker,
  pendingRestartRequestIdForServer,
  retirePendingRestartForServer,
  writePendingRestartMarker,
} from "./restartMarker";
import { readLiveServiceSnapshot, resolveSourceServicePid } from "./machineServiceAttestation";
import { prepareResidentLifecycleBridge } from "./residentLifecycleBridge";
import { writeRunnerVersionEvidence } from "./runningVersionEvidence";
import { startServiceReconcileLoop } from "./serviceReconcileLoop";
import {
  publishServiceIdentityAfterIpcBind,
  type ServiceIdentityPublishDeps,
} from "./lib/serviceIdentity";
import { retireCliLoginCarrier } from "./macosLoginCarrier";
import { claimDeviceSessionRetireReport, scheduleDeviceSessionRetire } from "./deviceSessionRetire";
import { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle";
import { SHELL_ENV_STATE_ENV_VAR } from "./shellEnvCapture";
import { buildRunnerChildEnv, PARENT_LOCK_HELD_ENV_VAR, pinRaftHomeEnv, SOURCE_SERVICE_PID_ENV_VAR } from "./runnerChildEnv";
import { claimRunnerLockConflictReports, clearRunnerLockConflictMarker, handleRunnerLockConflict, releaseDeferredLockOwner } from "./runnerLockConflict";
import {
  awaitRestartOutcomeAfterConnectionLoss,
  checkServiceControlAvailability,
  isServiceConnectionLoss,
  performServiceSelfRestart,
  requestServiceRestartViaIpc,
  requestServiceUpgradeStartViaIpc,
  type InFlightServiceControl,
  type ServiceSelfRestartControlDeps,
} from "./serviceControl";
import {
  createServiceIpcSeam,
  listenServiceIpcSeam,
  type ServiceIpcMutations,
} from "./serviceIpcSeam";
export {
  checkServiceControlAvailability,
  requestServiceRestartViaIpc,
} from "./serviceControl";
export type {
  InFlightServiceControl,
} from "./serviceControl";
export { startServiceIpcSeam, type ServiceIpcMutations } from "./serviceIpcSeam";
export { buildRunnerChildEnv, PARENT_LOCK_HELD_ENV_VAR, SOURCE_SERVICE_PID_ENV_VAR } from "./runnerChildEnv";
export {
  readServiceVersionEvidence,
  type ServiceVersionEvidence,
} from "./runningVersionEvidence";

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
  electron: ResidentElectronFacts = currentResidentElectronFacts(),
): { command: string; args: string[] } {
  const tail = serverId ? [mode, serverId] : [mode];
  // One host-aware rule for every self re-exec (resolveSelfExec in shared):
  // Node keeps execArgv (the dev TS loader) + the entry script; a SEA re-execs
  // its live binary with no script, since its argv[1] is a user arg; the
  // Electron app launcher gets only the mode, which its argv guard routes —
  // its argv[1] is not a script either (empty, or a deep link it was opened
  // with) and is kept only for a dev `electron <appPath>` launch.
  const { command, args } = resolveSelfExec(tail, {
    execPath: isSea ? seaExecutable : process.execPath,
    execArgv,
    argv: [process.execPath, selfEntry],
    isSea,
    ...electron,
  });
  return { command, args };
}

export type ResidentElectronFacts = Pick<SelfExecHost, "electronVersion" | "electronProcessType" | "electronDefaultApp">;

export function currentResidentElectronFacts(): ResidentElectronFacts {
  const { electronVersion, electronProcessType, electronDefaultApp } = selfExecHostFromProcess(process, false);
  return { electronVersion, electronProcessType, electronDefaultApp };
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
  // Deprecated marker (see OS_SUPERVISOR_KIND_ENV_VAR): scrub any stale value
  // so a detached replacement never carries it forward.
  delete env[OS_SUPERVISOR_KIND_ENV_VAR];
  // The shell-env outcome describes the boot that captured it. Replacements
  // that skip the import (Windows, RAFT_COMPUTER_SHELL_ENV_IMPORT=0) must not
  // report the incumbent's result as their own; replacements that import
  // overwrite it anyway.
  delete env[SHELL_ENV_STATE_ENV_VAR];
  // The bootstrap's version pin (`RAFT_COMPUTER_VERSION=… sh`, from pinned
  // setup commands) only chooses what install.sh installs. A service started
  // from that shell would pass it to every runner and agent, so a later
  // `install.sh` run by an agent silently pins to the old version again
  // (Shared-EC2 stayed on 1.0.36, 2026-10-20). Computer itself never reads it.
  delete env[INSTALL_VERSION_PIN_ENV_VAR];
  // A service the installer started carries that installer run's operation
  // variables; a replacement must not pass them on (#proj-raft-computer:#32).
  scrubInstallerOperationEnv(env);
  return env;
}

/** install.sh's version pin; see buildDetachedServiceEnv. */
export const INSTALL_VERSION_PIN_ENV_VAR = "RAFT_COMPUTER_VERSION";

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
  /** @deprecated no-op since the external installer; kept so callers compile. */
  isSeaBinaryFn?: typeof isSeaBinary;
  /** Test seam for the K stable/experiment resolver. */
  resolveKResidentBinaryFn?: unknown;
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
  const { command, args } = buildResidentSpawn(
    "__service", null, process.argv[1] ?? "", process.execArgv, isSea, liveSeaExecutablePath(),
  );
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", supLogFd.fd, supLogFd.fd],
    windowsHide: true,
    env: pinRaftHomeEnv(buildDetachedServiceEnv(process.env, opts), slockHome),
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
  stop: (options?: {
    source?: ResidentStopSource | "external_signal" | "machine_key_revoked";
    signal?: NodeJS.Signals;
  }) => void | Promise<void>;
  getRunningAgentIds?: () => string[];
  recordMachineKeyRevokedStop?: (result: MachineKeyRevokedStopResult) => void;
}
/** The runner's reactions to its connection, handed to the core it creates (DaemonCore `lifecycleHooks`). */
export interface ResidentLifecycleHooks {
  onConnect: () => void;
  onDisconnect: () => void;
  onHandshakeRejected: (event: { statusCode: number; reason: string | null }) => void;
}
export type ResidentCoreFactory = (creds: {
  serverId: string;
  serverMachineId: string;
  apiKey: string;
  serverUrl: string;
}, hooks: ResidentLifecycleHooks) => ResidentCore | Promise<ResidentCore>;

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
 * Runner exit code for a stop signal the service did not send. Every service
 * stop writes a stop intent first (`writeResidentStopIntent`) and sets
 * `rec.stopping`, so "no intent" means someone else signalled the runner
 * (another Computer service on the same data directory, a tool that kills
 * processes, an OS-level stop). Exiting 0 here would read as graceful and the
 * service would respawn forever; this code makes the service charge it to the
 * repeated-crash budget instead. 79: just past the sysexits range (64-78) and
 * not used by the runner, the daemon core or the service.
 */
export const EXTERNAL_STOP_EXIT_CODE = 79;

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

/**
 * This runner's own RAFT_PRIVACY_MODE (packages/shared/src/privacyMode.ts),
 * read once at runner start. An invalid value is a configuration error, not a
 * crash: exit EX_CONFIG so the service marks the server degraded instead of
 * restarting it every few seconds on the crash budget.
 */
export function residentPrivacyModeOrExit(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = (code) => process.exit(code),
): boolean {
  try {
    return privacyModeFromEnv(env);
  } catch (err) {
    process.stderr.write(`raft-computer: ${err instanceof Error ? err.message : String(err)}\n`);
    return exit(EX_CONFIG_EXIT_CODE);
  }
}

const defaultCoreFactory: ResidentCoreFactory = async (creds, hooks) => {
  const privacyMode = residentPrivacyModeOrExit();
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
  const liveService = await readLiveServiceSnapshot(slockHome);
  const lifecycleBridge = await prepareResidentLifecycleBridge(slockHome, creds.serverId);
  // Restarts this runner is still requesting (task #924); their outcome is
  // not proven yet.
  const inFlightRestartRequestIds = new Set<string>();
  return new coreMod.DaemonCore({
    ...residentCoreIdentity(creds),
    localTrace: true,
    // RAFT_PRIVACY_MODE, read once per runner start (residentPrivacyModeOrExit).
    privacyMode,
    processMemorySamplePath: serverRunnerMemoryPath(slockHome, creds.serverId),
    // How many agents are mid-turn, for a quiet point (Raft Desktop's Stop
    // and its move to the official install wait for it). One tiny private
    // file per server (computer/servers/<id>/activity.json).
    turnActivitySnapshotPath: serverActivityPath(slockHome, creds.serverId),
    // Reconciler step 13: the service drains this runner's agents before a
    // web upgrade's installer runs (upgradeDrain.ts).
    computerUpgradeDrainPaths: {
      requestPath: serverUpgradeDrainRequestPath(slockHome, creds.serverId),
      statePath: serverUpgradeDrainStatePath(slockHome, creds.serverId),
    },
    serviceMemorySamplePath: serviceMemoryPath(slockHome),
    lifecycleHooks: hooks,
    // CLI path resolution for the agent runtime (cliTransport):
    //   - SEA single-binary: inject the `__cli` sentinel — the agent CLI
    //     wrapper execs `<exe> __cli "$@"`, re-execing this binary in CLI mode
    //     (runBundledRaftCli). No sidecar script exists to resolve.
    //   - Bundled into a non-SEA host (e.g. the Electron menu-bar app): the
    //     daemon's relative `resolveRaftCliPath` CANNOT work — the daemon core
    //     is inlined into the host bundle, so `import.meta.url` points into
    //     the host bundle where no `cli/index.js` is adjacent. The host MUST
    //     hand us the CLI's real location via `RAFT_COMPUTER_CLI_PATH` (env is
    //     the seam: the __run child inherits it from the host process). Without
    //     it the claude driver throws `slockCliPath is required`. (task #113)
    //   - Normal node install (env unset, not SEA): leave undefined → the
    //     daemon resolves the bundled CLI dist relative to its own dist, as before.
    slockCliPath: resolveResidentSlockCliPath(isSeaBinary()),
    getComputerLastUpgradeReceipt: () => readLastRemoteUpgradeReceipt(resolveRaftHome()),
    // task #34: advisory hint that the installer needs a repair run on the machine.
    getComputerInstallerRepairHint: () => readInstallerRepairHint(resolveRaftHome()),
    // Raft Desktop moved this home from its embedded Computer: the first ready
    // to each server says so (`migratedFrom`), then the note goes (migratedFromMarker.ts).
    getComputerMigratedFrom: () => readMigratedFromForServer(resolveRaftHome(), creds.serverId),
    onComputerMigratedFromSent: () => acknowledgeMigratedFrom(resolveRaftHome(), creds.serverId),
    collectComputerDeviceSessionRetire: () => claimDeviceSessionRetireReport(resolveRaftHome()),
    collectComputerMachineLockConflicts: () => claimRunnerLockConflictReports(resolveRaftHome()),
    collectComputerUpgradeSteps: ({ relayedInReady }) =>
      collectRemoteUpgradeSteps(resolveRaftHome(), { serverId: creds.serverId, relayedInReady }),
    watchComputerUpgradeOutcome: () => watchRemoteUpgradeOutcome(resolveRaftHome(), creds.serverId),
    getComputerLifecycleAcks: lifecycleBridge.getAcknowledgements,
    getComputerLifecycleReadyAcks: lifecycleBridge.getReadyAcknowledgements,
    onComputerLifecycleReceipt: lifecycleBridge.acknowledgeReceipt,
    computerControlViaSupervisor: lifecycleBridge.supervisorMutationsAttested,
    computerServiceIpcUnreachable: lifecycleBridge.serviceIpcUnreachable,
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
      if (operationId && action === "restart") {
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
        inFlightRestartRequestIds.add(ctx.requestId);
        try {
          await requestServiceRestartViaIpc(resolveRaftHome(), {
            requestId: ctx.requestId,
            originServerId: creds.serverId,
          });
        } catch (error) {
          if (!isServiceConnectionLoss(error)) throw error;
          await awaitRestartOutcomeAfterConnectionLoss(resolveRaftHome(), creds.serverId, ctx.requestId);
        } finally {
          inFlightRestartRequestIds.delete(ctx.requestId);
        }
        return;
      }
      if (ctx.requestId) {
        // v2: launch; the successor's reconnect is the readback. An
        // installer that gives up without stopping this service leaves no
        // reconnect, so its receipt is relayed from here: the throw reaches
        // the daemon, which reports `computer:upgrade:done ok:false`.
        await requestServiceUpgradeStartViaIpc(resolveRaftHome(), {
          requestId: ctx.requestId,
          originServerId: creds.serverId,
          ...(ctx.targetVersion ? { targetVersion: ctx.targetVersion } : {}),
          ...(ctx.drain ? { drain: ctx.drain } : {}),
        });
        // received / download / installer_spawned, while this runner is still connected.
        ctx.flushUpgradeSteps?.();
        const failure = await waitForRemoteUpgradeFailureReceipt(resolveRaftHome(), ctx.requestId, {
          ...(ctx.targetVersion ? { targetVersion: ctx.targetVersion } : {}),
          // A drained upgrade spawns its installer only after the drain.
          timeoutMs: REMOTE_UPGRADE_FAILURE_WATCH_MS + (ctx.drain?.deadlineMs ?? 0),
        });
        if (failure) throw new Error(`UPGRADE_INSTALLER_FAILED: ${failure.reason ?? `installer_${failure.outcome}`}`);
        return;
      }
      console.warn(
        "[Computer] Ignoring upgrade request without requestId; " +
          "managed upgrade requires a requestId for progress and terminal readback.",
      );
    },
    onComputerRestartReconcile: async (emitDone) => {
      const slockHome = resolveRaftHome();
      const marker = await readPendingRestartMarker(slockHome);
      if (!marker) return;
      const requestId = pendingRestartRequestIdForServer(marker, creds.serverId);
      // A reconnect while this runner still waits on the handoff must not
      // report success before the takeover is proven.
      if (requestId === null || inFlightRestartRequestIds.has(requestId)) return;
      emitDone({ requestId, ok: true });
      await retirePendingRestartForServer(slockHome, marker, creds.serverId);
    },
  });
};

/**
 * Classify a per-server daemon child exit so the service's restart
 * loop can react proportionally.
 *
 *   `external-stop` — code 79 (EXTERNAL_STOP_EXIT_CODE), or killed by
 *                    SIGTERM before the runner installed its handler. The
 *                    runner was stopped by a SIGTERM the service did not
 *                    send (service-sent stops set `rec.stopping` and never
 *                    reach classification). Counts toward the crash budget
 *                    so an external killer cannot drive an endless respawn
 *                    loop; under budget it restarts like `graceful`.
 *   `graceful`     — code 0, or terminated by SIGINT. Treat as
 *                    an expected stop (service itself, or the
 *                    daemon's own clean shutdown). Don't count
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
export type { ChildExitClass } from "./lib/runnerStateMachine";

const DAEMON_ALREADY_RUNNING_RE = /Another Slock daemon is already running/i;
const DAEMON_LOCK_OWNER_PID_RE = /\bpid=(\d+)\b/;

export function parseDaemonLockConflictOwnerPid(text: string): number | null {
  const pid = DAEMON_ALREADY_RUNNING_RE.test(text) ? Number(DAEMON_LOCK_OWNER_PID_RE.exec(text)?.[1] ?? 0) : 0;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const DAEMON_LOCK_PATH_RE = /\bLock: (.+?)\. Stop the existing daemon\b/;

const DAEMON_LOCK_OWNER_STARTED_AT_RE = /\bstartedAt=([^,)\s]+)/;
const DAEMON_LOCK_OWNER_START_RE = /\bownerStart=(readable|unreadable)\b/;

/** The owner's `startedAt` a daemon's machine-lock conflict error names, if any. */
export function parseDaemonLockConflictOwnerStartedAt(text: string): string | null {
  if (!DAEMON_ALREADY_RUNNING_RE.test(text)) return null;
  return DAEMON_LOCK_OWNER_STARTED_AT_RE.exec(text)?.[1] ?? null;
}

/** Whether the conflicting daemon could read the owner pid's start; null when its error does not say (older daemon). */
export function parseDaemonLockConflictOwnerStartReadable(text: string): boolean | null {
  if (!DAEMON_ALREADY_RUNNING_RE.test(text)) return null;
  const value = DAEMON_LOCK_OWNER_START_RE.exec(text)?.[1];
  return value === undefined ? null : value === "readable";
}

/** The lock directory a daemon's machine-lock conflict error names, if any. */
export function parseDaemonLockConflictLockPath(text: string): string | null {
  if (!DAEMON_ALREADY_RUNNING_RE.test(text)) return null;
  const lockPath = DAEMON_LOCK_PATH_RE.exec(text)?.[1]?.trim();
  return lockPath ? lockPath : null;
}

export function classifyRunnerExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  diagnosticText = "",
): ChildExitClass {
  if (DAEMON_ALREADY_RUNNING_RE.test(diagnosticText)) return "already-running";
  if (code === COMPUTER_MACHINE_UNLINKED_EXIT_CODE) return "unlinked-terminal";
  if (code === EX_CONFIG_EXIT_CODE) return "config-error";
  if (code === EXTERNAL_STOP_EXIT_CODE || signal === "SIGTERM") return "external-stop";
  if (signal === "SIGINT") return "graceful";
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

/**
 * A server left the managed set (detach, sign-out): stop its runner. Only a
 * child of this service is signalled. A lock owner the service deferred to
 * (`externalPid`) is released without a signal (runnerLockConflict.ts).
 */
export async function stopUnmanagedRunner({
  slockHome,
  rec,
  emitTransition,
  writeStderr = (text) => { process.stderr.write(text); },
}: {
  slockHome: string;
  rec: RunnerRecord;
  emitTransition: Parameters<typeof releaseDeferredLockOwner>[0]["emitTransition"];
  writeStderr?: (text: string) => void;
}): Promise<void> {
  if (rec.child) {
    rec.stopping = true;
    if (rec.child.pid !== undefined) {
      writeResidentStopIntent(serverRunnerStopIntentPath(slockHome, rec.serverId), { pid: rec.child.pid, source: "service_unmanaged" });
    }
    try {
      rec.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  await releaseDeferredLockOwner({ slockHome, rec, emitTransition, writeStderr });
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
  // cleared, stopUnmanagedRunner set `stopping`) → terminal `stopped`, no restart.
  // A service already shutting down never charges an exit (see the inline
  // exit handler for the group-wide SIGTERM race).
  if (rec.stopping || shuttingDown) {
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
      lockPath: parseDaemonLockConflictLockPath(diagnosticText),
      ownerStartedAt: parseDaemonLockConflictOwnerStartedAt(diagnosticText),
      ownerStartReadable: parseDaemonLockConflictOwnerStartReadable(diagnosticText),
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

  // Crash / external stop: record toward the budget first so the threshold
  // check sees it.
  const countsTowardBudget = exitClass === "crash" || exitClass === "external-stop";
  if (countsTowardBudget) {
    try {
      await recordCrash(
        slockHome,
        serverId,
        code,
        signal,
        nowMs(),
        exitClass === "external-stop" ? "external_signal" : undefined,
      );
    } catch {
      /* health logging best-effort; never blocks recovery */
    }
  }
  const budgetBreached = countsTowardBudget ? await isDegraded(slockHome, serverId, nowMs()) : false;
  const prev = rec.lifecycle;
  const to = nextRunnerStateOnExit(exitClass, budgetBreached);
  rec.lifecycle = to;
  emitTransition(serverId, prev, to, exitTrigger(exitClass, budgetBreached));

  if (to === "degraded" && exitClass === "external-stop") {
    writeStderr(
      `Service: server ${serverId} marked degraded: its runner was repeatedly stopped by a SIGTERM ` +
        `that this Computer did not send (>=3 in 60s); skipping auto-restart. ` +
        `Check for another Computer service running on the same data directory, ` +
        `or another tool that kills processes. Then run \`raft-computer restart ${serverId}\` to try again.\n`,
    );
    return;
  }
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
  deps: {
    coreFactory?: ResidentCoreFactory;
    exit?: (code: number) => void;
    machineKeyRevokedStopDeadlineMs?: number;
  } = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  assertValidServerId(serverId);
  const slockHome = resolveRaftHome();
  const a = await readServerAttachment(slockHome, serverId);
  if (!a) {
    fail(
      "NO_ATTACHMENT",
      `No attachment for server ${serverId}. Run \`raft-computer attach ${serverId}\` first.`,
    );
  }
  const markerPath = serverConnectedMarkerPath(slockHome, a.serverId);
  // One stop per runner: a signal during the revoked stop below must not
  // start a second one (or turn its exit 77 into 0), and vice versa.
  let stopping = false;
  const hooks: ResidentLifecycleHooks = {
    onConnect: () => { writeResidentConnectedMarker(markerPath); },
    // A socket close (4004 `credential_revoked`, 4001 `computer_machine_unlinked`,
    // a deploy, a key rotation) is not proof of revocation: agents keep running
    // and the reconnect handshake decides (reconciler step 15, Q-6).
    onDisconnect: () => { try { clearResidentConnectedMarker(markerPath); } catch {} },
    onHandshakeRejected: (event) => {
      const terminalReason = classifyTerminalHandshakeRejection(event.statusCode, event.reason);
      if (!terminalReason || stopping) return;
      stopping = true;
      process.stderr.write(`raft-computer: server rejected this runner as ${terminalReason}; marking ${a.serverId} terminal, stopping its agents and stopping retries.\n`);
      void stopAfterMachineKeyRevoked({
        core,
        reason: terminalReason,
        markTerminal: () => markTerminalUnlinked(slockHome, a.serverId, a.serverMachineId, event.statusCode, terminalReason),
        exit,
        exitCode: COMPUTER_MACHINE_UNLINKED_EXIT_CODE,
        ...(deps.machineKeyRevokedStopDeadlineMs !== undefined ? { deadlineMs: deps.machineKeyRevokedStopDeadlineMs } : {}),
      });
    },
  };
  const core: ResidentCore = await (deps.coreFactory ?? defaultCoreFactory)({
    serverId: a.serverId,
    serverMachineId: a.serverMachineId,
    apiKey: a.apiKey,
    serverUrl: a.serverUrl,
  }, hooks);
  const stopIntentPath = serverRunnerStopIntentPath(slockHome, serverId);
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    // No intent = the service did not send this SIGTERM; say so in the exit
    // code so the service charges it to the crash budget instead of
    // respawning forever. (SIGINT stays 0: a terminal Ctrl-C, not a killer.)
    let exitCode = 0;
    try {
      const source = takeResidentStopIntent(stopIntentPath) ?? "external_signal";
      if (source === "external_signal" && signal === "SIGTERM") exitCode = EXTERNAL_STOP_EXIT_CODE;
      await core.stop({ source, signal });
    } finally {
      exit(exitCode);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
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
  // Reconciler step 13: a drain request left by a service that is gone
  // (crashed, or replaced while it drained) must not hold the new runners.
  try {
    const cleared = await clearUpgradeDrainRequests(slockHome, { onlyStale: true });
    if (cleared > 0) process.stderr.write(`Service startup recovery: removed ${cleared} upgrade drain request(s) left by an earlier service.\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Service startup recovery: could not remove old upgrade drain requests: ${msg}. Continuing.\n`);
  }
  // The CLI no longer autostarts at login. An auto-upgraded Mac may never run
  // `start`/`stop` again, so the first service boot of the new build deletes
  // the leftover CLI LaunchAgent file (file only; see macosLoginCarrier.ts).
  try {
    if ((await retireCliLoginCarrier(slockHome)).removed) {
      process.stderr.write("Service startup recovery: removed the retired macOS CLI login LaunchAgent.\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Service startup recovery: could not remove the retired macOS CLI login LaunchAgent: ${msg}. Continuing.\n`,
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

export interface RunServiceDeps {
  requestSelfRestart?: ReplacementHandoffRequest;
  /** task #917 seams: how the service learns it runs under systemd / an opted-in supervisor. */
  detectSystemdSupervisorFn?: typeof detectSystemdSupervisor;
  externalSupervisorOptInFn?: typeof externalSupervisorOptIn;
  systemctl?: typeof runSystemctl;
  readInstallerVersionFn?: typeof readInstallerVersion;
  /** How the supervised hand-off asks this process to shut down (default: SIGTERM to self). */
  signalSelfForRelaunch?: () => void;
  serviceSelfRestartDeps?: Omit<
    ServiceSelfRestartDeps,
    "releaseServiceOwnership" | "restoreServiceOwnership"
  >;
  serviceIdentityPublishDeps?: ServiceIdentityPublishDeps;
  isSeaBinaryFn?: typeof isSeaBinary;
  resolveKResidentBinaryFn?: unknown;
  readKRunnerHoldFn?: unknown;
  onMutationsReady?: (mutations: ServiceIpcMutations) => void | Promise<void>;
  stopAfterMutationsReady?: boolean;
  /** Device-auth §4 step 2 seam: how the background session retire is started (never awaited). */
  scheduleDeviceSessionRetireFn?: (slockHome: string) => { cancel(): void };
  shutdownServiceFn?: typeof shutdownService;
  /** Reconciler step 13 seam: the runners a web upgrade drains (default: every live runner this service supervises). */
  upgradeDrainRunnersFn?: () => UpgradeDrainRunner[];
  /** Reconciler step 13 seam: how the service waits for them (upgradeDrain.ts). */
  waitForUpgradeDrainFn?: typeof waitForUpgradeDrain;
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
  // A start while a web upgrade waits for its receipt is the installer
  // bringing up the new (or the restored) version.
  await noteServiceTransitionForRemoteUpgrade(slockHome, "service_started", COMPUTER_VERSION);
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
  // Reconciler step 13: one upgrade at a time, from its receipt to its
  // installer's spawn (a drain included). A second one is answered
  // `already-running` (Tenny Q-G: a no-op). A restart is not refused by it:
  // it replaces the service (stop·kill), and the next service's startup
  // recovery removes the drain request.
  let inFlightUpgrade: { requestId: string; targetVersion?: string; channel?: string } | null = null;
  let kRecoveryChild: ChildProcess | null = null;
  // task #917: who owns this process's lifecycle. Under systemd (or an
  // opted-in supervisor) restart and upgrade must EXIT and let the supervisor
  // relaunch; spawning our own replacement would leave a process systemd
  // either kills with the cgroup or never tracks. The record is what
  // `raft-computer start`/`stop` consult to delegate to systemctl; it is
  // cleared when we are not supervised so a stale unit never captures a
  // plain detached start.
  const systemdSupervisor: ExternalSupervisorRecord | null =
    await (deps.detectSystemdSupervisorFn ?? detectSystemdSupervisor)({ systemctl: deps.systemctl });
  if (systemdSupervisor) await writeSupervisorRecord(slockHome, systemdSupervisor).catch(() => undefined);
  else await clearSupervisorRecord(slockHome).catch(() => undefined);
  const relaunchOnExit = systemdSupervisor !== null || (deps.externalSupervisorOptInFn ?? externalSupervisorOptIn)(process.env);
  let supervisedExitCode: number | undefined;
  const requestSelfRestart = deps.requestSelfRestart ?? (relaunchOnExit
    ? (async (_expectedComputerVersion, beforeCommitExit) => {
      // Supervised hand-off: durable work first, then exit with the relaunch
      // code. No replacement is spawned; the supervisor's Restart= policy
      // brings the (possibly upgraded) binary back from the stable path.
      await beforeCommitExit?.();
      supervisedExitCode = SUPERVISED_RELAUNCH_EXIT_CODE;
      process.stderr.write(`Service: handing off to the external supervisor (exit ${SUPERVISED_RELAUNCH_EXIT_CODE}); it relaunches the service.\n`);
      const signalSelf = deps.signalSelfForRelaunch ?? (() => process.kill(process.pid, "SIGTERM"));
      const immediate = setImmediate(signalSelf);
      immediate.unref();
    })
    : ((expectedComputerVersion, beforeCommitExit) => requestServiceSelfRestart(slockHome, {
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
  })));
  const replacementHandoff = createReplacementHandoff(requestSelfRestart);
  startServiceMemorySampler(serviceMemoryPath(slockHome));

  // Strip the parent-mutation-lock marker before spawning per-server
  // `__run` daemons so the control flag never leaks into daemon /
  // runtime / agent process environments. The marker is a startup-only
  // hint for a child SUPERVISOR; daemons don't run startup recovery and
  // shouldn't observe it. Defensive even though `runResident` doesn't
  // currently read this var. See Dayu nit (msg=29336624).
  const childEnv = buildRunnerChildEnv(process.env, slockHome);

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

    // A new attempt: a lock conflict the previous one hit is no longer current.
    await clearRunnerLockConflictMarker(serverRunnerLockConflictPath(slockHome, serverId)).catch(() => undefined);
    const logPath = serverRunnerLogPath(slockHome, serverId);
    await mkdir(dirname(logPath), { recursive: true });
    // Rotate this runner's log if over the cap before the child inherits the
    // fd — bounds chatty/crash-looping runners at each (re)spawn.
    await rotateLogIfNeeded(logPath);
    const logStartOffset = await stat(logPath).then((s) => s.size, () => 0);
    const logFd = await open(logPath, "a");
    const isSea = (deps.isSeaBinaryFn ?? isSeaBinary)();
    const { command, args } = buildResidentSpawn(
      "__run", serverId, process.argv[1] ?? "", process.execArgv, isSea, liveSeaExecutablePath(),
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
        // cleared, stopUnmanagedRunner set `stopping`) → terminal `stopped`, no restart.
        // `shuttingDown` too: a group-wide SIGTERM (OS shutdown, systemd
        // control-group stop) can reach the runner before shutdownService marks
        // it stopping, and that exit must not be charged as an external stop.
        if (rec.stopping || shuttingDown) {
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


  const reconcile = async (): Promise<void> => {
    if (shuttingDown) return;
    // The external installer replaces the whole service; nothing holds
    // runners back any more.
    const holdRunnersForK = false;
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
      if (!wanted.has(id)) await stopUnmanagedRunner({ slockHome, rec, emitTransition });
    }
    if (hasPendingReadyProbe || holdRunnersForK) scheduleReconcile(RUNNER_READY_POLL_INTERVAL_MS);
  };

  scheduleReconcile = (delayMs: number): void => {
    setTimeout(() => void reconcile(), Math.max(0, delayMs));
  };

  // A remote upgrade is the external installer, launched detached so it
  // outlives this service. The outcome is the installer's receipt and the
  // live readback, not this acknowledgement.
  const upgradeStart = async (params: UpgradeStartParams): Promise<UpgradeStartResult> => {
    if (inFlightUpgrade) {
      // Q-G: a second upgrade while one is under way (draining) is a no-op;
      // the same request again is answered as itself.
      const current = inFlightUpgrade;
      return {
        status: "already-running",
        upgradeId: current.requestId,
        ...(current.targetVersion ? { targetVersion: current.targetVersion } : current.channel ? { channel: current.channel } : {}),
      };
    }
    const claim = { requestId: params.requestId, ...(params.targetVersion ? { targetVersion: params.targetVersion } : {}) };
    inFlightUpgrade = claim;
    let releaseClaim = true;
    try {
      const result = await startUpgrade(params, claim);
      if (result.status === "draining") releaseClaim = false;
      return result;
    } finally {
      if (releaseClaim && inFlightUpgrade === claim) inFlightUpgrade = null;
    }
  };
  /** The runners a drain waits for: every live runner of this service. */
  const upgradeDrainRunners = (): UpgradeDrainRunner[] => deps.upgradeDrainRunnersFn?.()
    ?? [...runners.entries()].flatMap(([serverId, record]) => {
      const pid = record.child?.pid ?? record.externalPid;
      return pid ? [{ serverId, pid }] : [];
    });
  const startUpgrade = async (params: UpgradeStartParams, claim: { requestId: string; channel?: string }): Promise<UpgradeStartResult> => {
    const upgradeId = params.requestId;
    const receivedAtMs = Date.now();
    // Reconciler step 13: the Server asked for a drain (clamped here too).
    const drain = params.scope === "remote" ? clampComputerUpgradeDrain(params.drain) : null;
    // Steps of a web upgrade go to the step log the next connected runner of
    // the origin server reports (remoteUpgradeTrace.ts); local upgrades are not traced.
    const supervisor = systemdSupervisor ? `systemd-${systemdSupervisor.scope}` : relaunchOnExit ? "external" : "none";
    const traceStep = (record: Omit<RemoteUpgradeStepRecord, "requestId" | "originServerId" | "fromVersion" | "targetVersion">) =>
      params.scope === "remote"
        ? appendRemoteUpgradeStep(slockHome, {
          requestId: upgradeId,
          originServerId: params.originServerId,
          fromVersion: COMPUTER_VERSION,
          ...(params.targetVersion ? { targetVersion: params.targetVersion } : {}),
          ...record,
        })
        : Promise.resolve();
    // No exact version means the saved channel's current release; the
    // installer resolves it and the receipt records what it became.
    const channel = params.targetVersion ? undefined : await readChannel(slockHome);
    if (channel) claim.channel = channel;
    if (params.scope === "remote") {
      await recordRemoteUpgradeLaunch(slockHome, {
        requestId: upgradeId,
        originServerId: params.originServerId,
        ...(params.targetVersion ? { targetVersion: params.targetVersion } : {}),
        ...(drain ? { drainMs: drain.deadlineMs } : {}),
      });
    }
    // task #917: the detached installer starts inside the service's systemd
    // unit, so an installer older than 0.3.21 (which stops the service through
    // `raft-computer stop`) is killed with the unit unless KillMode is
    // process|mixed. 0.3.21+ moves itself into its own scope first and stops
    // the unit with systemctl, or refuses (`held`) before stopping anything,
    // so it is let through whatever the KillMode; the installer's version is
    // only known once it is resolved, hence the check right before spawn. A
    // generic opted-in supervisor relaunches on every exit, which the
    // installer would read as "the service never stopped". Either way the
    // refusal is settled as this request's receipt so the server closes the
    // request now instead of waiting for its deadline (archer, #9526).
    const refuseUpgrade = async (reason: string, errorCode: string): Promise<never> => {
      if (params.scope === "remote") {
        await recordRemoteUpgradeRefusal(slockHome, { requestId: upgradeId, targetVersion: params.targetVersion, reason }).catch(() => undefined);
      }
      await traceStep({ step: "received", outcome: "failed", atMs: receivedAtMs, errorCode, supervisor });
      throw new ServiceClientError("UPGRADE_START_REJECTED", reason);
    };
    let killMode: string | undefined;
    let unsafeKillModeRefusal: string | null = null;
    if (systemdSupervisor) {
      const unitKillMode = await showUnitProperty(deps.systemctl ?? runSystemctl, systemdSupervisor.scope, systemdSupervisor.unit, "KillMode");
      killMode = unitKillMode ?? "unknown";
      if (unitKillMode === null || !UPGRADE_SAFE_KILL_MODES.includes(unitKillMode)) {
        unsafeKillModeRefusal = describeKillModeRequirement(systemdSupervisor.unit, unitKillMode);
      }
    } else if (relaunchOnExit) {
      await refuseUpgrade(
        "The Computer service runs under an external supervisor (RAFT_COMPUTER_EXTERNAL_SUPERVISOR) that relaunches it on every exit, "
        + "so the installer cannot stop it for an upgrade. Upgrade from the host: stop the supervisor, run `raft-computer upgrade`, start it again.",
        "external_supervisor",
      );
    }
    await traceStep({ step: "received", outcome: "ok", atMs: receivedAtMs, supervisor, ...(killMode !== undefined ? { killMode } : {}) });
    // Resolving (and, when not cached, downloading) the installer happens
    // inside the launch; `download.resolved` splits a failure between the two.
    const downloadStartedAtMs = Date.now();
    const download: InstallerDownloadStats = {};
    const installerVeto: { reason: string | null } = { reason: null };
    const vetoOldInstaller = unsafeKillModeRefusal === null ? undefined : async (command: string) => {
      const version = await (deps.readInstallerVersionFn ?? readInstallerVersion)(command);
      let escapesUnit = false;
      try { escapesUnit = version !== null && compareComputerVersions(version, UNIT_ESCAPING_INSTALLER_VERSION) >= 0; } catch { /* unparsable: treat as old */ }
      if (!escapesUnit) {
        installerVeto.reason = `${unsafeKillModeRefusal} (The installer this upgrade would use is ${version ?? "of unknown version"}; installer ${UNIT_ESCAPING_INSTALLER_VERSION} and later handle this unit without the change.)`;
        throw new ServiceClientError("UPGRADE_START_REJECTED", installerVeto.reason);
      }
    };
    // Reconciler step 13: with a drain, the installer is resolved, verified
    // and vetoed first (a refused or failed launch never drains); then every
    // runner drains, and only then is it spawned. The caller is answered
    // `draining` once the drain begins.
    let drainBegun!: () => void;
    const drainBegins = new Promise<"draining">((resolve) => { drainBegun = () => resolve("draining"); });
    const runDrain = async (): Promise<void> => {
      if (!drain || params.scope !== "remote") return;
      await traceStep({ step: "download", outcome: download.cached ? "skipped" : "ok", atMs: downloadStartedAtMs, durationMs: Date.now() - downloadStartedAtMs, bytes: download.bytes ?? 0 });
      const drainStartedAtMs = Date.now();
      const request = { requestId: upgradeId, originServerId: params.originServerId, deadlineAtMs: drainStartedAtMs + drain.deadlineMs, servicePid: process.pid };
      for (const runner of upgradeDrainRunners()) await writeUpgradeDrainRequest(slockHome, runner, request).catch(() => undefined);
      drainBegun();
      const outcome = await (deps.waitForUpgradeDrainFn ?? waitForUpgradeDrain)(slockHome, { request, runners: upgradeDrainRunners });
      await traceStep({
        step: "drain",
        outcome: "ok",
        atMs: drainStartedAtMs,
        durationMs: outcome.durationMs,
        phase: outcome.finished,
        ...(outcome.notQuietAtEnd > 0 ? { reason: `${outcome.notQuietAtEnd} agent(s) still working` } : {}),
      });
    };
    const beforeSpawn = vetoOldInstaller === undefined && !drain ? undefined : async (command: string) => {
      await vetoOldInstaller?.(command);
      await runDrain();
    };
    const launch = async (): Promise<number> => {
      let pid: number | null;
      try {
        pid = await launchInstallerDetached(slockHome, installerArgs({ targetVersion: params.targetVersion, channel }), upgradeId, undefined, download, beforeSpawn);
      } catch (error) {
        if (installerVeto.reason !== null) {
          if (params.scope === "remote") {
            await recordRemoteUpgradeRefusal(slockHome, { requestId: upgradeId, targetVersion: params.targetVersion, reason: installerVeto.reason }).catch(() => undefined);
          }
          await traceStep({ step: "download", outcome: download.cached ? "skipped" : "ok", atMs: downloadStartedAtMs, durationMs: Date.now() - downloadStartedAtMs, bytes: download.bytes ?? 0 });
          await traceStep({ step: "installer_spawned", outcome: "failed", atMs: Date.now(), errorCode: "unsafe_kill_mode", supervisor, ...(killMode !== undefined ? { killMode } : {}) });
          throw error;
        }
        const errorCode = upgradeErrorCode(error);
        if (!download.resolved) {
          await traceStep({
            step: "download",
            outcome: "failed",
            atMs: downloadStartedAtMs,
            durationMs: Date.now() - downloadStartedAtMs,
            errorCode,
            // e.g. "installer_download_failed: ECONNRESET after 3 attempts"
            reason: error instanceof Error ? error.message : String(error),
            ...(download.bytes !== undefined ? { bytes: download.bytes } : {}),
          });
        } else {
          await traceStep({ step: "installer_spawned", outcome: "failed", atMs: Date.now(), errorCode, supervisor });
        }
        throw error;
      }
      // With a drain the download step was traced when the drain began.
      if (!drain) await traceStep({ step: "download", outcome: download.cached ? "skipped" : "ok", atMs: downloadStartedAtMs, durationMs: Date.now() - downloadStartedAtMs, bytes: download.bytes ?? 0 });
      await traceStep({ step: "installer_spawned", outcome: pid === null ? "failed" : "ok", atMs: Date.now(), supervisor, ...(killMode !== undefined ? { killMode } : {}), ...(pid === null ? { errorCode: "external_installer_launch_failed" } : {}) });
      if (pid === null) throw new Error("external_installer_launch_failed");
      return pid;
    };
    const target = params.targetVersion ? { targetVersion: params.targetVersion } : { channel };
    if (!drain || params.scope !== "remote") {
      await launch();
      return { status: "started", upgradeId, ...target };
    }
    const launched = launch();
    const first = await Promise.race([launched.then(() => "started" as const), drainBegins]);
    const releaseClaim = () => { if (inFlightUpgrade?.requestId === upgradeId) inFlightUpgrade = null; };
    if (first === "started") return { status: "started", upgradeId, ...target };
    void launched.then(() => {
      releaseClaim();
      // An installer that gives up without stopping this service leaves the
      // runners holding: its failure receipt lets them go now.
      void waitForRemoteUpgradeFailureReceipt(slockHome, upgradeId, { ...(params.targetVersion ? { targetVersion: params.targetVersion } : {}) })
        .then((failure) => (failure ? clearUpgradeDrainRequests(slockHome) : 0))
        .catch(() => undefined);
    }, async (error: unknown) => {
      releaseClaim();
      // After the early answer the runner reads this outcome as the
      // request's receipt (waitForRemoteUpgradeFailureReceipt).
      const reason = `The installer could not be started after the drain: ${error instanceof Error ? error.message : String(error)}`;
      await recordRemoteUpgradeRefusal(slockHome, { requestId: upgradeId, targetVersion: params.targetVersion, reason, refusal: "launch_after_drain" }).catch(() => undefined);
      await clearUpgradeDrainRequests(slockHome).catch(() => undefined);
    });
    return { status: "draining", upgradeId, ...target };
  };
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
            ...(params.requestIds ? { requestIds: params.requestIds } : {}),
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

  // Device-auth design v2 §4 step 2: retire the device session this machine
  // once logged in with. Background and best effort: scheduled on a timer,
  // never awaited, so it cannot delay IPC, the runners or the reconcile loop.
  let deviceSessionRetire: { cancel(): void } | null = null;
  try {
    deviceSessionRetire = (deps.scheduleDeviceSessionRetireFn ?? scheduleDeviceSessionRetire)(slockHome);
  } catch {
    // never a reason to stop the service
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deviceSessionRetire?.cancel();
    await noteServiceTransitionForRemoteUpgrade(slockHome, "service_stopped", COMPUTER_VERSION);
    await (deps.shutdownServiceFn ?? shutdownService)({
      runners,
      beforeSignal: (rec, pid) =>
        writeResidentStopIntent(serverRunnerStopIntentPath(slockHome, rec.serverId), { pid, source: "service_shutdown" }),
      closeIpc: () => ipc?.close(),
      isProcessAlive,
      clearServicePidfile: () => clearPidfileAt(servicePidPath(slockHome)),
      restartRequested: replacementHandoff.requested(),
      ...(supervisedExitCode !== undefined ? { exitCode: supervisedExitCode } : {}),
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

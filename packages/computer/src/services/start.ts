// StartService — Computer domain service for `raft-computer start`
// (RFC v0.8 contract v4 §6 line 80). CLI and Electron main are both
// adapters over this surface; the service itself never touches
// process.stdout / process.stderr / process.exit.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229 / bb503633):
//   - typed StartInput + StartOptions (onEvent best-effort + AbortSignal)
//   - typed StartResult on success — carries `status` ("running" |
//     "already_running" | "spawned" | "foreground" | "aborted") so
//     post-spawn AbortSignal can return without throwing.
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6 closed-set codes preserved BYTE-IDENTICAL: NO_ATTACHMENT /
//     NOT_ATTACHED / SUPERVISOR_SPAWN_FAILED / START_DAEMON_TIMEOUT.
//     START_RUNNER_LOCK_CONFLICT (a runner held off by another daemon's
//     machine lock) is reported before that timeout.
//   - AbortSignal honored before EACH network/process boundary AND before
//     spawn. POST-SPAWN abort = no-op (returns StartResult with
//     status="aborted"). NEVER SIGKILL detached service (Hao
//     msg=7a1a2c3d product invariant: terminal close ≠ service kill,
//     UI close ≠ service kill — service lifecycle is detached
//     from any single client surface).
//   - `runService` foreground path stays as-is (long-running blocking
//     call); service emits `running` event then awaits the service loop.
//   - `formatReadySummary` stays in the ADAPTER (per liuliu msg=bb503633
//     narrow-split): the service emits a structured `ready` event with the
//     ready Map + managed targets; the adapter formats the user-visible
//     line. Keeps service env-pure.
import { describeDuplicateKeyHolder, findDuplicateKeyHolder } from "../duplicateKeyGuard";
import { releaseHeldComputerMutationLock } from "../concurrency";
import {
  clearSupervisorRecord,
  describeSupervisorUnreachable,
  inspectSupervisor,
  runSystemctl,
  showUnitProperty,
  type SupervisorInspection,
  type SystemctlRunner,
} from "../externalSupervisor";
import { detectLogindSessionRisk } from "../logindSessionRisk";
import { setTimeout as delay } from "node:timers/promises";

import { currentTimeMs } from "@botiverse/raft-shared";
import { clearPidfileAt, isProcessAlive, readPidfileAt } from "../internal/process-primitives";
import { findLiveServicePid, serviceEndpointAnswers, type ServicePidIdentityDeps } from "../internal/service-pid-fallback";
import {
  PARENT_LOCK_HELD_ENV_VAR,
  readServiceVersionEvidence,
  runService,
  spawnDetachedService,
} from "../service";
import { connectService } from "../lib/ipc-client";
import {
  describeRaftHomeConflict,
  findRaftHomeConflictFor,
  serverRunnerLockConflictPath,
  serverRunnerLogReadFallback,
  serverRunnerPidReadFallback,
  serviceLogPath,
  serviceVersionPath,
} from "../paths";
import { listAttachedServerIds, readServerAttachment, setServerManaged } from "../serverState";
import { isDegraded, readTerminalUnlinked } from "../health";
import { resetRunner } from "../reset";
import type { ComputerApiEvent } from "../lib/events";
import { ComputerServiceError } from "./errors";
import { COMPUTER_VERSION } from "../version";
import { hasUnlinkedComputerHandshake, readRunnerLogTail } from "../internal/runner-log-diagnostics";
import { collectMachineFacts } from "../machineFacts";
import { machineReadiness, type MachineReadinessReason, type StartReadinessReport } from "../machineReadiness";
import { clearRunnerLockConflictMarker, lockOwnerCheckCommand } from "../runnerLockConflict";
import {
  convergeCliHostLifecycle,
  hostLifecycleSkipped,
  type MacosHostLifecycleDeps,
} from "../macosLoginCarrier";

const START_ENSURE_TIMEOUT_MS = 15_000;
const START_ENSURE_POLL_INTERVAL_MS = 100;
const SERVICE_IDENTITY_SETTLE_ATTEMPTS = 20;
const SERVICE_IDENTITY_SETTLE_POLL_MS = 100;
const inFlightStartByHome = new Map<string, Promise<StartResult>>();

export interface StartInput {
  /** Optional: start one attached server without changing other managed
   *  servers. When omitted, all attached servers are marked managed. */
  serverId?: string | null;
  /** Optional: original user-typed slug ("/alpha") used for
   *  user-visible labels and error messages. Service uses this only to
   *  echo back into structured events; the adapter renders it. */
  serverLabel?: string | null;
  /** When true, runService() runs inline in the calling process.
   *  When false (default), the service is spawned detached. */
  foreground?: boolean;
  /** The Computer install root to manage. Required: env resolution lives at
   *  `createComputerApi` construction so mutations can't silently regress to
   *  ambient `~/.slock`. (#wg-raft-computer:f2a02081 BUG 3 sweep.) */
  slockHome: string;
  /** Which durable host-lifecycle owner this caller represents. Internal
   *  callers/tests may use `none`; CLI and Electron adapters must be explicit. */
  hostLifecycleOwner?: "cli" | "app" | "none";
}

export type StartStatus =
  | "running"          // foreground service loop returned (ran to completion / was Ctrl-C'd)
  | "already_running"  // existing service pidfile alive; daemons reconciled
  | "spawned"          // detached service spawned + all managed daemons ready
  | "aborted";         // post-spawn AbortSignal: spawn already committed, service still running

export interface StartResult {
  status: StartStatus;
  /** Managed set for this start invocation (single id when serverId
   *  was set; full attached set otherwise). */
  managedTargets: string[];
  /** Total number of attached servers at the moment of start (includes
   *  managedTargets when start was global). */
  attachedCount: number;
  /** Map of serverId → daemon pid for daemons confirmed ready before
   *  return. Empty when status === "running" (foreground); on
   *  status === "aborted" reflects whatever was ready at the moment
   *  the abort was observed. */
  ready: Map<string, number>;
  /** Pid of the (newly spawned OR existing) service when known.
   *  null for status === "running" (the calling process IS the
   *  service in foreground mode). */
  servicePid: number | null;
  /** Path of the service's combined log (for adapter "Logs: …" line). */
  serviceLogPath: string;
}

export interface StartDeps extends ServicePidIdentityDeps {
  /** Test seams (default to module-level real impls). Mirrors the
   *  pre-extraction `RunStartDeps` shape so existing service.test.ts
   *  test cases keep working through the adapter. */
  spawnDetachedService?: typeof spawnDetachedService;
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  sleep?: (ms: number) => Promise<void>;
  ensureTimeoutMs?: number;
  ensurePollIntervalMs?: number;
  /**
   * When some managed runners are ready and the rest are not by the deadline,
   * succeed (event `start.partial_ready`) instead of START_DAEMON_TIMEOUT.
   * Set only for the external installer, which judges an upgrade by this exit
   * code: a machine still registered on a server it can no longer reach never
   * has that runner ready, and the installer rolled back working upgrades
   * (88602a54, 9e56ad23, 2026-11-02). Only runners alive and merely not
   * connected, or held off by another daemon's machine lock, are excused
   * (acceptsPartialReady); none ready still fails.
   */
  acceptPartialReady?: boolean;
  /**
   * Told what the readiness wait saw, once, just before the start succeeds or
   * fails on it. Best-effort: a throw here never changes the start.
   */
  onReadiness?: (report: StartReadinessReport) => void;
  /** Foreground service loop. Default: real `runService`. */
  runService?: typeof runService;
  /** Test seam for explicit start/restart retry recovery. */
  resetRunnerRecoveryState?: typeof resetRunnerRecoveryStateViaServiceOrDisk;
  /** Abort the pre-spawn/wait path if the caller loses its mutation lock. */
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
  /** task #914: refuses to spawn when another live service on this host holds the same machine key. */
  findDuplicateKeyHolder?: typeof findDuplicateKeyHolder;
  /** task #917 seams: the systemd unit (if any) that owns the service, and systemctl. */
  inspectSupervisor?: (slockHome: string) => Promise<SupervisorInspection | null>;
  systemctl?: SystemctlRunner;
  /**
   * task #917: the foreground loop releases the calling command's mutation
   * lock once the service has run startup recovery (just before it owns the
   * IPC endpoint), so `stop`/`start` from another process are not refused
   * with CONCURRENT_OPERATION for the service's whole lifetime. Default:
   * release the lock this process holds for `slockHome`, if any.
   */
  releaseMutationLock?: (slockHome: string) => Promise<unknown>;
  /** task #915: refuses when both default homes hold Raft data and no RAFT_HOME picks one. */
  findRaftHomeConflict?: typeof findRaftHomeConflictFor;
  /** task #37: whether a detached service started here stops when the login session ends. */
  detectLogindSessionRisk?: typeof detectLogindSessionRisk;
}

export interface StartOptions extends StartDeps {
  onEvent?: (event: ComputerApiEvent) => void;
}

function emit(opts: StartOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault
    // break the start flow.
  }
}

async function readStartReadiness(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
  servicePid?: number,
) {
  const facts = await collectMachineFacts(slockHome, {
    runnerServerIds: serverIds,
    readPidfile: opts.readPidfile ?? readPidfileAt,
    isAlive: opts.isProcessAlive ?? isProcessAlive,
  });
  return machineReadiness(facts, {
    targetServerIds: serverIds,
    expectedVersion: COMPUTER_VERSION,
    ...(servicePid !== undefined ? { servicePid } : {}),
  });
}

type LockConflictReason = Extract<MachineReadinessReason, { code: "runner-lock-conflict" }>;

function lockConflictsOf(reasons: readonly MachineReadinessReason[]): LockConflictReason[] {
  return reasons.filter((reason): reason is LockConflictReason => reason.code === "runner-lock-conflict");
}

interface ManagedDaemonWait {
  ready: Map<string, number>;
  /** Runners the service reported held off by another daemon's machine lock. */
  lockConflicts: LockConflictReason[];
  /** Why each runner still missing was not ready, at the wait's last read. */
  reasons: readonly MachineReadinessReason[];
}

/**
 * Wait until every managed runner is ready or the deadline passes. A runner
 * held off by another daemon's machine lock will not become ready on its own,
 * so the wait ends early on one: at once for a person's start (which fails on
 * it), and once every runner still missing is one under `acceptPartialReady`.
 */
async function waitForManagedDaemonPids(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
  servicePid: number,
  observeAbort = true,
): Promise<ManagedDaemonWait> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.ensureTimeoutMs ?? START_ENSURE_TIMEOUT_MS;
  const pollIntervalMs = opts.ensurePollIntervalMs ?? START_ENSURE_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let ready = new Map<string, number>();
  const throwIfAborted = (): void => {
    if (observeAbort) opts.signal?.throwIfAborted?.();
  };

  for (;;) {
    throwIfAborted();
    const verdict = await readStartReadiness(slockHome, serverIds, opts, servicePid);
    ready = new Map(verdict.runnerPids);
    if (verdict.ready) {
      throwIfAborted();
      return { ready, lockConflicts: [], reasons: [] };
    }
    const lockConflicts = lockConflictsOf(verdict.reasons);
    if (lockConflicts.length > 0 && (!opts.acceptPartialReady || lockConflicts.length === verdict.reasons.length)) {
      return { ready, lockConflicts, reasons: verdict.reasons };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ready, lockConflicts, reasons: verdict.reasons };
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

/** A starting service publishes its pidfile before its version evidence
 * (`publishServiceIdentityAfterIpcBind`), so a `start` that polls the pidfile
 * can see the new pid beside the previous service's evidence, or beside none.
 * That is publication in progress, not skew: re-read a bounded number of times
 * before judging. A matching pid with a different version is never retried. */
async function readSettledServiceVersionEvidence(
  slockHome: string,
  servicePid: number,
  opts: StartOptions,
) {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  let evidence = await readServiceVersionEvidence(slockHome);
  for (
    let attempt = 0;
    attempt < SERVICE_IDENTITY_SETTLE_ATTEMPTS
      && (evidence === null || evidence.pid !== servicePid);
    attempt += 1
  ) {
    opts.signal?.throwIfAborted?.();
    await sleep(SERVICE_IDENTITY_SETTLE_POLL_MS);
    evidence = await readServiceVersionEvidence(slockHome);
  }
  return evidence;
}

async function assertNoServiceVersionSkew(
  slockHome: string,
  servicePid: number,
  opts: StartOptions,
): Promise<void> {
  const evidence = await readSettledServiceVersionEvidence(slockHome, servicePid, opts);
  if (!evidence) {
    throw new ComputerServiceError(
      "SERVICE_VERSION_SKEW_SUSPECT",
      `A Raft Computer service is already running (pid ${servicePid}), but this app/CLI could not verify its version from ${serviceVersionPath(slockHome)}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
    );
  }
  if (evidence.pid !== servicePid) {
    throw new ComputerServiceError(
      "SERVICE_VERSION_SKEW_SUSPECT",
      `A Raft Computer service is already running (pid ${servicePid}), but this app/CLI found version evidence for a different process (pid ${evidence.pid}) at ${serviceVersionPath(slockHome)}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
    );
  }
  if (evidence.version === null || evidence.version === COMPUTER_VERSION) return;

  throw new ComputerServiceError(
    "SERVICE_VERSION_SKEW",
    `A Raft Computer service from version ${evidence.version} is already running (pid ${servicePid}), but this app/CLI is version ${COMPUTER_VERSION}. Restart the Computer service from the current app/CLI, then try again. Run \`raft-computer restart\` or quit and reopen Raft Desktop.`,
  );
}

async function resetRunnerRecoveryStateViaServiceOrDisk(
  slockHome: string,
  serverId: string,
  existingServicePid: number | null,
): Promise<void> {
  if (existingServicePid === null) {
    await resetRunner(slockHome, serverId);
    return;
  }

  let client: Awaited<ReturnType<typeof connectService>> | null = null;
  try {
    client = await connectService(slockHome);
    await client.request("reset-runner", { serverId });
  } finally {
    await client?.close();
  }
}

async function clearDegradedRecoveryStateForStart(
  slockHome: string,
  serverIds: string[],
  existingServicePid: number | null,
  opts: StartOptions,
): Promise<void> {
  const reset = opts.resetRunnerRecoveryState ?? resetRunnerRecoveryStateViaServiceOrDisk;
  const nowMs = Date.now();
  for (const serverId of serverIds) {
    opts.signal?.throwIfAborted?.();
    if (await isDegraded(slockHome, serverId, nowMs)) {
      opts.signal?.throwIfAborted?.();
      await reset(slockHome, serverId, existingServicePid);
    }
  }
}

function buildTerminalUnlinkedMessage(slockHome: string, serverId: string, label: string): string {
  return (
    `Cannot start ${label}: the server rejected the saved Computer runner state as computer_machine_unlinked. ` +
    `The server has unlinked or deleted this Computer/machine, so retrying would keep failing. ` +
    `Run \`raft-computer setup ${label}\` to recover/rebind this Computer, then verify with \`raft-computer status ${label}\`. ` +
    `Diagnostics are available in ${serverRunnerLogReadFallback(slockHome, serverId)[0]} if support asks for them.`
  );
}

/**
 * Drop attachments the server has terminally unlinked from an unscoped start.
 * One unlinked server must not keep the rest offline: the upgrade engine
 * restarts the service with an unscoped `start`, so refusing here fails both
 * the candidate start and the rollback. A scoped start of an unlinked server,
 * or an unscoped start where every target is unlinked, still refuses.
 */
async function selectStartableTargets(
  slockHome: string,
  serverIds: string[],
  input: StartInput,
): Promise<{ startable: string[]; unlinked: string[] }> {
  const startable: string[] = [];
  const unlinked: string[] = [];
  for (const serverId of serverIds) {
    const attachment = await readServerAttachment(slockHome, serverId);
    if (await readTerminalUnlinked(slockHome, serverId, attachment?.serverMachineId ?? null)) {
      unlinked.push(serverId);
    } else {
      startable.push(serverId);
    }
  }
  if (unlinked.length > 0 && (input.serverId || startable.length === 0)) {
    const serverId = unlinked[0]!;
    const label = input.serverId === serverId ? input.serverLabel ?? serverId : serverId;
    throw new ComputerServiceError(
      "COMPUTER_MACHINE_UNLINKED",
      buildTerminalUnlinkedMessage(slockHome, serverId, label),
    );
  }
  return { startable, unlinked };
}

/**
 * Forget the runner pids (and lock-conflict records) an earlier service wrote:
 * the service about to start has no runner yet. A runner that outlived its
 * service still holds the daemon machine lock, so the new service's runner
 * meets that lock and the service records that pid again
 * (runnerLockConflict.ts). The connected marker stays: only the runner itself
 * writes it, so nothing would bring back the one such a runner wrote.
 */
async function clearRunnerRecordsLeftByEarlierService(slockHome: string, serverIds: readonly string[]): Promise<void> {
  for (const serverId of serverIds) {
    for (const pidfile of serverRunnerPidReadFallback(slockHome, serverId)) await clearPidfileAt(pidfile);
    await clearRunnerLockConflictMarker(serverRunnerLockConflictPath(slockHome, serverId)).catch(() => undefined);
  }
}

/**
 * The runner exited because another process holds this machine key's daemon
 * lock, and the service deferred to it. Say who holds it and how to tell
 * whether it is really a Raft daemon: on Windows a pid can belong to an
 * unrelated program by now. `serviceStopped` (doctor, after a stop): no
 * service is deferring to anything; the lock's holder is all that is known.
 */
export function buildLockConflictMessage(
  slockHome: string,
  conflicts: readonly LockConflictReason[],
  input: Pick<StartInput, "serverId" | "serverLabel">,
  serviceStopped = false,
): string {
  const conflict = conflicts[0]!;
  const label = input.serverId === conflict.serverId ? input.serverLabel ?? conflict.serverId : conflict.serverId;
  const lock = conflict.lockPath ? ` Lock: ${conflict.lockPath}.` : "";
  const others = conflicts.length > 1
    ? ` Also blocked: ${conflicts.slice(1).map((other) => other.serverId).join(", ")}.`
    : "";
  const logs = `Inspect ${serviceLogPath(slockHome)} and ${serverRunnerLogReadFallback(slockHome, conflict.serverId)[0]} for details.`;
  if (conflict.ownerPid === null) {
    return (
      `Cannot start ${label}: its runner found this machine's daemon lock held, but no live owner could be identified, ` +
      `so the Computer service is not retrying it.${lock}${others} ` +
      `Make sure no other Raft daemon or Computer runs with this machine key, then run \`raft-computer restart\`.` +
      (conflict.lockPath ? ` If it still reports this lock, delete ${conflict.lockPath} and restart again.` : "") +
      ` ${logs}`
    );
  }
  const pid = conflict.ownerPid;
  const check = lockOwnerCheckCommand(pid);
  // A restart alone can meet the same lock: the daemon keeps a lock held
  // whenever it cannot prove the owner is gone (a lock from an older daemon
  // on Linux, an owner start time it cannot read).
  return (
    (serviceStopped
      ? `The Computer service is not running, and pid ${pid} holds this machine's daemon lock: it could not be confirmed as ${label}'s runner.`
      : `Cannot start ${label}: pid ${pid} holds this machine's daemon lock, ` +
        `so the Computer service is deferring to it instead of starting its own runner.`) +
    `${lock}${others} ` +
    `Check whether pid ${pid} is really a Raft daemon with ${check}. ` +
    `If it is, stop that daemon first; if it is another program (the daemon that held the lock is gone and its pid was reused), ` +
    `run \`raft-computer restart\` to start this server's runner again.` +
    (conflict.lockPath
      ? ` Once you have confirmed pid ${pid} is not a Raft daemon, you can delete ${conflict.lockPath}: a restart alone may meet the same lock (on Linux, or when the daemon cannot read that pid's start time).`
      : "") +
    ` ${logs}`
  );
}

async function buildTimeoutMessage(
  slockHome: string,
  serverIds: string[],
  ready: Map<string, number>,
  input: StartInput,
): Promise<string> {
  const missing = serverIds.filter((id) => !ready.has(id));
  for (const serverId of missing) {
    const logTail = await readRunnerLogTail(serverRunnerLogReadFallback(slockHome, serverId));
    if (!hasUnlinkedComputerHandshake(logTail)) continue;

    const label = input.serverId === serverId ? input.serverLabel ?? serverId : serverId;
    return (
      `Timed out waiting for ${label} to start because the server rejected this Computer as ` +
      `computer_machine_unlinked. The server has unlinked or deleted this Computer/machine; ` +
      `run \`raft-computer setup ${label}\` to reconnect, then verify with \`raft-computer status ${label}\`. Inspect ${serviceLogPath(slockHome)} and ` +
      `${serverRunnerLogReadFallback(slockHome, serverId)[0]} for details.`
    );
  }

  const target =
    input.serverId && missing.length === 1
      ? `${input.serverLabel ?? input.serverId}`
      : `${missing.length} server runner(s): ${missing.join(", ")}`;
  const runnerLogPaths = missing.map(
    (serverId) => serverRunnerLogReadFallback(slockHome, serverId)[0],
  );
  return (
    `Timed out waiting for ${target} to start. Run \`raft-computer status\` and inspect ` +
    `${serviceLogPath(slockHome)} plus per-server runner logs: ${runnerLogPaths.join(", ")}.`
  );
}

export async function start(input: StartInput, options: StartOptions = {}): Promise<StartResult> {
  const prior = inFlightStartByHome.get(input.slockHome);
  if (prior) {
    try {
      await prior;
    } catch {
      // The waiting caller re-runs the start path below and reports its own
      // result/error against the current filesystem state.
    }
  }

  const current = startInner(input, options);
  inFlightStartByHome.set(input.slockHome, current);
  try {
    return await current;
  } finally {
    if (inFlightStartByHome.get(input.slockHome) === current) {
      inFlightStartByHome.delete(input.slockHome);
    }
  }
}

async function startInner(input: StartInput, options: StartOptions = {}): Promise<StartResult> {
  options.signal?.throwIfAborted?.();
  const { slockHome } = input;

  // task #915: before reading anything under the resolved home, make sure it
  // is not a guess between two homes that both hold Raft data.
  const homeConflict = (options.findRaftHomeConflict ?? findRaftHomeConflictFor)(slockHome);
  if (homeConflict) {
    throw new ComputerServiceError("RAFT_HOME_AMBIGUOUS", describeRaftHomeConflict(homeConflict));
  }

  // 1. Validate attached set — service-axis throw, byte-identical message.
  const attached = await listAttachedServerIds(slockHome);
  options.signal?.throwIfAborted?.();
  if (attached.length === 0) {
    throw new ComputerServiceError(
      "NO_ATTACHMENT",
      "No server attachments yet. Run `raft-computer attach /<serverSlug>` first.",
    );
  }
  if (input.serverId && !attached.includes(input.serverId)) {
    throw new ComputerServiceError(
      "NOT_ATTACHED",
      `Not attached to server ${input.serverId}. Run \`raft-computer attach ${input.serverId}\` first or omit the argument.`,
    );
  }

  // 2. Decide start targets + write managed.flag for each target.
  // Contract v4 §6 line 80: pre-spawn write so the service's first
  // reconcile picks up the correct managed intent. Scoped start is additive:
  // it must not clear another server that the user already brought online.
  // Use `stop <server>` to clear that server's managed intent explicitly.
  const requestedTargets = input.serverId ? [input.serverId] : attached;
  emit(options, {
    kind: "start.starting",
    managedTargets: requestedTargets,
    attachedCount: attached.length,
    foreground: !!input.foreground,
  });

  const { startable: managedTargets, unlinked } = await selectStartableTargets(
    slockHome,
    requestedTargets,
    input,
  );
  if (unlinked.length > 0) {
    emit(options, { kind: "start.skipped_unlinked", serverIds: unlinked });
  }
  options.signal?.throwIfAborted?.();

  for (const id of managedTargets) {
    options.signal?.throwIfAborted?.();
    await setServerManaged(slockHome, id);
  }

  // The CLI no longer autostarts at login: this only removes a leftover macOS
  // LaunchAgent from older releases and records the owner. It never starts
  // the service (step 3 below does) and a failure never blocks the start.
  if ((input.hostLifecycleOwner ?? "none") !== "none") {
    try {
      await (options.convergeHostLifecycle ?? convergeCliHostLifecycle)(
        slockHome,
        "enabled",
        options.hostLifecycleDeps ?? {},
      );
    } catch (error) {
      emit(options, hostLifecycleSkipped("start", error));
    }
    options.signal?.throwIfAborted?.();
  }

  // 3. Idempotent live-service pidfile check. Walk the on-disk
  //    layout migration window (current `run/service.pid` → legacy
  //    `service.pid` → legacy `supervisor.pid`) by liveness. Picking by
  //    readability alone would let a stale current pidfile shadow a
  //    still-live legacy service: a new CLI would see "no service" and
  //    spawn a second one alongside the legacy. Service is one-per-
  //    Computer (RFC v9.8 §1) — the symmetry has to hold across stop /
  //    upgrade / start / status. The helper clears stale candidates in
  //    place so they do not haunt later reads.
  //    A live pid that is another program (the service ended with its
  //    sign-in session and its pid was reused) is such a stale candidate:
  //    not "already running", so the start goes on and spawns the service.
  const { pid: existing } = await findLiveServicePid(slockHome, {
    readPidfile: options.readPidfile,
    isProcessAlive: options.isProcessAlive,
    endpointAnswers: options.endpointAnswers,
    processStartTimeMs: options.processStartTimeMs,
  });
  options.signal?.throwIfAborted?.();
  await clearDegradedRecoveryStateForStart(slockHome, managedTargets, existing, options);
  options.signal?.throwIfAborted?.();
  if (existing !== null) {
    await assertNoServiceVersionSkew(slockHome, existing, options);
    options.signal?.throwIfAborted?.();
    emit(options, {
      kind: "start.already_running",
      servicePid: existing,
      managedTargets,
      attachedCount: attached.length,
    });
    const waitStartedAtMs = Date.now();
    const wait = await waitForManagedDaemonPids(slockHome, managedTargets, options, existing);
    const { ready, lockConflicts } = wait;
    const notReady = ready.size === managedTargets.length ? null : await acceptsPartialReady(slockHome, options, ready, managedTargets, existing);
    reportStartReadiness(options, managedTargets, wait, {
      partial: notReady !== null,
      unlinked: unlinked.length,
      waitedMs: Date.now() - waitStartedAtMs,
    });
    if (ready.size !== managedTargets.length && !notReady) {
      if (lockConflicts.length > 0) {
        throw new ComputerServiceError("START_RUNNER_LOCK_CONFLICT", buildLockConflictMessage(slockHome, lockConflicts, input));
      }
      const message = await buildTimeoutMessage(slockHome, managedTargets, ready, input);
      options.signal?.throwIfAborted?.();
      throw new ComputerServiceError(
        "START_DAEMON_TIMEOUT",
        message,
      );
    }
    emit(options, notReady
      ? { kind: "start.partial_ready", ready, managedTargets, notReady }
      : { kind: "start.ready", ready, managedTargets });
    return {
      status: "already_running",
      managedTargets,
      attachedCount: attached.length,
      ready,
      servicePid: existing,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // task #914: a second service holding the same machine key on this host
  // (an old install root still running, a stop that did not stop) is a second
  // daemon on the same key; the server would send commands to either. Refuse
  // before either start path (foreground loop or detached spawn) runs, and
  // name the holder. Same-root duplicates were handled above (already_running).
  const duplicateHolder = await (options.findDuplicateKeyHolder ?? findDuplicateKeyHolder)(slockHome);
  if (duplicateHolder) {
    throw new ComputerServiceError("DUPLICATE_KEY_HOLDER", describeDuplicateKeyHolder(duplicateHolder));
  }

  // No service runs, so nothing supervises a runner: what runner.pid says was
  // left by an earlier service, and a live pid in it with the old runner's
  // evidence and connected marker would answer the first readiness poll below
  // "ready" before the new service has started anything (after a Windows
  // sign-out that pid is another program). Cleared here, not by the service:
  // this command polls as soon as the service is spawned, before it has booted.
  if (!(await (options.endpointAnswers ?? serviceEndpointAnswers)(slockHome))) {
    await clearRunnerRecordsLeftByEarlierService(slockHome, attached);
  }

  // 4. Foreground path: run the service loop inline. Service emits
  // `running` event, then yields control to runService (which blocks
  // until SIGTERM / Ctrl-C). On return, we report status="running" with
  // an empty `ready` map (foreground service is its own observer).
  if (input.foreground) {
    options.signal?.throwIfAborted?.();
    emit(options, {
      kind: "start.running",
      managedTargets,
      attachedCount: attached.length,
    });
    const service = options.runService ?? runService;
    const previousParentLockMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    process.env[PARENT_LOCK_HELD_ENV_VAR] = "1";
    const releaseMutationLock = options.releaseMutationLock ?? releaseHeldComputerMutationLock;
    try {
      await service({
        // Startup recovery (which honours the parent-lock marker) has run by
        // the time the mutation surface exists; from here the service, not
        // the command, is the single writer.
        onMutationsReady: async () => {
          await releaseMutationLock(slockHome);
          // The marker told startup recovery that the parent held the lock;
          // once released it must not be inherited by anything the service
          // launches later (the installer, a replacement), or they would skip
          // their own stale-lock cleanup (archer).
          delete process.env[PARENT_LOCK_HELD_ENV_VAR];
        },
      });
    } finally {
      if (previousParentLockMarker === undefined) delete process.env[PARENT_LOCK_HELD_ENV_VAR];
      else process.env[PARENT_LOCK_HELD_ENV_VAR] = previousParentLockMarker;
    }
    return {
      status: "running",
      managedTargets,
      attachedCount: attached.length,
      ready: new Map(),
      servicePid: null,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // 5. Background path: Computer's detached service is the canonical owner
  // on every OS. Legacy launchd/systemd/Task Scheduler definitions are
  // deliberately ignored and left byte-for-byte untouched.
  // Pre-spawn AbortSignal check (last opportunity
  // before we commit to a detached process). After spawn, the service
  // is detached + has its own lifecycle — abort becomes a no-op.
  options.signal?.throwIfAborted?.();

  // task #917: a systemd unit that exists for this install root owns the
  // service. Starting beside it would leave a process systemd does not track
  // and the next boot's unit start would collide with the duplicate-key guard.
  // Delegation keys on the unit EXISTING (loaded), not on a live pid: after
  // `systemctl stop` the unit is inactive and `raft-computer start` must still
  // go through it. A unit file that is gone makes the record stale: clear it
  // and fall through to the detached spawn.
  let pid: number;
  const supervision = await (options.inspectSupervisor ?? ((home: string) => inspectSupervisor(home, { systemctl: options.systemctl })))(slockHome);
  if (supervision && !supervision.reachable) {
    throw new ComputerServiceError(
      "START_SUPERVISOR_UNREACHABLE",
      describeSupervisorUnreachable(supervision.record, "systemctl did not answer"),
    );
  }
  if (supervision && supervision.unitLoaded) {
    const systemctl = options.systemctl ?? runSystemctl;
    const { scope, unit } = supervision.record;
    // The unit runs its own `raft-computer start --foreground`, a separate
    // process that takes the mutation lock itself (systemd passes it no
    // parent-lock marker). Holding the lock here would make that process
    // wait it out, fail with CONCURRENT_OPERATION, and only come up on
    // systemd's RestartSec retry after this command's readiness deadline:
    // every `restart` on a systemd-supervised Linux Computer exited
    // START_DAEMON_TIMEOUT (#proj-raft-computer:#59, hetzner-ax42-1). Hand
    // the lock over first, as the foreground path does once mutations are
    // ready; from here this command only reads readiness.
    await (options.releaseMutationLock ?? releaseHeldComputerMutationLock)(slockHome);
    const result = await systemctl(scope, ["start", unit]);
    if (result.code !== 0) {
      throw new ComputerServiceError(
        "START_SUPERVISOR_FAILED",
        describeSupervisorUnreachable(supervision.record, `\`systemctl start ${unit}\` exited ${result.code ?? "without a code"}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`),
      );
    }
    const mainPid = await showUnitProperty(systemctl, scope, unit, "MainPID");
    pid = Number(mainPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new ComputerServiceError(
        "START_SUPERVISOR_FAILED",
        describeSupervisorUnreachable(supervision.record, `the unit reports no main process after start (MainPID=${mainPid ?? "unknown"})`),
      );
    }
  } else {
    if (supervision) await clearSupervisorRecord(slockHome).catch(() => undefined);
    // task #37: the detached service stays in the caller's login session
    // scope; say so when logind will stop that scope at logout. Advisory only.
    const sessionRisk = await (options.detectLogindSessionRisk ?? detectLogindSessionRisk)().catch(() => null);
    if (sessionRisk) emit(options, { kind: "start.logind_session_risk", risk: sessionRisk });
    try {
      pid = await (options.spawnDetachedService ?? spawnDetachedService)(slockHome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ComputerServiceError("SUPERVISOR_SPAWN_FAILED", msg, err);
    }
  }

  emit(options, {
    kind: "start.spawned",
    servicePid: pid,
    managedTargets,
    attachedCount: attached.length,
    ...(supervision?.unitLoaded ? { supervisorUnit: supervision.record.unit } : {}),
  });

  // 6. Post-spawn abort check. Spawn already committed; the detached
  // service is the canonical owner from this point on. NEVER SIGKILL
  // — terminal close / UI close / Electron quit must all leave the
  // service running (Hao msg=7a1a2c3d product invariant).
  if (options.signal?.aborted) {
    const ready = await pollReadyOnce(slockHome, managedTargets, options);
    emit(options, { kind: "start.aborted", servicePid: pid, managedTargets, ready });
    return {
      status: "aborted",
      managedTargets,
      attachedCount: attached.length,
      ready,
      servicePid: pid,
      serviceLogPath: serviceLogPath(slockHome),
    };
  }

  // 7. Wait for all managed daemons to reach ready state.
  const waitStartedAtMs = Date.now();
  const wait = await waitForManagedDaemonPids(slockHome, managedTargets, options, pid, false);
  const { ready, lockConflicts } = wait;
  const notReady = ready.size === managedTargets.length ? null : await acceptsPartialReady(slockHome, options, ready, managedTargets, pid);
  reportStartReadiness(options, managedTargets, wait, {
    partial: notReady !== null,
    unlinked: unlinked.length,
    waitedMs: Date.now() - waitStartedAtMs,
  });
  if (ready.size !== managedTargets.length && !notReady) {
    if (lockConflicts.length > 0) {
      throw new ComputerServiceError("START_RUNNER_LOCK_CONFLICT", buildLockConflictMessage(slockHome, lockConflicts, input));
    }
    throw new ComputerServiceError(
      "START_DAEMON_TIMEOUT",
      await buildTimeoutMessage(slockHome, managedTargets, ready, input),
    );
  }

  emit(options, notReady
    ? { kind: "start.partial_ready", ready, managedTargets, notReady }
    : { kind: "start.ready", ready, managedTargets });
  return {
    status: "spawned",
    managedTargets,
    attachedCount: attached.length,
    ready,
    servicePid: pid,
    serviceLogPath: serviceLogPath(slockHome),
  };
}

/** Hand `onReadiness` what the wait's last read saw: the facts this start succeeds or fails on. */
function reportStartReadiness(
  options: StartOptions,
  managedTargets: string[],
  wait: ManagedDaemonWait,
  detail: Pick<StartReadinessReport, "partial" | "unlinked" | "waitedMs">,
): void {
  if (!options.onReadiness) return;
  try {
    const notReady: StartReadinessReport["notReady"] = {};
    for (const reason of wait.reasons) notReady[reason.code] = (notReady[reason.code] ?? 0) + 1;
    options.onReadiness({ targets: managedTargets.length, ready: wait.ready.size, notReady, ...detail });
  } catch {
    // Telemetry only.
  }
}

/**
 * Whether a start whose runners are not all ready may still succeed: only with
 * `acceptPartialReady`, at least one runner ready, and every missing runner
 * alive at this version but not connected (`runner-disconnected`), which is
 * what a registration on an unreachable server looks like (runners never stop
 * reconnecting), or held off by another daemon's machine lock
 * (`runner-lock-conflict`), which this upgrade cannot resolve and rolling it
 * back would not either. A missing, unattested or wrong-version runner is a
 * fault of this version, and still fails the start.
 */
async function acceptsPartialReady(
  slockHome: string,
  options: StartOptions,
  ready: Map<string, number>,
  managedTargets: string[],
  servicePid: number,
): Promise<string[] | null> {
  if (!options.acceptPartialReady || ready.size === 0) return null;
  const verdict = await readStartReadiness(slockHome, managedTargets, options, servicePid);
  const missing = verdict.reasons.filter((reason) => !ready.has(reason.serverId));
  if (
    missing.length === 0 ||
    missing.some((reason) => reason.code !== "runner-disconnected" && reason.code !== "runner-lock-conflict")
  ) {
    return null;
  }
  return managedTargets.filter((id) => !ready.has(id));
}

/** One non-blocking sweep of the shared runner readiness facts. Used on post-spawn
 *  abort to capture whatever became ready before the abort fired,
 *  without paying the full poll-loop deadline. */
async function pollReadyOnce(
  slockHome: string,
  serverIds: string[],
  opts: StartOptions,
): Promise<Map<string, number>> {
  const verdict = await readStartReadiness(slockHome, serverIds, opts);
  return new Map(verdict.runnerPids);
}

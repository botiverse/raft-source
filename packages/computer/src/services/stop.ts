// StopService — Computer domain service for `raft-computer stop`
// (RFC v0.8 contract v4 §6 line 80, root service stop). CLI and
// Electron main are both adapters over this surface; the service itself
// never touches process.stdout / process.stderr / process.exit.
//
// Shape (Hao msg=51a17400 + liuliu msg=7a1a2c3d / 35034229 / 240069cd /
// bb503633):
//   - typed StopInput + StopOptions (onEvent best-effort + AbortSignal)
//   - typed StopResult on success — carries `status`
//     ("not_running" | "stale_pidfile_cleared" | "stopped") so adapters
//     can render the three idempotent terminal lines without re-reading
//     the pidfile.
//   - typed `ComputerServiceError { code, message, cause? }` thrown on
//     failure; cause retained in-process only — adapters MUST NOT forward it.
//   - §6 closed-set codes preserved BYTE-IDENTICAL: STOP_SIGNAL_FAILED /
//     STOP_TIMEOUT (source-walked service.ts runStop before commit
//     per closed-set rule a — 2 codes confirmed via grep, NOT a forward-
//     frame estimate).
//   - StopService is the LEGITIMATE process.kill(SIGTERM) site —
//     the inverse of StartService's NEVER-SIGKILL invariant. Stop owns
//     the service termination path; everything else (terminal close,
//     UI close, Electron quit) MUST leave the service running.
//   - AbortSignal honored before the SIGTERM call; once the signal is
//     sent the service's lifecycle is committed and the wait-for-exit
//     loop respects abort by returning early (status="stopped" if dead,
//     re-throwing AbortError if still alive — abort never SIGKILLs).
import {
  clearPidfileAt,
  isProcessAlive,
  readPidfileAt,
} from "../internal/process-primitives.js";
import { findLiveServicePid } from "../internal/service-pid-fallback.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { ComputerServiceError } from "./errors.js";
import { servicePidPath } from "../paths.js";
import { currentTimeMs } from "@botiverse/raft-shared";
import {
  convergeCliHostLifecycle,
  resolveStableDispatcherPath,
  type MacosHostLifecycleDeps,
} from "../macosLoginCarrier.js";

const STOP_POLL_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 5000;

export interface StopInput {
  /** Reserved for future per-server stop. Unused in v0; the root stop
   *  always targets the service pidfile. */
  serverId?: string | null;
  /** The Computer install root to stop. Required: env resolution lives at
   *  `createComputerApi` construction so mutations can't silently regress to
   *  ambient `~/.slock`. (#wg-raft-computer:f2a02081 BUG 3 sweep.) */
  slockHome: string;
  /** Explicit durable host-lifecycle owner. Internal callers use `none`; the
   * CLI and Electron adapters bind their actual owner. */
  hostLifecycleOwner?: "cli" | "app" | "none";
}

export type StopStatus =
  | "not_running"            // pidfile missing — idempotent no-op
  | "stale_pidfile_cleared"  // pidfile present but pid dead — cleared
  | "stopped";               // SIGTERM sent + service exited within timeout

export interface StopResult {
  status: StopStatus;
  /** Pid the service observed in the pidfile when status !== "not_running".
   *  null on the not_running path (no pid was read). */
  pid: number | null;
  /** Path of the service pidfile (so adapters can render hints
   *  without re-resolving paths). */
  pidfilePath: string;
}

export interface StopDeps {
  /** Test seams — pre-extraction `RunStopDeps` shape preserved so
   *  existing service.test.ts cases keep byte-identical imports
   *  through the adapter. */
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  killService?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Abort the wait path if the caller loses its mutation lock. */
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
}

export interface StopOptions extends StopDeps {
  onEvent?: (event: ComputerApiEvent) => void;
}

function emit(opts: StopOptions | undefined, event: ComputerApiEvent): void {
  const cb = opts?.onEvent;
  if (!cb) return;
  try {
    cb(event);
  } catch {
    // onEvent is best-effort — never let a renderer/listener fault
    // break the stop flow.
  }
}

export async function stop(
  input: StopInput,
  options: StopOptions = {},
): Promise<StopResult> {
  options.signal?.throwIfAborted?.();

  const { slockHome } = input;
  const disableHostLifecycle = async (): Promise<void> => {
    if ((input.hostLifecycleOwner ?? "none") === "none") return;
    const hostDeps = { ...(options.hostLifecycleDeps ?? {}) };
    if (hostDeps.platform === undefined) hostDeps.platform = process.platform;
    if (hostDeps.platform === "darwin" && hostDeps.dispatcherPath === undefined) {
      hostDeps.dispatcherPath = resolveStableDispatcherPath(slockHome);
    }
    await (options.convergeHostLifecycle ?? convergeCliHostLifecycle)(
      slockHome,
      "disabled",
      hostDeps,
    );
  };
  const readPidfile = options.readPidfile ?? readPidfileAt;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const killer =
    options.killService ??
    ((pid: number) => {
      // The ONLY legitimate process.kill(SIGTERM) site in the service
      // layer. StopService owns service termination; StartService is
      // explicitly forbidden from killing (Hao msg=7a1a2c3d invariant).
      process.kill(pid, "SIGTERM");
    });
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? STOP_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const now = options.now ?? currentTimeMs;

  // OS manager definitions are legacy optional state and never participate in
  // stop. The Computer-owned pidfile/TERM path is canonical on every OS.
  // Pidfile fallback chain — walk by liveness through the on-disk
  // layout migration window (current `run/service.pid` → legacy
  // `service.pid` → legacy `supervisor.pid`) so a user on an older
  // layout can still `raft-computer stop` the running service after
  // upgrading the CLI binary. The helper clears stale candidates in
  // place so they do not haunt later reads. Picking by readability
  // alone (instead of by liveness) would let a stale current pidfile
  // mask a still-live legacy service — see
  // `internal/service-pid-fallback.ts` doc-comment.
  const { pid, pidfilePath, firstStalePidfile, firstStalePid } =
    await findLiveServicePid(slockHome, {
      readPidfile,
      isProcessAlive: isAlive,
    });
  options.signal?.throwIfAborted?.();

  emit(options, { kind: "stop.stopping", pid });

  // 1. No live service found anywhere.
  if (pid === null) {
    if (firstStalePidfile !== null && firstStalePid !== null) {
      // We cleared at least one stale pidfile during the walk; report
      // `stale_pidfile_cleared` so the canonical idempotent-cleanup line
      // is rendered (preserves the pre-fallback-chain behavior for the
      // single-candidate case).
      await disableHostLifecycle();
      emit(options, { kind: "stop.stale_pidfile_cleared", pid: firstStalePid });
      return {
        status: "stale_pidfile_cleared",
        pid: firstStalePid,
        pidfilePath: firstStalePidfile,
      };
    }
    await disableHostLifecycle();
    emit(options, { kind: "stop.not_running" });
    return { status: "not_running", pid: null, pidfilePath };
  }

  // 3. Pre-signal AbortSignal check (last opportunity before we commit
  //    to terminating the service). Once SIGTERM is sent the
  //    service's lifecycle is committed and an in-flight abort can
  //    only race with the natural exit.
  options.signal?.throwIfAborted?.();

  // 4. Send SIGTERM. The service's signal handler clears its own
  //    pidfile + process.exit(0). We poll for liveness rather than
  //    pidfile-absence because pidfile clear is best-effort during
  //    emergency shutdown.
  try {
    killer(pid);
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ComputerServiceError(
      "STOP_SIGNAL_FAILED",
      `Failed to send SIGTERM to service (pid ${pid}): ${cause.message}. Check process permissions or run: kill ${pid}`,
      err,
    );
  }
  emit(options, { kind: "stop.signaled", pid });

  // 5. Wait for the service to exit. AbortSignal aborts the wait
  //    early but does NOT escalate to SIGKILL — the kill is already
  //    in flight, and StopService's contract is "ask politely with
  //    SIGTERM then time out", not "force-kill".
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted?.();
    if (!isAlive(pid)) {
      // Defensive pidfile cleanup if the service crashed before its
      // signal handler ran. Best-effort; the path may already be gone.
      options.signal?.throwIfAborted?.();
      await clearPidfileAt(pidfilePath);
      options.signal?.throwIfAborted?.();
      await disableHostLifecycle();
      emit(options, { kind: "stop.stopped", pid });
      return { status: "stopped", pid, pidfilePath };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new ComputerServiceError(
    "STOP_TIMEOUT",
    `Service (pid ${pid}) did not exit within ${timeoutMs}ms after SIGTERM. Force-kill with: kill -9 ${pid}`,
  );
}

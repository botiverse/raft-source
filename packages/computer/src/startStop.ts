// `raft-computer start` / `raft-computer stop` — CLI presenters over the
// ComputerApi (CLI-over-lib convergence). The supervisor/service internals
// stay in service.ts; these presenters were extracted so the supervisor no
// longer imports the lib/api facade (import-cycle decycle R0,
// #wg-raft-computer:18ab6541). Output remains adapter-owned, and the
// RunStartDeps/RunStopDeps shapes are preserved for the existing test harness.
import { resolveRaftHome, serverRunnerLogPath, serviceLogPath } from "./paths.js";
import { info, present } from "./output.js";
import { createComputerApi } from "./lib/api.js";
import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import type { ResidentCoreFactory, spawnDetachedService } from "./service.js";
import type { MacosHostLifecycleDeps } from "./macosLoginCarrier.js";
import type { convergeCliHostLifecycle } from "./macosLoginCarrier.js";

type RunStartDeps = {
  coreFactory?: ResidentCoreFactory;
  spawnDetachedService?: typeof spawnDetachedService;
  readPidfile?: typeof readPidfileAt;
  isProcessAlive?: typeof isProcessAlive;
  sleep?: (ms: number) => Promise<void>;
  ensureTimeoutMs?: number;
  ensurePollIntervalMs?: number;
  signal?: AbortSignal;
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
};

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

  await present(async () => {
    await api.start(
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
        } else if (event.kind === "start.spawned") {
          info(`Service started (pid ${event.servicePid}); keeps running after this terminal closes.`);
          spawnedBackground = {
            managedCount: event.managedTargets.length,
            attachedCount: event.attachedCount,
            logPath: serviceLogPath(slockHome),
            runnerLogPaths: event.managedTargets.map((serverId) =>
              serverRunnerLogPath(slockHome, serverId),
            ),
          };
        } else if (event.kind === "start.ready") {
          info(formatReadySummary(event.ready, event.managedTargets, opts));
        }
      },
      {
        spawnDetachedService: deps.spawnDetachedService,
        readPidfile: deps.readPidfile,
        isProcessAlive: deps.isProcessAlive,
        sleep: deps.sleep,
        ensureTimeoutMs: deps.ensureTimeoutMs,
        ensurePollIntervalMs: deps.ensurePollIntervalMs,
        signal: deps.signal,
        convergeHostLifecycle: deps.convergeHostLifecycle,
        hostLifecycleDeps: deps.hostLifecycleDeps,
      },
    );
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
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  recordLifecycleIntent?: boolean;
  signal?: AbortSignal;
  hostLifecycleOwner?: "cli" | "app" | "none";
  convergeHostLifecycle?: typeof convergeCliHostLifecycle;
  hostLifecycleDeps?: MacosHostLifecycleDeps;
}

export async function runStop(deps: RunStopDeps = {}): Promise<void> {
  // CLI presenter over `api.stop`. The api drives the StopService lifecycle;
  // this supplies the info() sink and `present()` maps a thrown ComputerError
  // → the shared stderr contract. RunStopDeps is preserved + forwarded for the tests.
  const api = createComputerApi(resolveRaftHome());
  await present(async () => {
    await api.stop(
      (event) => {
        if (event.kind === "stop.not_running") {
          info("Service not running.");
        } else if (event.kind === "stop.stale_pidfile_cleared") {
          info(`Service not running (cleared stale pidfile for pid ${event.pid}).`);
        } else if (event.kind === "stop.stopped") {
          info(`Stopped service (pid ${event.pid}).`);
        }
      },
      {
        readPidfile: deps.readPidfile,
        isProcessAlive: deps.isProcessAlive,
        killService: deps.killService,
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
  });
}

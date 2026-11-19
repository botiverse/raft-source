import { Worker } from "node:worker_threads";
import { WorkerCrashed, WorkerPoolError } from "./errors";
import type { WorkerPoolTaskExecutor, WorkerPoolTaskRequest, WorkerPoolTaskResult } from "./types";
import type { WorkerResultMessage, WorkerTaskMessage } from "./workerEntry";

export interface WorkerThreadExecutorDeps {
  /** Number of worker slots. Values < 1 are clamped to 1 (size 0 selects the in-process executor instead). */
  poolSize: number;
  /** V8 heap cap per worker. Default 512. */
  maxOldGenerationSizeMb?: number;
  /** Worker entry point; defaults to the colocated workerEntry.ts. */
  workerEntryUrl?: string | URL;
  /** Module imported inside each worker before it serves tasks (consumer kind registration). */
  bootstrapModule?: string;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface Slot {
  worker: Worker | null;
  inFlightTaskId: string | null;
  settle: {
    resolve: (result: WorkerPoolTaskResult) => void;
    reject: (error: unknown) => void;
  } | null;
  /** The current worker's death was ordered by us (timeout terminate / close): its exit is not a crash. */
  expectedExit: boolean;
}

const TYPESCRIPT_LOADER_PATTERN = /@oxc-node\/core|tsx/;
const HEAP_SIZE_FLAG = /^--max-(old|semi)-space-size(=|$)/;

/**
 * The parent's flags without its V8 heap sizes: a Worker refuses them
 * (ERR_WORKER_INVALID_EXEC_ARGV), and its heap is `resourceLimits` instead.
 * Local Vitest forks carry `--max-old-space-size` (scripts/vitest/localRunLimits.ts).
 */
function withoutHeapSizeFlags(argv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!HEAP_SIZE_FLAG.test(argv[i])) kept.push(argv[i]);
    else if (!argv[i].includes("=") && /^\d+$/.test(argv[i + 1] ?? "")) i++;
  }
  return kept;
}

/**
 * execArgv for spawned workers: the parent's own flags, plus the repo's
 * TypeScript loader when the parent has none.
 *
 * Prod starts the server as `node --import @oxc-node/core/register
 * packages/server/src/server.ts` (packages/server/entrypoint.sh), so
 * process.execArgv already carries the loader and plain inheritance gives
 * workers the exact prod module resolution (extensionless relative imports).
 * Under vitest, execArgv holds vitest's own flags and NO loader — prepend the
 * same @oxc-node/core register so integration-test workers resolve modules
 * exactly like prod instead of falling back to plain-node type stripping.
 */
function workerExecArgv(): string[] {
  const argv = withoutHeapSizeFlags(process.execArgv);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--import" && TYPESCRIPT_LOADER_PATTERN.test(argv[i + 1] ?? "")) return argv;
    if (argv[i].startsWith("--import=") && TYPESCRIPT_LOADER_PATTERN.test(argv[i])) return argv;
    if (argv[i] === "--loader" && TYPESCRIPT_LOADER_PATTERN.test(argv[i + 1] ?? "")) return argv;
  }
  return ["--import", "@oxc-node/core/register", ...argv];
}

function reconstructWorkerError(error: { name: string; message: string } | undefined): Error {
  const reconstructed = new Error(error?.message ?? "worker task failed");
  reconstructed.name = error?.name ?? "Error";
  return reconstructed;
}

/**
 * Thread executor: one worker_threads Worker per slot, one task per worker at
 * a time. Workers spawn lazily on first dispatch (plus `warmup()`), inherit
 * the parent's execArgv so the repo's loader (`@oxc-node/core` in prod,
 * plain-node type stripping under vitest) applies in the worker, and carry a
 * V8 old-generation heap cap.
 *
 * Crash handling: a worker 'error' or non-zero 'exit' rejects the in-flight
 * task with WorkerCrashed; the slot's replacement spawns lazily on next
 * dispatch. On timeout (`abandon`) the worker is terminated immediately —
 * never reused — and a fresh replacement is spawned eagerly.
 */
export function createWorkerThreadExecutor(deps: WorkerThreadExecutorDeps): WorkerPoolTaskExecutor {
  const poolSize = Math.max(1, Math.floor(deps.poolSize));
  const maxOldGenerationSizeMb = deps.maxOldGenerationSizeMb ?? 512;
  const workerEntryUrl = deps.workerEntryUrl ?? new URL("./workerEntry.ts", import.meta.url);
  const logger = deps.logger ?? {
    warn: (message, meta) => console.warn(`[WorkerPool] ${message}`, meta ?? ""),
  };
  const slots: Slot[] = Array.from({ length: poolSize }, () => ({
    worker: null,
    inFlightTaskId: null,
    settle: null,
    expectedExit: false,
  }));
  const execArgv = workerExecArgv();
  let closing = false;

  function failInFlight(slot: Slot, error: unknown): void {
    const settle = slot.settle;
    slot.settle = null;
    slot.inFlightTaskId = null;
    settle?.reject(error);
  }

  function spawnWorker(slot: Slot): Worker {
    const worker = new Worker(workerEntryUrl, {
      // Prod inherits the @oxc-node/core register from the server process;
      // under vitest the register is prepended (see workerExecArgv).
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb },
      workerData: deps.bootstrapModule ? { bootstrapModule: deps.bootstrapModule } : {},
    });
    // Every handler checks worker identity first: events from a replaced
    // worker (timeout terminate, crash) must not touch the slot's new state.
    worker.on("message", (message: WorkerResultMessage) => {
      if (worker !== slot.worker) return;
      if (!slot.settle || slot.inFlightTaskId !== message.taskId) return;
      const settle = slot.settle;
      slot.settle = null;
      slot.inFlightTaskId = null;
      if (message.ok) {
        settle.resolve({ result: message.result, runMs: message.runMs });
      } else {
        settle.reject(reconstructWorkerError(message.error));
      }
    });
    worker.on("error", (error: Error) => {
      if (worker !== slot.worker) return;
      logger.warn("worker errored; rejecting in-flight task", { error: String(error) });
      // The worker terminates itself after an uncaught exception; flag the
      // coming exit as expected so it is not double-counted as a crash.
      slot.expectedExit = true;
      failInFlight(slot, new WorkerCrashed(`worker error: ${error.message}`, { cause: error }));
      // Detach the dying worker NOW: with in-flight state cleared the slot
      // looks free, and a task dispatched before the 'exit' event would be
      // posted into a worker that is going away (message lost, task hangs
      // until timeout). Its later 'exit' is ignored by the identity check.
      slot.worker = null;
    });
    worker.on("exit", (code: number) => {
      if (worker !== slot.worker) return;
      slot.worker = null;
      if (closing) return;
      if (slot.expectedExit) {
        slot.expectedExit = false;
        return;
      }
      logger.warn("worker exited unexpectedly", { exitCode: code });
      failInFlight(slot, new WorkerCrashed(`worker exited unexpectedly with code ${code}`));
    });
    return worker;
  }

  function execute(request: WorkerPoolTaskRequest): Promise<WorkerPoolTaskResult> {
    if (closing) {
      return Promise.reject(new WorkerPoolError("worker_pool_closed", "worker pool is closed"));
    }
    const slot = slots.find((candidate) => candidate.inFlightTaskId === null && candidate.settle === null);
    if (!slot) {
      // The core never exceeds `capacity` concurrent execute() calls; this is defensive.
      return Promise.reject(new WorkerPoolError("worker_pool_saturated", "no free worker slot"));
    }
    return new Promise<WorkerPoolTaskResult>((resolve, reject) => {
      slot.inFlightTaskId = request.taskId;
      slot.settle = { resolve, reject };
      try {
        if (!slot.worker) slot.worker = spawnWorker(slot);
        const message: WorkerTaskMessage = {
          taskId: request.taskId,
          kind: request.kind,
          payload: request.prepared.payload,
          payloadKind: request.prepared.payloadKind,
          traceContext: request.traceContext,
        };
        slot.worker.postMessage(message, request.prepared.transferList);
      } catch (error) {
        failInFlight(slot, error);
      }
    });
  }

  function abandon(taskId: string): void {
    const slot = slots.find((candidate) => candidate.inFlightTaskId === taskId);
    if (!slot) return;
    // The core already rejected this task with WorkerTaskTimeout; rejecting
    // here just settles the execute() promise (the core ignores it).
    failInFlight(slot, new WorkerCrashed("worker task abandoned after timeout"));
    const doomed = slot.worker;
    slot.worker = null;
    if (doomed) {
      // A timed-out worker is never reused: unknown internal state.
      doomed.terminate().catch(() => {});
    }
    // Eager replacement so the next task does not pay spawn+compile latency.
    // The old worker's exit event is ignored via the identity check.
    if (!closing) slot.worker = spawnWorker(slot);
  }

  function warmup(): void {
    if (closing || poolSize < 1) return;
    if (!slots[0].worker) slots[0].worker = spawnWorker(slots[0]);
  }

  async function close(): Promise<void> {
    closing = true;
    const terminations: Promise<unknown>[] = [];
    for (const slot of slots) {
      failInFlight(slot, new WorkerPoolError("worker_pool_closed", "worker pool is closed"));
      if (slot.worker) {
        terminations.push(slot.worker.terminate().catch(() => {}));
        slot.worker = null;
      }
    }
    // fanout-ok: slots is the fixed worker array (pool size 1-2), and terminate() is local thread control — no PG/IO fan-out.
    await Promise.all(terminations);
  }

  return { capacity: poolSize, execute, abandon, warmup, close };
}

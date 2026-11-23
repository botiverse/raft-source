import type { Tracer } from "@botiverse/raft-shared";
import { getRedis, isRedisAvailable } from "../redis";
import { REPLICA_ID } from "../replicaRouter";
import { errorClassOf, recordTraceEvent } from "../tracing/semanticTrace";

/**
 * The hourly maintenance cycle (server.ts `runMaintenance`) runs on ONE
 * replica per cycle, at a time no other replica shares (#proj-deploy:#14).
 *
 * Before: every replica ran the whole list (~30 jobs) 10 s after it started
 * and then every hour from its own start. A deploy starts all replicas within
 * a few minutes, so a dozen replicas ran the same jobs in the same minutes,
 * every hour: wasted work, a burst of concurrent sessions on the primary, and
 * for jobs without a lock of their own, two runs racing.
 *
 * Now each replica checks at a random point in every CHECK window (first
 * check after a random delay, then every window ± jitter). A check claims
 * the cycle in Redis (`SET NX EX`, as closedServerPurge's claim): the replica
 * that wins runs the cycle; the others skip until the claim expires. So the
 * cycle runs about once per CLAIM_TTL across all replicas, on whichever
 * replica checks first after that; a replica that dies or restarts does not
 * stop it, and a deploy does not make every new replica run it again.
 *
 * Without Redis (dev, tests, a single process) the claim is in memory, which
 * is the same rule for one process.
 *
 * A claim that cannot be read (Redis error) skips this check: the next check
 * tries again. Running anyway would bring back the stampede in exactly the
 * moment Redis is struggling.
 */
export const MAINTENANCE_CYCLE_CLAIM_KEY = "slock:maintenance:cycle-claim";
/** At most one cycle per this long, across replicas. */
export const MAINTENANCE_CYCLE_CLAIM_TTL_MS = 55 * 60_000;
/** How often each replica asks whether the cycle is due. */
export const MAINTENANCE_CYCLE_CHECK_INTERVAL_MS = 5 * 60_000;
/** The first check comes this long after start at the earliest, and one check interval later at the latest. */
export const MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS = 10_000;

export interface MaintenanceCycleClaim {
  /** True when this replica may run the cycle now (no other cycle within the claim's TTL). */
  claim(): Promise<boolean>;
}

export function redisMaintenanceCycleClaim(ttlMs = MAINTENANCE_CYCLE_CLAIM_TTL_MS): MaintenanceCycleClaim {
  return {
    async claim() {
      const result = await getRedis().set(MAINTENANCE_CYCLE_CLAIM_KEY, REPLICA_ID, "PX", ttlMs, "NX");
      return result === "OK";
    },
  };
}

/** One process, no Redis: the same rule, in memory. */
export function memoryMaintenanceCycleClaim(
  now: () => number = Date.now,
  ttlMs = MAINTENANCE_CYCLE_CLAIM_TTL_MS,
): MaintenanceCycleClaim {
  let claimedUntil = 0;
  return {
    async claim() {
      const at = now();
      if (at < claimedUntil) return false;
      claimedUntil = at + ttlMs;
      return true;
    },
  };
}

export interface MaintenanceCycleTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: MaintenanceCycleTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never keep the process alive for maintenance alone.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MaintenanceCycleOptions {
  /** The cycle itself. Started, not awaited to the end: each job reports its own failure. */
  run: () => void;
  claim?: MaintenanceCycleClaim;
  timers?: MaintenanceCycleTimers;
  /** [0, 1). */
  random?: () => number;
  checkIntervalMs?: number;
  log?: Pick<Console, "error">;
  /** Process-owned tracer for the claim events (a check runs outside any request). */
  tracer?: Tracer;
}

export interface MaintenanceCycleHandle {
  /** One check now (claim, then run if won). Exposed for tests. */
  check(): Promise<"ran" | "claimed_elsewhere" | "claim_failed">;
  stop(): void;
}

/** The first check's delay: uniform in [FIRST_CHECK_MIN, FIRST_CHECK_MIN + interval). */
export function maintenanceCycleFirstDelayMs(random: number, intervalMs = MAINTENANCE_CYCLE_CHECK_INTERVAL_MS): number {
  return MAINTENANCE_CYCLE_FIRST_CHECK_MIN_MS + Math.floor(random * intervalMs);
}

/** A later check's delay: the interval ± 20 %, so replicas started together drift apart. */
export function maintenanceCycleNextDelayMs(random: number, intervalMs = MAINTENANCE_CYCLE_CHECK_INTERVAL_MS): number {
  return Math.floor(intervalMs * (0.8 + 0.4 * random));
}

let processClaim: MaintenanceCycleClaim | null = null;
function defaultClaim(): MaintenanceCycleClaim {
  if (isRedisAvailable()) return redisMaintenanceCycleClaim();
  processClaim ??= memoryMaintenanceCycleClaim();
  return processClaim;
}

export function startMaintenanceCycle(opts: MaintenanceCycleOptions): MaintenanceCycleHandle {
  const timers = opts.timers ?? systemTimers;
  const random = opts.random ?? Math.random;
  const intervalMs = opts.checkIntervalMs ?? MAINTENANCE_CYCLE_CHECK_INTERVAL_MS;
  const log = opts.log ?? console;
  let stopped = false;
  let handle: unknown = null;

  const check: MaintenanceCycleHandle["check"] = async () => {
    let won: boolean;
    try {
      won = await (opts.claim ?? defaultClaim()).claim();
    } catch (error) {
      log.error("[Slock] Maintenance cycle claim failed; skipping this check", { error_class: errorClassOf(error) });
      recordTraceEvent("server.background.maintenance.claim", { outcome: "claim_failed", error_class: errorClassOf(error) }, opts.tracer);
      return "claim_failed";
    }
    if (!won) return "claimed_elsewhere";
    recordTraceEvent("server.background.maintenance.claim", { outcome: "ran", replica_id: REPLICA_ID }, opts.tracer);
    opts.run();
    return "ran";
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      void check().finally(() => schedule(maintenanceCycleNextDelayMs(random(), intervalMs)));
    }, delayMs);
  };
  schedule(maintenanceCycleFirstDelayMs(random(), intervalMs));

  return {
    check,
    stop() {
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
    },
  };
}

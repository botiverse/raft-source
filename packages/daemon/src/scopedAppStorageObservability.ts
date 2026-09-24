import { randomUUID } from "node:crypto";

import type { Clock } from "./connection.js";
import type { ScopedAppStorageFailureEvent } from "./scopedAppStorage.js";

export const SCOPED_APP_STORAGE_OBSERVATION_FAMILIES = [
  "access_failure",
  "read_failure",
  "write_failure",
  "invalid_payload",
  "internal_error",
  "legacy_quarantine_failure",
] as const;

export type ScopedAppStorageObservationFamily =
  typeof SCOPED_APP_STORAGE_OBSERVATION_FAMILIES[number];

type Trace = (
  name: string,
  attrs: Record<string, unknown>,
  status?: "ok" | "error",
) => void;

export type ScopedAppStorageObserver = {
  observe(event: ScopedAppStorageFailureEvent): void;
  heartbeat(): void;
  stop(): void;
};

const COVERAGE_DIMENSIONS = ["W", "D", "P"] as const;

type CoverageDimension = typeof COVERAGE_DIMENSIONS[number];

type CoverageStatus =
  | { status: "covered"; arm: "A1" | "A2" | "A5" }
  | { status: "not_applicable"; reason: string };

/**
 * Render every declared store into the closed W/D/P shape. Store ownership and
 * the status of each arm remain caller-owned data rather than OS-layer names.
 */
export function renderScopedAppStorageCoverageMatrix(input: readonly {
  appId: string;
  dimensions: Readonly<Record<CoverageDimension, CoverageStatus>>;
}[]) {
  return input.flatMap(({ appId, dimensions }) =>
    COVERAGE_DIMENSIONS.map((dimension) => ({
      appId,
      dimension,
      ...dimensions[dimension],
    }))
  );
}

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_THRESHOLD = 3;

function familyFor(event: ScopedAppStorageFailureEvent): ScopedAppStorageObservationFamily {
  if (event.operation === "decode") {
    return event.reason === "internal_error" ? "internal_error" : "invalid_payload";
  }
  if (event.operation === "write") return "write_failure";
  if (event.operation === "read") return "read_failure";
  if (event.operation === "legacy_quarantine") return "legacy_quarantine_failure";
  return "access_failure";
}

function identityAttrs(event: ScopedAppStorageFailureEvent) {
  return {
    store: event.store,
    app: event.appId,
    server_id: event.serverId,
    writer_epoch: event.writerEpoch,
  };
}

/**
 * Observer for the closed scoped-storage signal family. Production writes its
 * traces synchronously to the machine-local rotating trace sink before control
 * returns to a caller that may terminate the process. The writer epoch on each
 * record lets a consumer distinguish a counter that survived a crash from an
 * unrelated prior non-zero value.
 */
export function createScopedAppStorageObserver(options: {
  trace: Trace;
  serverId: string;
  writerEpoch: string;
  clock: Clock;
  heartbeatMs?: number;
  rateWindowMs?: number;
  rateThreshold?: number;
  registeredFamilies?: readonly ScopedAppStorageObservationFamily[];
}): ScopedAppStorageObserver {
  const clock = options.clock;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const rateThreshold = options.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const registeredFamilies = options.registeredFamilies
    ?? SCOPED_APP_STORAGE_OBSERVATION_FAMILIES;
  const registered = new Set(registeredFamilies);
  const counts = new Map<string, number>();
  const rateWindows = new Map<string, number[]>();
  let heartbeatTimer: unknown | null = null;
  let stopped = false;

  const heartbeat = () => {
    if (stopped) return;
    if (heartbeatTimer !== null) {
      clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    const heartbeatId = randomUUID();
    const observedAt = new Date(clock.now()).toISOString();
    for (const family of registeredFamilies) {
      options.trace("daemon.app_storage.heartbeat", {
        heartbeat: heartbeatId,
        family,
        server_id: options.serverId,
        writer_epoch: options.writerEpoch,
        observed_at: observedAt,
      }, "ok");
    }
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null;
      heartbeat();
    }, heartbeatMs);
  };

  heartbeat();

  return {
    observe(event) {
      const family = familyFor(event);
      if (!registered.has(family)) {
        options.trace("daemon.app_storage.instrumentation", {
          ...identityAttrs(event),
          family,
          outcome: "instrument_failed",
          reason: "counter_missing",
          observed_at: new Date(clock.now()).toISOString(),
        }, "error");
        return;
      }
      const scopeKey = [
        family,
        event.store,
        event.appId,
        event.serverId,
        event.writerEpoch,
      ].join("\u0000");
      const count = (counts.get(scopeKey) ?? 0) + 1;
      counts.set(scopeKey, count);
      const observedAtMs = clock.now();
      options.trace("daemon.app_storage.counter", {
        ...identityAttrs(event),
        family,
        count,
        operation: event.operation,
        outcome: event.outcome,
        reason: event.reason,
        observed_at: new Date(observedAtMs).toISOString(),
        ...(event.failureInstanceId === undefined
          ? {}
          : { failure_generation: event.failureInstanceId }),
        ...(event.observation === undefined
          ? {}
          : { corruption_class: event.observation }),
      }, "error");

      const window = rateWindows.get(scopeKey) ?? [];
      const floor = observedAtMs - rateWindowMs;
      while (window.length > 0 && window[0]! < floor) window.shift();
      window.push(observedAtMs);
      rateWindows.set(scopeKey, window);
      if (window.length === rateThreshold) {
        options.trace("daemon.app_storage.alert", {
          ...identityAttrs(event),
          family,
          reason: `${family}_rate`,
          operation: event.operation,
          outcome: event.outcome,
          failure_reason: event.reason,
          count: window.length,
          window_ms: rateWindowMs,
          observed_at: new Date(observedAtMs).toISOString(),
          ...(event.observation === undefined
            ? {}
            : { corruption_class: event.observation }),
        }, "error");
      }
    },
    heartbeat,
    stop() {
      stopped = true;
      if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    },
  };
}

export function evaluateScopedAppStorageInstrumentation(input: {
  heartbeats: readonly { attrs: Record<string, unknown> }[];
  serverId: string;
  writerEpoch: string;
  nowMs: number;
  maxAgeMs?: number;
}):
  | { status: "healthy_zero" }
  | { status: "instrument_failed"; reason: "counter_missing" | "heartbeat_stale" } {
  const sameLife = input.heartbeats.filter((heartbeat) =>
    heartbeat.attrs.server_id === input.serverId
    && heartbeat.attrs.writer_epoch === input.writerEpoch
  );
  if (sameLife.length === 0) {
    return { status: "instrument_failed", reason: "counter_missing" };
  }
  const latestHeartbeatId = sameLife.at(-1)?.attrs.heartbeat;
  const latest = sameLife.filter((heartbeat) =>
    heartbeat.attrs.heartbeat === latestHeartbeatId
  );
  const families = new Set(latest.map((heartbeat) => heartbeat.attrs.family));
  if (SCOPED_APP_STORAGE_OBSERVATION_FAMILIES.some((family) => !families.has(family))) {
    return { status: "instrument_failed", reason: "counter_missing" };
  }
  const observedAt = Date.parse(String(latest[0]?.attrs.observed_at ?? ""));
  if (
    !Number.isFinite(observedAt)
    || input.nowMs - observedAt > (input.maxAgeMs ?? 2 * DEFAULT_HEARTBEAT_MS)
  ) {
    return { status: "instrument_failed", reason: "heartbeat_stale" };
  }
  return { status: "healthy_zero" };
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, RequestHandler } from "express";
import {
  createScopedTracer,
  currentTimeMs,
  errorClassOf,
  noopTracer,
  type ActiveSpan,
  type StartSpanOptions,
  type TraceAttributes,
  type TraceContext,
  type Tracer,
} from "@botiverse/raft-shared";
import { getActiveSpan, runWithActiveSpan } from "@botiverse/raft-trace-client";
import type { DbQueryTracer } from "./dbQueryTrace";
import { queryFailureDiagnostics, timeoutBucket } from "./queryTrace";

// The active span itself lives in the one node-side store shared with the
// daemon (`@botiverse/raft-trace-client`), so code that runs in-process on
// either side sees the same parent. The server additionally carries the
// tracer of the current request beside it, so deep service code can open an
// exact child span without threading a tracer through every signature.
const activeTracerStore = new AsyncLocalStorage<Tracer>();

// Process-wide tracer for work that runs outside any request (pollers,
// workers, timers). Set once at startup from the server tracer. Before this,
// `recordTraceEvent` outside a request fell back to the noop tracer, so events
// from background paths were dropped without a trace (10-20: assistant doorbell
// sends from the 5 s poll never logged `server.assistant.doorbell.sent`).
let processDefaultTracer: Tracer | null = null;

export function setDefaultTraceTracer(tracer: Tracer | null): void {
  processDefaultTracer = tracer;
}

// Events and root spans that still found no tracer at all. Expected to stay
// zero in a running server; reported once a minute so a gap shows up as a row
// instead of as silence. Bounded by name so it cannot grow without limit.
const DROPPED_TRACE_EVENT_NAME_LIMIT = 200;
const DROPPED_TRACE_EVENT_OVERFLOW = "_other";
const droppedTraceEvents = new Map<string, number>();

function countDroppedTraceEvent(name: string): void {
  const key = droppedTraceEvents.has(name) || droppedTraceEvents.size < DROPPED_TRACE_EVENT_NAME_LIMIT
    ? name
    : DROPPED_TRACE_EVENT_OVERFLOW;
  droppedTraceEvents.set(key, (droppedTraceEvents.get(key) ?? 0) + 1);
}

/** Return and reset the per-name counts of trace records that had no tracer. */
export function takeDroppedTraceEventCounts(): Map<string, number> {
  const counts = new Map(droppedTraceEvents);
  droppedTraceEvents.clear();
  return counts;
}

export const DROPPED_TRACE_EVENT_REPORT_INTERVAL_MS = 60_000;

/**
 * Every interval, one `server.trace_event.dropped` event per name that was
 * dropped since the last report (`event_name`, `count`). Nothing is emitted
 * while the counts are zero.
 */
export function startDroppedTraceEventReporter(
  tracer: Tracer,
  intervalMs: number = DROPPED_TRACE_EVENT_REPORT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      for (const [eventName, count] of takeDroppedTraceEventCounts()) {
        tracer.emitEvent("server.trace_event.dropped", {
          surface: "server",
          attrs: { event_name: eventName, count, interval_ms: intervalMs },
        });
      }
    } catch {
      // Reporting must never affect the process.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function tracerForRecord(name: string, explicit?: Tracer | null): Tracer {
  const tracer = explicit ?? processDefaultTracer;
  if (tracer) return tracer;
  countDroppedTraceEvent(name);
  return noopTracer;
}

export function runWithTraceSpan<T>(span: ActiveSpan, work: () => T, tracer?: Tracer): T {
  const activeTracer = tracer ?? activeTracerStore.getStore();
  return activeTracer
    ? activeTracerStore.run(activeTracer, () => runWithActiveSpan(span, work))
    : runWithActiveSpan(span, work);
}

/**
 * Add attrs to every span opened by `work` in the current request, for
 * identity that is only known mid-request (e.g. after credential auth). The
 * already-open request span is unaffected; it stamps its own attrs at end.
 * Outside an instrumented request this just runs `work`.
 */
export function runWithTraceAttrs<T>(attrs: TraceAttributes, work: () => T): T {
  const tracer = activeTracerStore.getStore();
  const span = getCurrentTraceSpan();
  if (!tracer || !span || !Object.keys(attrs).length) return work();
  return runWithTraceSpan(span, work, createScopedTracer(tracer, attrs, { attrPrecedence: "caller" }));
}

export function getCurrentTraceSpan(): ActiveSpan | null {
  return getActiveSpan();
}

export function getCurrentTraceContext(): TraceContext | null {
  return getCurrentTraceSpan()?.context ?? null;
}

/**
 * Record a point in time fact as a standalone trace event. It is attached to
 * the active span when there is one, and uses the tracer of the current
 * request. Outside an instrumented request it uses the fallback tracer when
 * one is given, then the process default tracer; with neither it is dropped
 * and counted (see `startDroppedTraceEventReporter`).
 */
export function recordTraceEvent(name: string, attrs?: TraceAttributes, fallbackTracer?: Tracer): void {
  const tracer = tracerForRecord(name, activeTracerStore.getStore() ?? fallbackTracer);
  tracer.emitEvent(name, {
    surface: "server",
    attrs,
    parent: getCurrentTraceContext(),
  });
}

/**
 * Run work in a new root span. The span starts before the work and ends after
 * it. When errorEventName is set, a failure also records that trace event
 * inside the span with the span start attrs, so failures stay searchable by
 * their old name.
 */
export async function withTraceRoot<T>(
  tracer: Tracer | null | undefined,
  name: string,
  options: StartSpanOptions,
  work: () => Promise<T>,
  errorEventName?: string,
): Promise<T> {
  const activeTracer = tracerForRecord(name, tracer);
  const span = activeTracer.startSpan(name, options);
  try {
    const result = await runWithTraceSpan(span, work, activeTracer);
    span.end("ok");
    return result;
  } catch (error) {
    const errorClass = errorClassOf(error);
    if (errorEventName) {
      activeTracer.emitEvent(errorEventName, {
        surface: options.surface,
        parent: span.context,
        attrs: { ...options.attrs, outcome: "error", error_class: errorClass },
      });
    }
    span.end("error", { attrs: { error_class: errorClass } });
    throw error;
  }
}

export interface TraceChildSpanOutcome<T> {
  onSuccess?: (result: T) => TraceAttributes;
  onError?: (error: unknown) => TraceAttributes;
  /** The span's status for work that answers a failure instead of throwing it (default "ok"). */
  statusOf?: (result: T) => "ok" | "error";
}

/**
 * Run work in a real child span of the active request span.
 *
 * The tracer is carried beside the active span in AsyncLocalStorage so deep
 * service code can create an exact query/decision boundary without threading
 * an Express request or tracer through every service signature. When invoked
 * outside an instrumented request this is a no-op span, preserving behavior.
 */
export async function withTraceChildSpan<T>(
  name: string,
  options: Omit<StartSpanOptions, "parent">,
  work: () => Promise<T>,
  outcome: TraceChildSpanOutcome<T> = {},
): Promise<T> {
  const tracer = activeTracerStore.getStore() ?? noopTracer;
  const startedAt = currentTimeMs();
  const span = tracer.startSpan(name, {
    ...options,
    parent: getCurrentTraceContext(),
  });
  try {
    const result = await runWithTraceSpan(span, work, tracer);
    span.end(outcome.statusOf?.(result) ?? "ok", {
      attrs: {
        duration_ms: currentTimeMs() - startedAt,
        ...outcome.onSuccess?.(result),
      },
    });
    return result;
  } catch (error) {
    span.end("error", {
      attrs: {
        duration_ms: currentTimeMs() - startedAt,
        error_class: errorClassOf(error),
        ...outcome.onError?.(error),
      },
    });
    throw error;
  }
}

export function addTraceEvent(name: string, attrs?: TraceAttributes): void {
  getCurrentTraceSpan()?.addEvent(name, attrs);
}

export async function tracePhase<T>(
  work: () => Promise<T>,
  onComplete: (durationMs: number, result: T) => { name: string; attrs?: TraceAttributes },
): Promise<T> {
  const start = Date.now();
  const result = await work();
  const durationMs = Date.now() - start;
  const event = onComplete(durationMs, result);
  addTraceEvent(event.name, {
    duration_ms: durationMs,
    ...event.attrs,
  });
  return result;
}

export const MIDDLEWARE_PHASE_FINISHED_EVENT = "middleware.phase.finished";

/**
 * The `next` of a pre-handler middleware phase: when the middleware hands the
 * request on (with or without an error), the request span gets one
 * `middleware.phase.finished` event with only `phase` (a stable short name)
 * and `duration_ms` since this call. Call it first thing in the middleware.
 * A middleware that answers the request itself records nothing here; the
 * response's status says why. Outside an instrumented request it is a no-op.
 */
export function traceMiddlewarePhase(phase: string, next: NextFunction): NextFunction {
  const startedAt = Date.now();
  let recorded = false;
  const traced = (...args: unknown[]): void => {
    if (!recorded) {
      recorded = true;
      safeAddTraceEvent(MIDDLEWARE_PHASE_FINISHED_EVENT, () => ({ phase, duration_ms: Date.now() - startedAt }));
    }
    (next as (...nextArgs: unknown[]) => void)(...args);
  };
  return traced as NextFunction;
}

/** `traceMiddlewarePhase` around a middleware that is not ours to edit (e.g. a rate limiter). */
export function withMiddlewarePhaseTrace(phase: string, handler: RequestHandler): RequestHandler {
  return (req, res, next) => handler(req, res, traceMiddlewarePhase(phase, next));
}

/**
 * Every current call site wraps the PG pool, so dbSystem defaults to
 * "postgresql". RisingWave never flows through this wrapper (RW uses
 * queryRisingWave + risingWaveInboxTrace); a future non-PG caller must pass
 * dbSystem explicitly.
 */
export function createTraceDbQueryTracer(
  phase: string,
  options: { dbSystem?: string } = {},
): DbQueryTracer {
  const dbSystem = options.dbSystem ?? "postgresql";
  return async (queryName, work, onComplete, onError) => {
    const start = Date.now();
    try {
      const result = await work();
      const duration = Date.now() - start;
      safeAddTraceEvent("db.query.finished", () => ({
        event_kind: "db_query",
        outcome: "success",
        reason: "query_completed",
        query_name: queryName,
        phase,
        duration_ms: duration,
        db_system: dbSystem,
        timeout_bucket: timeoutBucket(duration),
        ...inferRowCount(result),
        ...onComplete?.(result),
      }));
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      safeAddTraceEvent("db.query.failed", () => ({
        event_kind: "db_query",
        outcome: "error",
        reason: "query_failed",
        query_name: queryName,
        phase,
        duration_ms: duration,
        error_class: errorClassOf(error),
        db_system: dbSystem,
        ...queryFailureDiagnostics(error, duration),
        ...onError?.(error),
      }));
      throw error;
    }
  };
}

export const traceAttrs = {
  count(name: string, count: number): TraceAttributes {
    return { [`${name}_count`]: count };
  },
  present(name: string, value: unknown): TraceAttributes {
    return { [`${name}_present`]: Boolean(value) };
  },
  error(error: unknown): TraceAttributes {
    return { error_class: errorClassOf(error) };
  },
};

/**
 * Bounded classification for an unknown throw. Canonical definition lives in
 * @botiverse/raft-shared (tracing/index.ts); re-exported here so existing
 * server-internal imports keep working.
 */
export { errorClassOf };

export function safeAddTraceEvent(name: string, getAttrs: () => TraceAttributes): void {
  try {
    addTraceEvent(name, getAttrs());
  } catch (error) {
    console.warn(`[Tracing] Failed to record trace event ${name}:`, error);
  }
}

function inferRowCount(result: unknown): TraceAttributes {
  if (Array.isArray(result)) return { row_count: result.length };
  if (result instanceof Map || result instanceof Set) return { row_count: result.size };
  return {};
}

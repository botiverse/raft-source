import { AsyncLocalStorage } from "node:async_hooks";
import {
  currentTimeMs,
  noopTracer,
  type ActiveSpan,
  type StartSpanOptions,
  type TraceAttributes,
  type TraceContext,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";
import type { DbQueryTracer } from "./dbQueryTrace.js";
import { queryFailureDiagnostics, timeoutBucket } from "./queryTrace.js";

const activeSpanStore = new AsyncLocalStorage<ActiveSpan>();
const activeTracerStore = new AsyncLocalStorage<Tracer>();

export function runWithTraceSpan<T>(span: ActiveSpan, work: () => T, tracer?: Tracer): T {
  const activeTracer = tracer ?? activeTracerStore.getStore();
  return activeTracer
    ? activeTracerStore.run(activeTracer, () => activeSpanStore.run(span, work))
    : activeSpanStore.run(span, work);
}

export function getCurrentTraceSpan(): ActiveSpan | null {
  return activeSpanStore.getStore() ?? null;
}

export function getCurrentTraceContext(): TraceContext | null {
  return getCurrentTraceSpan()?.context ?? null;
}

export async function withTraceRoot<T>(
  tracer: Tracer | null | undefined,
  name: string,
  options: StartSpanOptions,
  work: () => Promise<T>,
): Promise<T> {
  const span = (tracer ?? noopTracer).startSpan(name, options);
  let status: TraceStatus = "ok";
  try {
    return await runWithTraceSpan(span, work, tracer ?? noopTracer);
  } catch (error) {
    status = "error";
    span.addEvent("error", {
      error_class: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  } finally {
    span.end(status);
  }
}

export interface TraceChildSpanOutcome<T> {
  onSuccess?: (result: T) => TraceAttributes;
  onError?: (error: unknown) => TraceAttributes;
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
    span.end("ok", {
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
        error_class: error instanceof Error ? error.name : typeof error,
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
        error_class: error instanceof Error ? error.name : typeof error,
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
    return { error_class: error instanceof Error ? error.name : typeof error };
  },
};

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

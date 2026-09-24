import {
  BasicTracer,
  type ActiveSpan,
  type CompletedTraceSpan,
  type EndSpanOptions,
  type StartSpanOptions,
  type TraceAttributes,
  type TraceEvent,
  type TraceSink,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";

/**
 * Discriminator for the emitting process. Force-injected as `source` attr
 * onto every span this client produces — callers cannot accidentally omit
 * it or label themselves as a different source. Prevents silent
 * misattribution when daemon, Computer CLI, and menu-bar all share the
 * same upload pipeline (per Tenny review msg=1c95d424).
 *
 * **Two-axis trace identity — don't conflate (per Tenny msg=727b0824):**
 *
 *   `surface` (TraceSurface in @botiverse/raft-shared) = subsystem family
 *     — `server | daemon | web | computer`. Used for query/aggregation
 *     bucketing. CLI and menu-bar both ship under `surface: "computer"`
 *     (coarse-grained subsystem identity).
 *
 *   `source` (this type) = emitting process — `daemon | computer.cli |
 *     computer.menu-bar`. Used for misattribution / uniqueness debug.
 *
 *   Do NOT add a `surface: "computer.cli"` shortcut to merge the two —
 *   query-by-subsystem and debug-by-process are separately useful.
 */
export type TraceClientSource = "daemon" | "computer.cli" | "computer.menu-bar";

export interface TraceClientOptions {
  source: TraceClientSource;
  /**
   * Sinks fan out independently with failure isolation — a sink whose
   * write throws does not block other sinks from receiving the same
   * span. Empty list is permitted (no-op pass-through; useful for
   * tests where only the tracer's contract matters).
   *
   * Discrete `sink: "local" | "upload"` was rejected (Tenny review):
   * daemon's "upload" path is a band-out file watcher reading what the
   * local sink wrote, NOT an in-process span subscriber, and a list
   * shape lets future fan-out (e.g. menu-bar simultaneously writing
   * local AND forwarding to daemon) drop in without an enum change.
   */
  sinks: TraceSink[];
}

/**
 * Caller-facing `attrs` shape for trace-client callers — `source` is
 * forbidden as a key (`?: never`) so passing `attrs: { source: ... }`
 * becomes a compile-time error rather than a runtime no-op silently
 * stripped by the client. Per skyzh review msg=0947c7d3: provenance
 * stamping should be type-enforced when the type system can carry it,
 * not just runtime-enforced.
 *
 * Other attribute keys are open (`Record<string, unknown>` — same as
 * `TraceAttributes`).
 */
export type TraceClientAttrs = Omit<TraceAttributes, "source"> & { source?: never };

export interface TraceClientStartSpanOptions extends Omit<StartSpanOptions, "attrs"> {
  attrs?: TraceClientAttrs;
}

export interface TraceClientEndSpanOptions extends Omit<EndSpanOptions, "attrs"> {
  attrs?: TraceClientAttrs;
}

/**
 * Type-tightened `ActiveSpan` for trace-client callers. `end()` rejects
 * caller-supplied `source` at compile time. Note: `addEvent` keeps the
 * loose `TraceAttributes` shape because event-level attrs are not the
 * span-level `source` field (per Tenny review msg=727b0824 — event-vs-
 * span-level attrs are different surfaces).
 */
export interface TraceClientActiveSpan extends Omit<ActiveSpan, "end"> {
  end(status?: TraceStatus, options?: TraceClientEndSpanOptions): void;
}

/**
 * Wraps a `Tracer` so every span it produces carries a force-injected
 * `source` attribute identifying the emitting process. The caller-facing
 * surface is type-tightened: passing `attrs: { source: ... }` at either
 * `startSpan` or `end` time fails to compile (skyzh review msg=0947c7d3).
 * As a runtime defense-in-depth, the client also strips `source` from
 * caller attrs before forwarding to the underlying `BasicTracer`, so any
 * surface that bypasses the type check (e.g. dynamic-typed callsites)
 * still cannot mislabel.
 */
export interface TraceClient {
  startSpan(name: string, options: TraceClientStartSpanOptions): TraceClientActiveSpan;
}

/**
 * Fans out span/event records to multiple sinks with per-sink failure
 * isolation. A single sink throwing does not stop subsequent sinks from
 * receiving the same record.
 */
export class MultiSink implements TraceSink {
  private readonly sinks: TraceSink[];
  private readonly onSinkError?: (sink: TraceSink, error: unknown) => void;

  constructor(sinks: TraceSink[], onSinkError?: (sink: TraceSink, error: unknown) => void) {
    this.sinks = sinks;
    this.onSinkError = onSinkError;
  }

  record(span: CompletedTraceSpan): void {
    for (const sink of this.sinks) {
      try {
        sink.record(span);
      } catch (err) {
        this.onSinkError?.(sink, err);
      }
    }
  }
}

/**
 * Wraps an `ActiveSpan` so `end()` strips any caller-supplied `source`
 * attr, preventing end-time override of the start-time injection. Without
 * this wrapper, `BasicTracer`'s `end(status, { attrs })` merges caller
 * attrs over span attrs (`{...base, ...extra}`), letting a caller
 * mislabel the span at end-time even though `startSpan` injected the
 * correct source. Per Tenny review msg=77791f4f.
 */
class SourceForcingActiveSpan implements TraceClientActiveSpan {
  readonly context: ActiveSpan["context"];
  private readonly inner: ActiveSpan;

  constructor(inner: ActiveSpan) {
    this.inner = inner;
    this.context = inner.context;
  }

  addEvent(name: string, attrs?: TraceAttributes): void {
    // Event-level attrs are not the span-level `source` field, so they
    // don't need stripping. Forward as-is.
    this.inner.addEvent(name, attrs);
  }

  end(status?: TraceStatus, options?: TraceClientEndSpanOptions): void {
    if (!options?.attrs) {
      this.inner.end(status, options);
      return;
    }
    // Defense-in-depth: type tightening already rejects caller-set
    // `source` at compile time, but strip at runtime too so dynamic
    // callsites (object spread, JSON-derived attrs, etc.) cannot
    // bypass the invariant.
    const { source: _stripped, ...rest } = options.attrs as TraceAttributes & { source?: unknown };
    this.inner.end(status, { ...options, attrs: rest });
  }
}

class SourceForcingTracer implements TraceClient {
  private readonly inner: Tracer;
  private readonly source: TraceClientSource;

  constructor(inner: Tracer, source: TraceClientSource) {
    this.inner = inner;
    this.source = source;
  }

  startSpan(name: string, options: TraceClientStartSpanOptions): TraceClientActiveSpan {
    // Force-inject `source`: caller attrs win for everything else, but
    // `source` is reserved so the client is the single source of truth.
    // Type tightening already rejects caller-set `source` at compile time;
    // runtime overwrite here is defense-in-depth for dynamic callsites.
    const callerAttrs = options.attrs ?? {};
    const attrs: TraceAttributes = { ...callerAttrs, source: this.source };
    const innerSpan = this.inner.startSpan(name, { ...options, attrs });
    // Wrap to also lock `source` against end-time override.
    return new SourceForcingActiveSpan(innerSpan);
  }
}

/**
 * Create a trace client that combines the canonical `BasicTracer` from
 * `@botiverse/raft-shared` with a multi-sink fan-out and a force-injected
 * `source` attribute on every span.
 *
 * Callers (daemon / Computer CLI / menu-bar) should construct one
 * client per process and reuse it. The `source` value is fixed at
 * construction; multiple processes that want to label themselves
 * differently each construct their own client.
 */
export function createTraceClient(options: TraceClientOptions): TraceClient {
  const sink = new MultiSink(options.sinks);
  const baseTracer = new BasicTracer({ sink });
  return new SourceForcingTracer(baseTracer, options.source);
}

// Re-export the inner span/event types for callers that don't want to
// depend on @botiverse/raft-shared directly. Optional convenience; callers
// may import these from shared if they prefer.
export type { TraceEvent };

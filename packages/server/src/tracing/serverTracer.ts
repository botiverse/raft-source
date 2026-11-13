import {
  BasicTracer,
  noopTracer,
  type CompletedTraceSpan,
  type TraceEventRecord,
  type TraceLogEvent,
  type TraceSink,
  type TraceEventRowV2SchemaCheckSkipReason,
  type TraceSpanFactRecord,
  type Tracer,
} from "@botiverse/raft-shared";
import { OtlpHttpTraceSink, type OtlpHttpTraceSinkFetch } from "./otlpHttpTraceSink";
import {
  ScopeDbTraceEventSink,
  type ScopeDbTraceEventSinkOptions,
  type ScopeDbTraceEventSinkSchemaCheckSkip,
} from "./scopeDbTraceEventSink";
import { scopeDbTraceExportSummaryWriter, TraceExportSummary, type TraceExportSummaryWriter } from "./traceExportSummary";
import { TraceUserIdTraceSink } from "./traceUserIdTraceSink";
import { SERVER_VERSION } from "../version";
import {
  createGeneratedTraceDeploymentIdentity,
  traceDeploymentResourceOptions,
  type TraceDeploymentIdentity,
  type TraceDeploymentResourceOptions,
} from "./traceDeploymentIdentity";
import {
  scopeDbTraceSinkEnabled,
  scopeDbTraceSinkFlushesTotal,
  scopeDbTraceSinkLastErrorTimestamp,
  scopeDbTraceSinkLastSuccessTimestamp,
  scopeDbTraceSinkQueueRows,
  scopeDbTraceSinkRowsDroppedTotal,
  scopeDbTraceSinkRowsExportedTotal,
  scopeDbTraceSinkSchemaCheckSkippedTotal,
} from "../metrics";
import { trackActiveSpans } from "./eventLoopStall";
import { isPrivacyModeOn } from "../config/privacyMode";

export interface ServerTracerRuntime {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/** Test seams: the OTLP transport, the summary's ScopeDB writer and the event-row sink's ScopeDB client. */
export interface ServerTracerTestOverrides {
  otlpFetch?: OtlpHttpTraceSinkFetch;
  traceExportSummaryWriter?: TraceExportSummaryWriter;
  traceEventSinkClient?: ScopeDbTraceEventSinkOptions["client"];
}

export function createServerTracerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deploymentIdentity: TraceDeploymentIdentity = createGeneratedTraceDeploymentIdentity("non_ecs"),
  overrides: ServerTracerTestOverrides = {},
): ServerTracerRuntime {
  // RAFT_PRIVACY_MODE: no OTLP export and no ScopeDB event rows, whatever is configured.
  if (isPrivacyModeOn()) return { tracer: noopTracer, shutdown: async () => {} };
  const endpoint = env.SLOCK_TRACE_OTLP_ENDPOINT?.trim();
  const deploymentResource = traceDeploymentResourceOptions(deploymentIdentity);
  // Bound once the tracer exists; the sink only reports a skipped schema
  // check from a flush, which runs after construction.
  let runtimeTracer: Tracer | null = null;
  const traceEventSink = createTraceEventSinkFromEnv(env, deploymentResource, overrides.traceEventSinkClient, () => runtimeTracer);
  if (!endpoint && !traceEventSink) {
    return {
      tracer: noopTracer,
      shutdown: async () => {},
    };
  }

  const sinks: ShutdownTraceSink[] = [];
  let exportSummary: TraceExportSummary | null = null;
  if (endpoint) {
    exportSummary = createTraceExportSummaryFromEnv(env, deploymentResource, overrides.traceExportSummaryWriter);
    sinks.push(new OtlpHttpTraceSink({
      endpoint,
      serviceName: env.SLOCK_TRACE_SERVICE_NAME || "slock-server",
      deploymentEnvironment: env.DEPLOYMENT_ENV || env.NODE_ENV,
      // `service.version` is the human-readable semver. Keep deploy identity
      // separate so ScopeDB can group broad release trends and exact deploys
      // independently.
      serviceVersion: SERVER_VERSION,
      serviceRevision: env.SLOCK_RELEASE_SHA,
      ...deploymentResource,
      flyAppName: env.FLY_APP_NAME,
      flyImageRef: env.FLY_IMAGE_REF,
      flyMachineId: env.FLY_MACHINE_ID,
      flyInstanceId: env.FLY_INSTANCE_ID,
      flyAllocId: env.FLY_ALLOC_ID,
      flyRegion: env.FLY_REGION,
      batchSize: parsePositiveInt(env.SLOCK_TRACE_BATCH_SIZE, 64),
      flushIntervalMs: parsePositiveInt(env.SLOCK_TRACE_FLUSH_INTERVAL_MS, 1000),
      maxQueueSize: parsePositiveInt(env.SLOCK_TRACE_MAX_QUEUE_SIZE, 4096),
      timeoutMs: parsePositiveInt(env.SLOCK_TRACE_EXPORT_TIMEOUT_MS, 3000),
      ...(overrides.otlpFetch ? { fetchImpl: overrides.otlpFetch } : {}),
      ...(exportSummary ? { observer: exportSummary } : {}),
    }));
    exportSummary?.start();
  }
  if (traceEventSink) sinks.push(traceEventSink);
  const sink = sinks.length === 1 ? sinks[0]! : new FanoutTraceSink(sinks);

  // Wrapped so a stalled event loop can name the background spans still open (./eventLoopStall).
  const tracer = trackActiveSpans(new BasicTracer({ sink: new TraceUserIdTraceSink(sink) }));
  runtimeTracer = tracer;
  return {
    tracer,
    shutdown: async () => {
      const otlpSinks = sinks.filter((shutdownSink) => shutdownSink !== traceEventSink);
      // 1. Flush OTLP first, so a slow ScopeDB drain (up to ~35 s) cannot hold
      //    back the last spans past the server's force-exit deadline.
      // 2. Then the ScopeDB event sink: its last flush can emit a
      //    server.scopedb.schema_check_skipped log event, which only OTLP exports.
      // 3. Then shut OTLP down, exporting what step 2 emitted.
      // fanout-ok: at most two OTLP sinks, HTTP flush only, no database work.
      await Promise.all(otlpSinks.map((otlpSink) => otlpSink instanceof OtlpHttpTraceSink ? otlpSink.flush() : undefined));
      if (traceEventSink) await traceEventSink.shutdown();
      for (const otlpSink of otlpSinks) {
        await otlpSink.shutdown();
      }
      // After the OTLP queues flushed, so their last exports are counted.
      await exportSummary?.stop();
    },
  };
}

/**
 * The OTLP exporter's per-minute counts, written to raft.trace_export_summary
 * with the trace events' ScopeDB endpoint and key (never through OTLP). Needs
 * that pair and RAFT_TRACE_SCOPEDB_SINK=on, the ScopeDB kill switch;
 * RAFT_TRACE_EXPORT_SUMMARY=off turns off only this.
 */
function createTraceExportSummaryFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentResource: TraceDeploymentResourceOptions,
  writer: TraceExportSummaryWriter | undefined,
): TraceExportSummary | null {
  if (env.RAFT_TRACE_EXPORT_SUMMARY?.trim().toLowerCase() === "off") return null;
  if (env.RAFT_TRACE_SCOPEDB_SINK?.trim().toLowerCase() !== "on") return null;
  const endpoint = env.SCOPEDB_TRACE_EVENTS_ENDPOINT?.trim();
  const token = env.SCOPEDB_TRACE_EVENTS_WRITE_KEY?.trim();
  if (!endpoint || !token) return null;
  try {
    return new TraceExportSummary(writer ?? scopeDbTraceExportSummaryWriter(endpoint, token), {
      serviceName: env.SLOCK_TRACE_SERVICE_NAME || "slock-server",
      serviceVersion: SERVER_VERSION,
      serviceRevision: env.SLOCK_RELEASE_SHA,
      serviceInstanceId: deploymentResource.serviceInstanceId,
      ecsTaskId: deploymentResource.ecsTaskId,
      deploymentEnvironment: env.DEPLOYMENT_ENV || env.NODE_ENV,
    });
  } catch (err) {
    console.warn("[trace-export-summary] disabled:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type ShutdownTraceSink = TraceSink & { shutdown(): Promise<void> };

class FanoutTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}

  record(span: CompletedTraceSpan): void {
    for (const sink of this.sinks) {
      try {
        sink.record(span);
      } catch (err) {
        console.warn("[TraceExporter] trace sink failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  recordEvent(record: TraceEventRecord): void {
    for (const sink of this.sinks) {
      if (!sink.recordEvent) continue;
      try {
        sink.recordEvent(record);
      } catch (err) {
        console.warn("[TraceExporter] trace event sink failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  recordSpanFact(record: TraceSpanFactRecord): void {
    for (const sink of this.sinks) {
      if (!sink.recordSpanFact) continue;
      try {
        sink.recordSpanFact(record);
      } catch (err) {
        console.warn("[TraceExporter] trace span-fact sink failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  recordLogEvent(event: TraceLogEvent): void {
    for (const sink of this.sinks) {
      if (!sink.recordLogEvent) continue;
      try {
        sink.recordLogEvent(event);
      } catch (err) {
        console.warn("[TraceExporter] trace log event sink failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

let warnedIgnoredIngestStatement = false;

/** Test seam: the ignored-env warning is once per process. */
export function resetIgnoredIngestStatementWarningForTest(): void {
  warnedIgnoredIngestStatement = false;
}

export const SCOPEDB_SCHEMA_CHECK_SKIPPED_EVENT = "server.scopedb.schema_check_skipped";

/**
 * `server.scopedb.schema_check_skipped`, once per skip window (next to the
 * slock_scopedb_trace_sink_schema_check_skipped_total counter), so otel.logs
 * shows that production wrote trace event rows without the live schema check.
 *
 * No feedback loop through the failing sink: emitEvent with no parent is a
 * standalone log event (BasicTracer -> recordLogEvent), which only the OTLP
 * sink implements (-> /v1/logs -> otel.logs). ScopeDbTraceEventSink has no
 * recordLogEvent, so the event never becomes a raft.trace_events_v2 row and
 * cannot re-enter the flush that skipped the check. Without an OTLP endpoint
 * the event is dropped (the counter still counts the skip).
 */
function emitSchemaCheckSkipped(
  tracer: Tracer | null,
  reason: TraceEventRowV2SchemaCheckSkipReason,
  details: ScopeDbTraceEventSinkSchemaCheckSkip,
): void {
  if (!tracer) return;
  try {
    tracer.emitEvent(SCOPEDB_SCHEMA_CHECK_SKIPPED_EVENT, {
      surface: "server",
      attrs: {
        reason,
        ...(details.httpStatus !== undefined ? { http_status: details.httpStatus } : {}),
        recheck_s: details.recheckMs / 1000,
        table: "raft.trace_events_v2",
      },
    });
  } catch {
    // Observability of the skip must never fail the batch being written.
  }
}

function createTraceEventSinkFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentResource: TraceDeploymentResourceOptions,
  client: ScopeDbTraceEventSinkOptions["client"],
  getTracer: () => Tracer | null,
): ScopeDbTraceEventSink | null {
  const enabled = env.RAFT_TRACE_SCOPEDB_SINK?.trim().toLowerCase();
  if (enabled !== "on") {
    scopeDbTraceSinkEnabled.set(0);
    if (enabled && enabled !== "off") {
      console.warn("[TraceEventRows] ScopeDB event-row sink disabled: RAFT_TRACE_SCOPEDB_SINK must be 'on' or 'off'");
    }
    return null;
  }

  const endpoint = env.SCOPEDB_TRACE_EVENTS_ENDPOINT?.trim();
  const token = env.SCOPEDB_TRACE_EVENTS_WRITE_KEY?.trim();
  // Retired with the move to the scopedb 0.3 Append API, which takes no
  // ScopeQL statement: rows are encoded from the code-owned projection and
  // the live schema check below is the compatibility gate. A value still set
  // in a deployment is ignored (once-per-process warning), never fatal.
  // TODO(AndyLok): delete this branch, its flag and test seam in the first
  // release after SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT is confirmed absent
  // from every deployment env (no repo infra sets it as of the 0.3 move).
  if (env.SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT?.trim() && !warnedIgnoredIngestStatement) {
    warnedIgnoredIngestStatement = true;
    console.warn("[TraceEventRows] SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT is ignored: ScopeDB Append writes the code-owned projection; remove it from the deployment");
  }
  if (!endpoint || !token) {
    scopeDbTraceSinkEnabled.set(0);
    console.warn("[TraceEventRows] ScopeDB event-row sink disabled: enabled flag requires endpoint and write key");
    return null;
  }

  try {
    const sink = new ScopeDbTraceEventSink({
      endpoint,
      token,
      // Every worker writes the current code-owned projection and must
      // observe a compatible live table schema before it can write.
      validateLiveSchema: true,
      ...(client ? { client } : {}),
      serviceName: env.SLOCK_TRACE_SERVICE_NAME || "slock-server",
      deploymentEnvironment: env.DEPLOYMENT_ENV || env.NODE_ENV,
      serviceVersion: SERVER_VERSION,
      serviceRevision: env.SLOCK_RELEASE_SHA,
      ...deploymentResource,
      batchSize: parsePositiveInt(env.SCOPEDB_TRACE_EVENTS_BATCH_SIZE, 512),
      flushIntervalMs: parsePositiveInt(env.SCOPEDB_TRACE_EVENTS_FLUSH_INTERVAL_MS, 4000),
      flushJitterMs: parseNonNegativeInt(env.SCOPEDB_TRACE_EVENTS_FLUSH_JITTER_MS, 1000),
      maxQueueSize: parsePositiveInt(env.SCOPEDB_TRACE_EVENTS_MAX_QUEUE_SIZE, 8192),
      observer: {
        setQueueSize: (size) => scopeDbTraceSinkQueueRows.set(size),
        recordFlush: (outcome, atMs) => {
          scopeDbTraceSinkFlushesTotal.inc({ outcome });
          if (outcome === "success") {
            scopeDbTraceSinkLastSuccessTimestamp.set(atMs / 1000);
          } else {
            scopeDbTraceSinkLastErrorTimestamp.set(atMs / 1000);
          }
        },
        recordRowsExported: (count) => scopeDbTraceSinkRowsExportedTotal.inc(count),
        recordRowsDropped: (reason, count) => scopeDbTraceSinkRowsDroppedTotal.inc({ reason }, count),
        recordSchemaCheckSkipped: (reason, details) => {
          scopeDbTraceSinkSchemaCheckSkippedTotal.inc({ reason });
          emitSchemaCheckSkipped(getTracer(), reason, details);
        },
      },
    });
    scopeDbTraceSinkEnabled.set(1);
    return sink;
  } catch (err) {
    scopeDbTraceSinkEnabled.set(0);
    console.warn("[TraceEventRows] ScopeDB event-row sink disabled:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

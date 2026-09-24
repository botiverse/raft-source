import {
  BasicTracer,
  isTraceEventRowV2CompatibleIngestStatement,
  noopTracer,
  type CompletedTraceSpan,
  type TraceEventRecord,
  type TraceSink,
  type TraceSpanFactRecord,
  type Tracer,
} from "@botiverse/raft-shared";
import { OtlpHttpTraceSink } from "./otlpHttpTraceSink.js";
import { ScopeDbTraceEventSink } from "./scopeDbTraceEventSink.js";
import { SERVER_VERSION } from "../version.js";
import {
  createGeneratedTraceDeploymentIdentity,
  traceDeploymentResourceOptions,
  type TraceDeploymentIdentity,
  type TraceDeploymentResourceOptions,
} from "./traceDeploymentIdentity.js";
import {
  scopeDbTraceSinkEnabled,
  scopeDbTraceSinkFlushesTotal,
  scopeDbTraceSinkLastErrorTimestamp,
  scopeDbTraceSinkLastSuccessTimestamp,
  scopeDbTraceSinkQueueRows,
  scopeDbTraceSinkRowsDroppedTotal,
  scopeDbTraceSinkRowsExportedTotal,
} from "../metrics.js";

export interface ServerTracerRuntime {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

export function createServerTracerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deploymentIdentity: TraceDeploymentIdentity = createGeneratedTraceDeploymentIdentity("non_ecs"),
): ServerTracerRuntime {
  const endpoint = env.SLOCK_TRACE_OTLP_ENDPOINT?.trim();
  const deploymentResource = traceDeploymentResourceOptions(deploymentIdentity);
  const traceEventSink = createTraceEventSinkFromEnv(env, deploymentResource);
  if (!endpoint && !traceEventSink) {
    return {
      tracer: noopTracer,
      shutdown: async () => {},
    };
  }

  const sinks: ShutdownTraceSink[] = [];
  if (endpoint) {
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
    }));
  }
  if (traceEventSink) sinks.push(traceEventSink);
  const sink = sinks.length === 1 ? sinks[0]! : new FanoutTraceSink(sinks);

  return {
    tracer: new BasicTracer({ sink }),
    shutdown: async () => {
      for (const shutdownSink of sinks) {
        await shutdownSink.shutdown();
      }
    },
  };
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
}

function createTraceEventSinkFromEnv(
  env: NodeJS.ProcessEnv,
  deploymentResource: TraceDeploymentResourceOptions,
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
  const configuredIngestStatement = env.SCOPEDB_TRACE_EVENTS_INGEST_STATEMENT?.trim();
  if (configuredIngestStatement && !isTraceEventRowV2CompatibleIngestStatement(configuredIngestStatement)) {
    scopeDbTraceSinkEnabled.set(0);
    console.warn("[TraceEventRows] ScopeDB event-row sink disabled: configured ingest statement must match a code-owned compatible projection");
    return null;
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
      // The compatibility override is validation-only: every new worker uses
      // the current code-owned statement and must observe the expanded schema
      // before it can write. Old workers keep their explicit legacy insert.
      validateLiveSchema: true,
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

import type { CompletedTraceSpan, TraceAttributes, TraceLogEvent, TraceSink, TraceSpanKind, TraceStatus } from "@botiverse/raft-shared";

export type OtlpHttpTraceSinkFetch = (
  input: string | URL,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OtlpHttpTraceSinkOptions {
  endpoint: string;
  serviceName: string;
  deploymentEnvironment?: string;
  serviceVersion?: string;
  serviceRevision?: string;
  serviceInstanceId?: string;
  deploymentInstanceSource?: string;
  deploymentIdentityState?: string;
  ecsTaskId?: string;
  ecsTaskFamily?: string;
  ecsTaskRevision?: string;
  flyAppName?: string;
  flyImageRef?: string;
  flyMachineId?: string;
  flyInstanceId?: string;
  flyAllocId?: string;
  flyRegion?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  timeoutMs?: number;
  fetchImpl?: OtlpHttpTraceSinkFetch;
  onError?: (err: Error) => void;
  /** Counts what each queue sent, dropped and failed (./traceExportSummary). */
  observer?: OtlpExportObserver;
}

export type OtlpSignal = "traces" | "logs";
export type OtlpExportFailureKind = "timeout" | "network" | "http_429" | "http_4xx" | "http_5xx";

export interface OtlpExportFailure {
  kind: OtlpExportFailureKind;
  httpStatus?: number;
}

export interface OtlpExportObserver {
  exported(signal: OtlpSignal, items: number, durationMs: number): void;
  exportFailed(signal: OtlpSignal, items: number, durationMs: number, failure: OtlpExportFailure): void;
  droppedQueueFull(signal: OtlpSignal, items: number): void;
  queueDepth(signal: OtlpSignal, depth: number): void;
}

class OtlpHttpStatusError extends Error {
  constructor(readonly status: number, body: string) {
    super(`OTLP HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

/** Bounded kind only: the message can carry Telescope's response text. */
export function otlpExportFailureOf(err: unknown): OtlpExportFailure {
  if (err instanceof OtlpHttpStatusError) {
    const kind = err.status === 429 ? "http_429" : err.status >= 500 ? "http_5xx" : "http_4xx";
    return { kind, httpStatus: err.status };
  }
  // post() aborts the fetch at timeoutMs; fetch rejects with an AbortError.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return { kind: "timeout" };
  return { kind: "network" };
}

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

type OtlpAttribute = {
  key: string;
  value: OtlpAnyValue;
};

type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  events?: Array<{
    timeUnixNano: string;
    name: string;
    attributes?: OtlpAttribute[];
  }>;
  status: {
    code: number;
    message?: string;
  };
};

type OtlpLogRecord = {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  eventName: string;
  body: { stringValue: string };
  traceId: string;
  spanId: string;
  attributes: OtlpAttribute[];
};

// Version of the standalone event record shape sent as an OTLP log.
export const TRACE_EVENT_SCHEMA_VERSION = 1;

/**
 * Best-effort bridge from Slock's lightweight tracing contract to OTLP/HTTP JSON.
 * It never blocks the span producer path: spans and standalone events enter
 * bounded queues and are dropped oldest first if the exporter cannot keep up.
 * Spans go to `/v1/traces`; standalone events go to `/v1/logs`.
 */
export class OtlpHttpTraceSink implements TraceSink {
  private readonly tracesEndpoint: string;
  private readonly logsEndpoint: string;
  private readonly serviceName: string;
  private readonly deploymentEnvironment?: string;
  private readonly serviceVersion?: string;
  private readonly serviceRevision?: string;
  private readonly serviceInstanceId?: string;
  private readonly deploymentInstanceSource?: string;
  private readonly deploymentIdentityState?: string;
  private readonly ecsTaskId?: string;
  private readonly ecsTaskFamily?: string;
  private readonly ecsTaskRevision?: string;
  private readonly flyAppName?: string;
  private readonly flyImageRef?: string;
  private readonly flyMachineId?: string;
  private readonly flyInstanceId?: string;
  private readonly flyAllocId?: string;
  private readonly flyRegion?: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: OtlpHttpTraceSinkFetch;
  private readonly spanQueue: ExportQueue<CompletedTraceSpan>;
  private readonly eventQueue: ExportQueue<TraceLogEvent>;

  constructor(options: OtlpHttpTraceSinkOptions) {
    this.tracesEndpoint = normalizeOtlpTracesEndpoint(options.endpoint);
    this.logsEndpoint = otlpLogsEndpointFor(this.tracesEndpoint);
    this.serviceName = options.serviceName;
    this.deploymentEnvironment = options.deploymentEnvironment;
    this.serviceVersion = options.serviceVersion;
    this.serviceRevision = options.serviceRevision;
    this.serviceInstanceId = options.serviceInstanceId;
    this.deploymentInstanceSource = options.deploymentInstanceSource;
    this.deploymentIdentityState = options.deploymentIdentityState;
    this.ecsTaskId = options.ecsTaskId;
    this.ecsTaskFamily = options.ecsTaskFamily;
    this.ecsTaskRevision = options.ecsTaskRevision;
    this.flyAppName = options.flyAppName;
    this.flyImageRef = options.flyImageRef;
    this.flyMachineId = options.flyMachineId;
    this.flyInstanceId = options.flyInstanceId;
    this.flyAllocId = options.flyAllocId;
    this.flyRegion = options.flyRegion;
    this.headers = {
      "content-type": "application/json",
      ...options.headers,
    };
    const batchSize = Math.max(1, options.batchSize ?? 64);
    const queueOptions = {
      batchSize,
      flushIntervalMs: Math.max(1, options.flushIntervalMs ?? 1000),
      maxQueueSize: Math.max(batchSize, options.maxQueueSize ?? 4096),
      onError: options.onError ?? ((err: Error) => console.warn("[TraceExporter] OTLP export failed:", err.message)),
    };
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 3000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.spanQueue = new ExportQueue({
      ...queueOptions,
      signal: "traces",
      observer: options.observer,
      exportBatch: (spans) => this.post(this.tracesEndpoint, this.toOtlpPayload(spans)),
    });
    this.eventQueue = new ExportQueue({
      ...queueOptions,
      signal: "logs",
      observer: options.observer,
      exportBatch: (events) => this.post(this.logsEndpoint, this.toOtlpLogsPayload(events)),
    });
  }

  record(span: CompletedTraceSpan): void {
    this.spanQueue.add(span);
  }

  recordLogEvent(event: TraceLogEvent): void {
    this.eventQueue.add(event);
  }

  getDroppedCount(): number {
    return this.spanQueue.droppedCount + this.eventQueue.droppedCount;
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.spanQueue.shutdown(), this.eventQueue.shutdown()]);
  }

  async flush(): Promise<void> {
    await Promise.all([this.spanQueue.flush(), this.eventQueue.flush()]);
  }

  private async post(endpoint: string, payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new OtlpHttpStatusError(response.status, body);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private toOtlpPayload(spans: readonly CompletedTraceSpan[]) {
    return {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [
            {
              scope: {
                name: "@botiverse/raft-server",
              },
              spans: spans.map((span) => toOtlpSpan(span)),
            },
          ],
        },
      ],
    };
  }

  private toOtlpLogsPayload(events: readonly TraceLogEvent[]) {
    return {
      resourceLogs: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeLogs: [
            {
              scope: {
                name: "@botiverse/raft-server",
              },
              logRecords: events.map((event) => toOtlpLogRecord(event)),
            },
          ],
        },
      ],
    };
  }

  private resourceAttributes(): OtlpAttribute[] {
    return compactAttributes({
      "service.name": this.serviceName,
      "service.version": this.serviceVersion,
      "service.revision": this.serviceRevision,
      "service.instance.id": this.serviceInstanceId,
      "slock.deployment_instance_source": this.deploymentInstanceSource,
      "slock.deployment_identity_state": this.deploymentIdentityState,
      "slock.ecs_task_id": this.ecsTaskId,
      "aws.ecs.task.family": this.ecsTaskFamily,
      "aws.ecs.task.revision": this.ecsTaskRevision,
      "slock.fly_app_name": this.flyAppName,
      "slock.fly_image_ref": this.flyImageRef,
      "slock.fly_machine_id": this.flyMachineId,
      "slock.fly_instance_id": this.flyInstanceId,
      "slock.fly_alloc_id": this.flyAllocId,
      "slock.fly_region": this.flyRegion,
      "deployment.environment": this.deploymentEnvironment,
      "telemetry.sdk.name": "slock-basic-tracer",
    });
  }
}

interface ExportQueueOptions<T> {
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  onError: (err: Error) => void;
  signal: OtlpSignal;
  observer?: OtlpExportObserver;
  exportBatch: (items: readonly T[]) => Promise<void>;
}

class ExportQueue<T> {
  private readonly items: T[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  droppedCount = 0;

  constructor(private readonly options: ExportQueueOptions<T>) {}

  add(item: T): void {
    if (this.items.length >= this.options.maxQueueSize) {
      this.items.shift();
      this.droppedCount += 1;
      this.options.observer?.droppedQueueFull(this.options.signal, 1);
    }
    this.items.push(item);
    this.options.observer?.queueDepth(this.options.signal, this.items.length);

    if (this.items.length >= this.options.batchSize) {
      void this.flush();
      return;
    }

    this.scheduleFlush();
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.items.length === 0) return;

    this.flushing = true;
    const batch = this.items.splice(0, this.options.batchSize);
    const startedMs = Date.now();

    try {
      await this.options.exportBatch(batch);
      this.options.observer?.exported(this.options.signal, batch.length, Date.now() - startedMs);
    } catch (err) {
      this.droppedCount += batch.length;
      this.options.observer?.exportFailed(this.options.signal, batch.length, Date.now() - startedMs, otlpExportFailureOf(err));
      this.options.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.flushing = false;
      if (this.items.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushIntervalMs);
    this.flushTimer.unref?.();
  }
}

export function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const withoutTrailingSlash = withScheme.replace(/\/+$/, "");
  if (withoutTrailingSlash.endsWith("/v1/traces")) {
    return withoutTrailingSlash;
  }
  return `${withoutTrailingSlash}/v1/traces`;
}

export function otlpLogsEndpointFor(tracesEndpoint: string): string {
  return tracesEndpoint.replace(/\/v1\/traces$/, "/v1/logs");
}

// Telescope keeps the log body but drops `eventName`, so the event name is
// also written as the body string.
export function toOtlpLogRecord(event: TraceLogEvent): OtlpLogRecord {
  const timeUnixNano = msToUnixNano(event.timeMs);
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: "INFO",
    eventName: event.name,
    body: { stringValue: event.name },
    traceId: event.context?.traceId ?? "",
    spanId: event.context?.spanId ?? "",
    attributes: compactAttributes({
      ...event.attrs,
      "slock.surface": event.surface,
      "slock.schema_version": TRACE_EVENT_SCHEMA_VERSION,
    }),
  };
}

export function toOtlpSpan(span: CompletedTraceSpan): OtlpSpan {
  const attrs = compactAttributes({
    ...span.attrs,
    "slock.surface": span.surface,
    "slock.duration_ms": span.durationMs,
  });
  const events = span.events.map((event) => {
    const eventAttrs = compactAttributes(event.attrs ?? {});
    return {
      timeUnixNano: msToUnixNano(event.timeMs),
      name: event.name,
      ...(eventAttrs.length > 0 ? { attributes: eventAttrs } : {}),
    };
  });

  return {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    ...(span.context.parentSpanId ? { parentSpanId: span.context.parentSpanId } : {}),
    name: span.name,
    kind: toOtlpSpanKind(span.kind),
    startTimeUnixNano: msToUnixNano(span.startTimeMs),
    endTimeUnixNano: msToUnixNano(span.endTimeMs),
    ...(attrs.length > 0 ? { attributes: attrs } : {}),
    ...(events.length > 0 ? { events } : {}),
    status: toOtlpStatus(span.status),
  };
}

function toOtlpSpanKind(kind: TraceSpanKind): number {
  switch (kind) {
    case "internal":
      return 1;
    case "server":
      return 2;
    case "client":
      return 3;
    case "producer":
      return 4;
    case "consumer":
      return 5;
  }
}

function toOtlpStatus(status: TraceStatus): OtlpSpan["status"] {
  if (status === "unset") {
    return { code: 0 };
  }
  if (status === "ok") {
    return { code: 1 };
  }
  return {
    code: 2,
    message: status,
  };
}

function compactAttributes(attrs: TraceAttributes): OtlpAttribute[] {
  return Object.entries(attrs)
    .map(([key, value]) => toOtlpAttribute(key, value))
    .filter((attr): attr is OtlpAttribute => attr !== null);
}

function toOtlpAttribute(key: string, value: unknown): OtlpAttribute | null {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  const converted = toOtlpAnyValue(value);
  return converted ? { key, value: converted } : null;
}

function toOtlpAnyValue(value: unknown): OtlpAnyValue | null {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }
  if (value === null) {
    return { stringValue: "null" };
  }
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

function msToUnixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

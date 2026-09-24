import type { CompletedTraceSpan, TraceAttributes, TraceSink, TraceSpanKind, TraceStatus } from "@botiverse/raft-shared";

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

/**
 * Best-effort bridge from Slock's lightweight tracing contract to OTLP/HTTP JSON.
 * It never blocks the span producer path: spans enter a bounded queue and are
 * dropped oldest-first if the exporter cannot keep up.
 */
export class OtlpHttpTraceSink implements TraceSink {
  private readonly endpoint: string;
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
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: OtlpHttpTraceSinkFetch;
  private readonly onError: (err: Error) => void;
  private readonly queue: CompletedTraceSpan[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private droppedCount = 0;

  constructor(options: OtlpHttpTraceSinkOptions) {
    this.endpoint = normalizeOtlpTracesEndpoint(options.endpoint);
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
    this.batchSize = Math.max(1, options.batchSize ?? 64);
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? 1000);
    this.maxQueueSize = Math.max(this.batchSize, options.maxQueueSize ?? 4096);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 3000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onError = options.onError ?? ((err) => console.warn("[TraceExporter] OTLP export failed:", err.message));
  }

  record(span: CompletedTraceSpan): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(span);

    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }

    this.scheduleFlush();
  }

  getDroppedCount(): number {
    return this.droppedCount;
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
    if (this.queue.length === 0) return;

    this.flushing = true;
    const spans = this.queue.splice(0, this.batchSize);

    try {
      await this.exportBatch(spans);
    } catch (err) {
      this.droppedCount += spans.length;
      this.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private async exportBatch(spans: readonly CompletedTraceSpan[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.toOtlpPayload(spans)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OTLP HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private toOtlpPayload(spans: readonly CompletedTraceSpan[]) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: compactAttributes({
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
            }),
          },
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

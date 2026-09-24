import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompletedTraceSpan, TraceAttributes, TraceEvent, TraceSink } from "@botiverse/raft-shared";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FILES = 8;
// Contract v0 permits only schema-owned raw IDs; other IDs need explicit review.
const DIAGNOSTIC_ID_ATTRS = new Set([
  "serverId",
  "machineId",
  "agentId",
  "messageId",
  "launchId",
  "uploadId",
  "bundleId",
  "deliveryId",
  "deliveryCorrelationId",
  "delivery_correlation_id",
  "agent_id",
  "server_id",
  "machine_id",
  "process_instance_id",
  "launch_id",
  "correlation_id",
  "migration_attempt_id",
  "operation_id",
]);

const DIAGNOSTIC_ERROR_ATTRS = new Set([
  "runtime_error_class",
  "runtime_error_fingerprint",
  "runtime_error_http_status",
  "runtime_error_message_present",
  "runtime_error_message_length_bucket",
  "runtime_error_message_truncated",
  "runtime_error_message_excerpt",
  "original_message",
]);

export interface LocalRotatingTraceSinkOptions {
  machineDir: string;
  maxFileBytes?: number;
  maxFileAgeMs?: number;
  /**
   * Stable per-machine jitter added to `maxFileAgeMs`. Keeps the age-rotation
   * tick out of phase across daemons so a synchronized restart does not pin
   * every machine to the same 5-minute rotation boundary. Applied once at
   * construction time (deterministic — same machine always gets the same
   * effective age). See `traceJitter.ts`.
   */
  maxFileAgeJitterMs?: number;
  maxFiles?: number;
  nowMsProvider?: () => number;
}

export class LocalRotatingTraceSink implements TraceSink {
  private readonly traceDir: string;
  private readonly maxFileBytes: number;
  private readonly maxFileAgeMs: number;
  private readonly maxFiles: number;
  private readonly nowMsProvider: () => number;
  private currentFile: string | null = null;
  private currentFileOpenedAtMs: number | null = null;
  private currentSize = 0;
  private sequence = 0;

  constructor(options: LocalRotatingTraceSinkOptions) {
    this.traceDir = path.join(options.machineDir, "traces");
    this.maxFileBytes = Math.max(1024, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    const baseAgeMs = Math.max(1000, Math.floor(options.maxFileAgeMs ?? DEFAULT_MAX_FILE_AGE_MS));
    const ageJitterMs = Math.max(0, Math.floor(options.maxFileAgeJitterMs ?? 0));
    this.maxFileAgeMs = baseAgeMs + ageJitterMs;
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES));
    this.nowMsProvider = options.nowMsProvider ?? Date.now;
  }

  /** Exposed for observability — the effective rotation age after jitter. */
  getMaxFileAgeMs(): number {
    return this.maxFileAgeMs;
  }

  record(span: CompletedTraceSpan): void {
    try {
      const line = `${JSON.stringify(toLocalTraceRecord(span))}\n`;
      this.ensureFile(Buffer.byteLength(line));
      appendFileSync(this.currentFile!, line, { encoding: "utf8" });
      this.currentSize += Buffer.byteLength(line);
    } catch {
      // Local tracing must never affect daemon/runtime behavior.
    }
  }

  getCurrentFile(): string | null {
    return this.currentFile;
  }

  private ensureFile(nextBytes: number): void {
    mkdirSync(this.traceDir, { recursive: true, mode: 0o700 });

    const nowMs = this.nowMsProvider();
    const shouldRotateForAge = this.currentFileOpenedAtMs !== null && nowMs - this.currentFileOpenedAtMs >= this.maxFileAgeMs;
    if (!this.currentFile || this.currentSize + nextBytes > this.maxFileBytes || shouldRotateForAge) {
      this.currentFile = path.join(
        this.traceDir,
        `daemon-trace-${safeTimestamp(nowMs)}-${process.pid}-${String(this.sequence++).padStart(4, "0")}.jsonl`,
      );
      writeFileSync(this.currentFile, "", { flag: "a", mode: 0o600 });
      this.currentSize = statSync(this.currentFile).size;
      this.currentFileOpenedAtMs = nowMs;
      this.pruneOldFiles();
    }
  }

  private pruneOldFiles(): void {
    const files = readdirSync(this.traceDir)
      .filter((name) => name.startsWith("daemon-trace-") && name.endsWith(".jsonl"))
      .sort();
    const excess = files.length - this.maxFiles;
    if (excess <= 0) return;
    for (const file of files.slice(0, excess)) {
      rmSync(path.join(this.traceDir, file), { force: true });
    }
  }
}

function safeTimestamp(timeMs: number): string {
  return new Date(timeMs).toISOString().replace(/[:.]/g, "-");
}

function toLocalTraceRecord(span: CompletedTraceSpan): Record<string, unknown> {
  return {
    type: "span",
    schema_version: 1,
    trace_id: span.context.traceId,
    span_id: span.context.spanId,
    parent_span_id: span.context.parentSpanId,
    name: span.name,
    surface: span.surface,
    kind: span.kind,
    status: span.status,
    start_time: new Date(span.startTimeMs).toISOString(),
    end_time: new Date(span.endTimeMs).toISOString(),
    duration_ms: span.durationMs,
    attrs: sanitizeAttrs(span.attrs),
    events: span.events.map(sanitizeEvent),
  };
}

function sanitizeEvent(event: TraceEvent): Record<string, unknown> {
  return {
    name: event.name,
    time: new Date(event.timeMs).toISOString(),
    attrs: sanitizeAttrs(event.attrs),
  };
}

function sanitizeAttrs(attrs: TraceAttributes | undefined): TraceAttributes | undefined {
  if (!attrs) return undefined;
  const sanitized: TraceAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === "") continue;
    if (isDiagnosticIdAttr(key)) {
      sanitized[key] = sanitizeValue(value);
      continue;
    }
    if (isDiagnosticErrorAttr(key)) {
      sanitized[key] = sanitizeDiagnosticErrorValue(key, value);
      continue;
    }
    if (shouldDropAttr(key)) continue;
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return { items_count: value.length };
  }
  if (typeof value === "object") {
    return { object_present: true };
  }
  return String(value);
}

function sanitizeDiagnosticErrorValue(key: string, value: unknown): unknown {
  if (key !== "original_message" || typeof value !== "string") return sanitizeValue(value);
  const normalized = value
    .replace(/sk_(?:agent|machine|computer)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function shouldDropAttr(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(^|_)(api_key|auth_token|token|secret|password|cookie|credential)(_|$)/i.test(normalized)) {
    return true;
  }
  if (/(^|_)(count|present|kind|mode|source|outcome|reason|class|status|bucket|ms|code|truncated)$/.test(normalized)) {
    return false;
  }
  if (/(^|_)id$/.test(normalized)) {
    return true;
  }
  return /(^|_)(prompt|content|text|message|body|request|response|command|argv|env|cwd|path|file|error|tool_args|tool_input|tool_output|stdout|stderr)(_|$)/i
    .test(normalized);
}

function isDiagnosticIdAttr(key: string): boolean {
  return DIAGNOSTIC_ID_ATTRS.has(key);
}

function isDiagnosticErrorAttr(key: string): boolean {
  return DIAGNOSTIC_ERROR_ATTRS.has(key);
}

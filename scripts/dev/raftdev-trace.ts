/**
 * Local OTLP JSONL reader used by `./raftdev trace`.
 *
 * The collector appends while this command is running, so each read is a
 * bounded snapshot: stat the file once, then read at most that initial byte
 * count. A final unterminated JSON fragment is therefore expected and is
 * reported as a warning; malformed newline-terminated input is a hard data
 * error and never degrades into an empty result.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type TraceAttributeValue =
  | string
  | number
  | boolean
  | null
  | TraceAttributeValue[]
  | { [key: string]: TraceAttributeValue };

export type TraceAttributes = Record<string, TraceAttributeValue>;
export type ServiceSegment = "web" | "server" | "daemon" | "other";

export interface FlatTraceEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: TraceAttributes;
}

export interface FlatTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  segment: ServiceSegment;
  resourceAttributes: TraceAttributes;
  attributes: TraceAttributes;
  events: FlatTraceEvent[];
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  kind?: string | number;
  statusCode?: string | number;
  statusMessage?: string;
  sourceLine: number;
}

export interface TraceReadResult {
  path: string;
  exists: boolean;
  snapshotBytes: number;
  mtimeMs: number;
  observedBytesAfterRead: number;
  observedMtimeMsAfterRead: number;
  tailState: "empty" | "newline-terminated" | "valid-unterminated" | "partial-fragment" | "oversize";
  completeLines: number;
  batches: number;
  spans: FlatTraceSpan[];
  exactDuplicates: number;
  warnings: string[];
  errors: string[];
}

export interface RunTraceCliOptions {
  projectDir: string;
  defaultEnvName: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => number;
}

interface ParsedTraceArgs {
  command: "last" | "find" | "show";
  envName: string;
  sinceMs: number;
  waitMs: number;
  limit: number;
  raw: boolean;
  family?: string;
  traceId?: string;
}

interface TraceMatch {
  type: "span" | "event";
  span: FlatTraceSpan;
  event?: FlatTraceEvent;
  timeUnixNano: bigint;
}

type ReaderMode = "local" | "remote" | "worker-disabled" | "observe-disabled";
type ReaderStatus = "starting" | "ready" | "failed" | "stopped";

interface ReaderState {
  schemaVersion: 1;
  mode: ReaderMode;
  status: ReaderStatus;
  startedAt: string;
  startedAtMs: number;
}

interface ReaderStateSnapshot {
  exists: boolean;
  fingerprint: string;
  state?: ReaderState;
  error?: string;
}

interface SourceStatSnapshot {
  exists: boolean;
  fingerprint: string;
  size: number;
  mtimeMs: number;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const DEFAULT_SINCE_MS = 15 * 60_000;
const DEFAULT_WAIT_MS = 12_000;
const MAX_WAIT_MS = 30_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_READER_STATE_BYTES = 16 * 1024;
const MATCH_QUIET_MS = 500;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// The in-process server exporter normally flushes in <=1s. `last` gives that
// just-finished action a small chance to persist instead of instantly
// selecting an older root already on disk. This is still best-effort: output
// deliberately says "latest persisted", never "complete".
const LAST_INITIAL_SETTLE_MS = 1_250;

const SAFE_ATTRIBUTE_KEYS = new Set([
  "action",
  "component",
  "db.operation.name",
  "db.system",
  "decision",
  "deployment.environment",
  "environment",
  "error.class",
  "error.code",
  "error.kind",
  "error.type",
  "error_class",
  "error_subkind",
  "exception.type",
  "http.flavor",
  "http.method",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "http.status_code",
  "method",
  "network.protocol.version",
  "operation",
  "operation.name",
  "outcome",
  "phase",
  "query_name",
  "reason",
  "revision",
  "route",
  "rpc.method",
  "rpc.service",
  "rpc.system",
  "service.revision",
  "service.version",
  "slock.duration_ms",
  "slock.schema_version",
  "slock.surface",
  "sqlstate",
  "status",
  "status_code",
  "version",
]);

const SAFE_NUMERIC_SUFFIX = /(?:^|[._])(?:bucket|count|duration_ms|ms|present)$/;
const SAFE_TOKEN_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_ATTRIBUTE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  }
  return undefined;
}

/** Decode an OTLP AnyValue, including nested array and kvlist forms. */
export function decodeAnyValue(value: unknown): TraceAttributeValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(decodeAnyValue);
  if (!isRecord(value)) return String(value);

  const stringValue = field(value, "stringValue", "string_value");
  if (stringValue !== undefined) return String(stringValue);
  const boolValue = field(value, "boolValue", "bool_value");
  if (boolValue !== undefined) return Boolean(boolValue);
  const intValue = field(value, "intValue", "int_value");
  if (intValue !== undefined) return typeof intValue === "number" ? intValue : String(intValue);
  const doubleValue = field(value, "doubleValue", "double_value");
  if (doubleValue !== undefined) return Number(doubleValue);
  const bytesValue = field(value, "bytesValue", "bytes_value");
  if (bytesValue !== undefined) return String(bytesValue);

  const arrayValue = field(value, "arrayValue", "array_value");
  if (isRecord(arrayValue)) {
    const values = field(arrayValue, "values");
    return Array.isArray(values) ? values.map(decodeAnyValue) : [];
  }

  const kvlistValue = field(value, "kvlistValue", "kvlist_value");
  if (isRecord(kvlistValue)) {
    return decodeKeyValues(field(kvlistValue, "values"));
  }

  // Be liberal for hand-authored/local fixtures while still recursively
  // preserving structure. Real OTLP values take one of the branches above.
  const decoded = Object.create(null) as Record<string, TraceAttributeValue>;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) throw new Error("OTLP AnyValue contains a forbidden object key");
    decoded[key] = decodeAnyValue(nested);
  }
  return decoded;
}

/** Decode OTLP [{key,value}] attributes into a deterministic object. */
export function decodeKeyValues(value: unknown): TraceAttributes {
  const result = Object.create(null) as TraceAttributes;
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== "string") continue;
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(entry.key)) {
      throw new Error("OTLP attributes contain a forbidden key");
    }
    if (Object.prototype.hasOwnProperty.call(result, entry.key)) {
      throw new Error("OTLP attributes contain a duplicate key");
    }
    result[entry.key] = decodeAnyValue(entry.value);
  }
  return result;
}

/** Classify known local service names without treating unknown services as absent. */
export function classifyService(serviceName: string): ServiceSegment {
  const normalized = serviceName.toLowerCase();
  if (/(?:^|[-_.])web(?:$|[-_.])/.test(normalized)) return "web";
  if (/(?:^|[-_.])server(?:$|[-_.])/.test(normalized)) return "server";
  if (/(?:^|[-_.])daemon(?:$|[-_.])/.test(normalized)) return "daemon";
  return "other";
}

function parseNano(value: unknown, label: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${label} is missing or is not an integer`);
  }
  const raw = String(value);
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is not an unsigned integer: ${JSON.stringify(raw)}`);
  return BigInt(raw);
}

function normalizeTraceId(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.toLowerCase() : "";
  if (!TRACE_ID_RE.test(id) || /^0+$/.test(id)) throw new Error(`${label} must be 32 non-zero hex characters`);
  return id;
}

function normalizeSpanId(value: unknown, label: string, optional = false): string | undefined {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  const id = typeof value === "string" ? value.toLowerCase() : "";
  if (!SPAN_ID_RE.test(id) || /^0+$/.test(id)) throw new Error(`${label} must be 16 non-zero hex characters`);
  return id;
}

function flattenEvent(value: unknown, line: number, spanLabel: string): FlatTraceEvent {
  if (!isRecord(value)) throw new Error(`${spanLabel} event at line ${line} is not an object`);
  const name = field(value, "name");
  if (typeof name !== "string" || name.length === 0) throw new Error(`${spanLabel} event at line ${line} has no name`);
  return {
    name,
    timeUnixNano: parseNano(field(value, "timeUnixNano", "time_unix_nano"), `${spanLabel} event ${name} timeUnixNano`),
    attributes: decodeKeyValues(field(value, "attributes")),
  };
}

function flattenSpan(
  value: unknown,
  resourceAttributes: TraceAttributes,
  line: number,
): FlatTraceSpan {
  if (!isRecord(value)) throw new Error(`span at line ${line} is not an object`);
  const name = field(value, "name");
  if (typeof name !== "string" || name.length === 0) throw new Error(`span at line ${line} has no name`);
  const traceId = normalizeTraceId(field(value, "traceId", "trace_id", "traceID"), `span ${name} traceId`);
  const spanId = normalizeSpanId(field(value, "spanId", "span_id", "spanID"), `span ${name} spanId`)!;
  const parentSpanId = normalizeSpanId(
    field(value, "parentSpanId", "parent_span_id", "parentSpanID"),
    `span ${name} parentSpanId`,
    true,
  );
  const spanAttributes = decodeKeyValues(field(value, "attributes"));
  const serviceValue = resourceAttributes["service.name"];
  const serviceName = typeof serviceValue === "string" && serviceValue.length > 0 ? serviceValue : "unknown";
  const surfaceValue = spanAttributes["slock.surface"];
  const surfaceSegment = typeof surfaceValue === "string" ? classifyService(surfaceValue) : "other";
  const eventsValue = field(value, "events");
  const statusValue = field(value, "status");
  const status = isRecord(statusValue) ? statusValue : {};
  const events = Array.isArray(eventsValue)
    ? eventsValue.map((event) => flattenEvent(event, line, `span ${name}`))
    : [];
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    serviceName,
    segment: surfaceSegment === "other" ? classifyService(serviceName) : surfaceSegment,
    resourceAttributes,
    attributes: spanAttributes,
    events,
    startTimeUnixNano: parseNano(field(value, "startTimeUnixNano", "start_time_unix_nano"), `span ${name} startTimeUnixNano`),
    endTimeUnixNano: parseNano(field(value, "endTimeUnixNano", "end_time_unix_nano"), `span ${name} endTimeUnixNano`),
    ...(field(value, "kind") !== undefined ? { kind: field(value, "kind") as string | number } : {}),
    ...(field(status, "code") !== undefined ? { statusCode: field(status, "code") as string | number } : {}),
    ...(typeof field(status, "message") === "string" ? { statusMessage: field(status, "message") as string } : {}),
    sourceLine: line,
  };
}

/** Flatten one OTLP ExportTraceServiceRequest-shaped document. */
export function flattenOtlpDocument(document: unknown, line = 1): FlatTraceSpan[] {
  if (!isRecord(document)) throw new Error(`OTLP document at line ${line} is not an object`);
  const resourceSpansValue = field(document, "resourceSpans", "resource_spans");
  if (!Array.isArray(resourceSpansValue)) {
    throw new Error(`OTLP document at line ${line} has no resourceSpans array`);
  }
  const spans: FlatTraceSpan[] = [];
  for (const resourceSpan of resourceSpansValue) {
    if (!isRecord(resourceSpan)) throw new Error(`resourceSpans entry at line ${line} is not an object`);
    const resource = field(resourceSpan, "resource");
    const resourceAttributes = isRecord(resource)
      ? decodeKeyValues(field(resource, "attributes"))
      : {};
    const scopeSpansValue = field(
      resourceSpan,
      "scopeSpans",
      "scope_spans",
      "instrumentationLibrarySpans",
      "instrumentation_library_spans",
    );
    if (!Array.isArray(scopeSpansValue)) continue;
    for (const scopeSpan of scopeSpansValue) {
      if (!isRecord(scopeSpan)) throw new Error(`scopeSpans entry at line ${line} is not an object`);
      const spanValues = field(scopeSpan, "spans");
      if (!Array.isArray(spanValues)) continue;
      for (const spanValue of spanValues) spans.push(flattenSpan(spanValue, resourceAttributes, line));
    }
  }
  return spans;
}

function stableValue(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function spanFingerprint(span: FlatTraceSpan): string {
  const { sourceLine: _sourceLine, ...stableSpan } = span;
  return stableValue(stableSpan);
}

function emptyReadResult(path: string): TraceReadResult {
  return {
    path,
    exists: false,
    snapshotBytes: 0,
    mtimeMs: 0,
    observedBytesAfterRead: 0,
    observedMtimeMsAfterRead: 0,
    tailState: "empty",
    completeLines: 0,
    batches: 0,
    spans: [],
    exactDuplicates: 0,
    warnings: [],
    errors: [],
  };
}

/**
 * Read one bounded snapshot of an append-only collector file.
 *
 * A file that grows after stat() is deliberately not chased. The caller may
 * poll this function during its bounded --wait window for a later snapshot.
 */
export async function readTraceFile(path: string): Promise<TraceReadResult> {
  const result = emptyReadResult(path);
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return result;
    throw error;
  }
  result.exists = true;
  result.snapshotBytes = metadata.size;
  result.mtimeMs = metadata.mtimeMs;
  result.observedBytesAfterRead = metadata.size;
  result.observedMtimeMsAfterRead = metadata.mtimeMs;
  if (metadata.size === 0) return result;
  if (metadata.size > MAX_TRACE_SNAPSHOT_BYTES) {
    result.tailState = "oversize";
    result.errors.push(
      `trace snapshot is ${metadata.size} bytes, above the ${MAX_TRACE_SNAPSHOT_BYTES} byte read cap; ` +
      "archive or remove the local trace artifact before retrying",
    );
    return result;
  }

  let pending = "";
  let pendingBytes = 0;
  let discardingOversizeLine = false;
  let lineNumber = 0;
  const unique = new Map<string, { fingerprint: string; span: FlatTraceSpan }>();
  const consumeDocument = (document: unknown, line: number): void => {
    let flattened: FlatTraceSpan[];
    try {
      flattened = flattenOtlpDocument(document, line);
      result.batches += 1;
    } catch {
      // Flattening errors can include dynamic span names/attribute values.
      // Preserve only the location and category in default diagnostics.
      result.errors.push(`invalid OTLP trace shape at line ${line}`);
      return;
    }
    for (const span of flattened) {
      // A span id is unique within a trace. Service/resource changes on the
      // same identity are conflicts, not separate spans.
      const key = `${span.traceId}:${span.spanId}`;
      const fingerprint = spanFingerprint(span);
      const previous = unique.get(key);
      if (!previous) {
        unique.set(key, { fingerprint, span });
      } else if (previous.fingerprint === fingerprint) {
        result.exactDuplicates += 1;
      } else {
        result.errors.push(
          `conflicting duplicate span ${span.traceId}/${span.spanId} segment=${span.segment} ` +
          `at lines ${previous.span.sourceLine} and ${span.sourceLine}`,
        );
      }
    }
  };
  const stream = createReadStream(path, { encoding: "utf8", start: 0, end: metadata.size - 1 });
  for await (const chunk of stream) {
    let remainder = chunk;
    if (discardingOversizeLine) {
      const newline = remainder.indexOf("\n");
      if (newline === -1) continue;
      lineNumber += 1;
      result.completeLines += 1;
      discardingOversizeLine = false;
      remainder = remainder.slice(newline + 1);
    }
    pending += remainder;
    pendingBytes += Buffer.byteLength(remainder, "utf8");
    // The previous pending suffix was already known to contain no newline;
    // search only the newly appended characters on the first pass. This keeps
    // a corrupt near-cap line O(n), not O(n²), while retaining streaming.
    let newline = pending.indexOf("\n", Math.max(0, pending.length - remainder.length));
    while (newline !== -1) {
      const consumed = pending.slice(0, newline + 1);
      const rawLine = consumed.slice(0, -1).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      pendingBytes -= Buffer.byteLength(consumed, "utf8");
      lineNumber += 1;
      result.completeLines += 1;
      if (rawLine.trim().length > 0) {
        if (Buffer.byteLength(rawLine, "utf8") > MAX_JSONL_LINE_BYTES) {
          result.errors.push(`JSONL line ${lineNumber} exceeds the ${MAX_JSONL_LINE_BYTES} byte safety cap`);
        } else {
          try {
            consumeDocument(JSON.parse(rawLine), lineNumber);
          } catch {
            // Node's JSON.parse error text may quote source bytes. Never echo
            // those bytes through the default-safe diagnostic path.
            result.errors.push(`malformed complete JSONL line ${lineNumber}: invalid JSON`);
          }
        }
      }
      newline = pending.indexOf("\n");
    }
    if (pendingBytes > MAX_JSONL_LINE_BYTES) {
      result.errors.push(`JSONL line ${lineNumber + 1} exceeds the ${MAX_JSONL_LINE_BYTES} byte safety cap`);
      result.tailState = "oversize";
      pending = "";
      pendingBytes = 0;
      discardingOversizeLine = true;
    }
  }

  if (discardingOversizeLine) {
    result.tailState = "oversize";
  } else if (pending.trim().length > 0) {
    lineNumber += 1;
    try {
      consumeDocument(JSON.parse(pending), lineNumber);
      result.tailState = "valid-unterminated";
    } catch {
      result.tailState = "partial-fragment";
      result.warnings.push(
        `ignored unterminated final JSON fragment at line ${lineNumber} (collector may still be appending)`,
      );
    }
  } else {
    result.tailState = "newline-terminated";
  }

  result.spans = [...unique.values()].map(({ span }) => span);
  try {
    const afterRead = await stat(path);
    result.observedBytesAfterRead = afterRead.size;
    result.observedMtimeMsAfterRead = afterRead.mtimeMs;
    if (afterRead.size !== result.snapshotBytes || afterRead.mtimeMs !== result.mtimeMs) {
      result.warnings.push(
        `source changed during bounded read (snapshot=${result.snapshotBytes} bytes, now=${afterRead.size} bytes); ` +
        "this result intentionally uses only the initial snapshot",
      );
    }
  } catch {
    result.warnings.push("source disappeared after its bounded snapshot was read");
  }
  return result;
}

/** Parse a bounded duration such as 250ms, 12s, 15m, 2h, or 1d. */
export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`duration must look like 250ms, 12s, 15m, 2h, or 1d; got ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"];
  const duration = amount * multiplier;
  if (!Number.isFinite(duration) || duration < 0) throw new Error(`invalid duration ${JSON.stringify(value)}`);
  return duration;
}

/** Convert --since duration/RFC3339 into an inclusive epoch-millisecond bound. */
export function parseSinceMs(value: string | undefined, nowMs: number): number {
  if (value === undefined) return nowMs - DEFAULT_SINCE_MS;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    if (!RFC3339_RE.test(value)) {
      throw new Error(`--since is not valid RFC3339: ${JSON.stringify(value)}`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`--since is not valid RFC3339: ${JSON.stringify(value)}`);
    return parsed;
  }
  return nowMs - parseDurationMs(value);
}

/** Parse the persisted RFC3339 state timestamp without relying on Date's nanosecond support. */
export function parseReaderStartedAtMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !RFC3339_RE.test(value)) return undefined;
  // Date.parse is only reliably millisecond-precise. RFC3339 permits the state
  // writer to provide up to nanoseconds, so truncate (never round) excess
  // fractional digits before computing the current-run boundary.
  const normalized = value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isDotFamily(name: string, family: string): boolean {
  return name === family || name.startsWith(`${family}.`);
}

function parseArgs(args: string[], defaultEnvName: string, nowMs: number): ParsedTraceArgs | "help" {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h" || command === "help") return "help";
  if (command !== "last" && command !== "find" && command !== "show") {
    throw new Error(`unknown trace command ${JSON.stringify(command)} (expected last, find, or show)`);
  }
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) return "help";

  let envName = defaultEnvName;
  let since: string | undefined;
  let waitMs = DEFAULT_WAIT_MS;
  let limit = DEFAULT_LIMIT;
  let raw = false;
  let family: string | undefined;
  let traceId: string | undefined;
  const positionals: string[] = [];
  const seen = new Set<string>();

  const takeValue = (flag: string, index: number): { value: string; next: number } => {
    if (seen.has(flag)) throw new Error(`${flag} may be specified only once`);
    seen.add(flag);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return { value, next: index + 1 };
  };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--raw") {
      if (raw) throw new Error("--raw may be specified only once");
      raw = true;
    } else if (arg === "--env") {
      const taken = takeValue(arg, i); envName = taken.value; i = taken.next;
    } else if (arg === "--since") {
      const taken = takeValue(arg, i); since = taken.value; i = taken.next;
    } else if (arg === "--wait") {
      const taken = takeValue(arg, i); waitMs = parseDurationMs(taken.value); i = taken.next;
    } else if (arg === "--limit") {
      const taken = takeValue(arg, i); limit = Number(taken.value); i = taken.next;
    } else if (arg === "--name") {
      const taken = takeValue(arg, i); family = taken.value; i = taken.next;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${JSON.stringify(arg)}`);
    } else {
      positionals.push(arg);
    }
  }

  if (!/^[A-Za-z0-9._-]{1,128}$/.test(envName) || envName === "." || envName === "..") {
    throw new Error(`--env must be a simple environment name, got ${JSON.stringify(envName)}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (waitMs > MAX_WAIT_MS) throw new Error(`--wait is capped at ${MAX_WAIT_MS / 1_000}s`);
  if (command === "find") {
    if (family === undefined || family.length === 0) throw new Error("trace find requires --name <family>");
    if (positionals.length > 0) throw new Error("trace find does not accept positional arguments");
  } else if (family !== undefined) {
    throw new Error("--name is only valid with trace find");
  }
  if (command !== "find" && seen.has("--limit")) {
    throw new Error("--limit is only valid with trace find");
  }
  if (command === "show" && seen.has("--since")) {
    throw new Error("--since is only valid with trace last or trace find");
  }
  if (command === "show") {
    if (positionals.length !== 1) throw new Error("trace show requires exactly one <trace-id>");
    traceId = positionals[0]!.toLowerCase();
    if (!TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) {
      throw new Error("trace show <trace-id> must be 32 non-zero hex characters");
    }
  } else if (positionals.length > 0) {
    throw new Error(`trace ${command} does not accept positional arguments`);
  }

  return {
    command,
    envName,
    sinceMs: parseSinceMs(since, nowMs),
    waitMs,
    limit,
    raw,
    ...(family ? { family } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

function usageLines(): string[] {
  return [
    "Usage:",
    "  ./raftdev trace last [--env <name>] [--since <duration|RFC3339>] [--wait <duration>] [--raw]",
    "  ./raftdev trace find --name <family> [--env <name>] [--since <duration|RFC3339>] [--wait <duration>] [--limit <1..500>] [--raw]",
    "  ./raftdev trace show <32-hex-trace-id> [--env <name>] [--wait <duration>] [--raw]",
    "",
    "Reads .slockdev/<env>/traces/otlp.json. Default output is a safe attribute projection; --raw explicitly reveals all local trace attributes.",
  ];
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Lines printed by raftdev start so a newcomer has an immediate golden path. */
export function traceBannerLines(envName: string): string[] {
  const env = shellArg(envName);
  return [
    "  Inspect received traces:",
    `    ./raftdev trace last --env ${env}`,
    `    ./raftdev trace find --name server.http --since 15m --env ${env}`,
    `    ./raftdev trace show <trace-id> --env ${env}`,
  ];
}

function unixNanoToMs(value: bigint): number {
  return Number(value / 1_000_000n);
}

function isoNano(value: bigint): string {
  const ms = unixNanoToMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value.toString();
}

function formatDuration(start: bigint, end: bigint): string {
  if (end < start) return "invalid-duration";
  const micros = (end - start) / 1_000n;
  const whole = micros / 1_000n;
  const fraction = (micros % 1_000n).toString().padStart(3, "0");
  return `${whole}.${fraction}ms`;
}

function statusLabel(span: FlatTraceSpan): string {
  const code = span.statusCode;
  if (code === 2 || code === "2" || code === "STATUS_CODE_ERROR" || code === "ERROR") return "ERROR";
  if (code === 1 || code === "1" || code === "STATUS_CODE_OK" || code === "OK") return "OK";
  return "UNSET";
}

function isSafePrimitive(value: TraceAttributeValue): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const SECRET_OR_IDENTITY_PATTERNS = [
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk_(?:agent_|machine_)?|raft_secret_|slock_secret_)[A-Za-z0-9_-]{6,}\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];
const RAW_ID_PATTERNS = [
  /\b[0-9a-f]{16,64}\b/i,
  /\b\d{12,}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
];
const ROUTE_KEYS = new Set(["http.route", "route"]);
const REVISION_KEYS = new Set(["service.revision", "revision"]);

function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function sanitizeProjectedString(key: string, value: string): string | undefined {
  if (SECRET_OR_IDENTITY_PATTERNS.some((pattern) => pattern.test(value))) return undefined;
  if (!REVISION_KEYS.has(key) && RAW_ID_PATTERNS.some((pattern) => pattern.test(value))) return undefined;
  if (ROUTE_KEYS.has(key)) {
    // Only server route templates are safe by default. Actual URLs and other
    // paths can contain user handles, ids, or tokens even without a query.
    if (!/^\/(?:api|internal)(?:\/|$)/.test(value) || value.includes("?") || value.includes("#")) return undefined;
    if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
    return [...value].length <= 160 ? value : undefined;
  }
  // All other projected strings are low-cardinality semantic tokens. Free
  // text is never made safe by truncation, so fail closed instead.
  return SAFE_TOKEN_VALUE_RE.test(value) ? value : undefined;
}

/** Default-deny attribute projection; unknown keys are counted, never printed. */
export function projectAttributes(
  attributes: TraceAttributes,
  raw: boolean,
): { visible: TraceAttributes; redacted: number } {
  if (raw) return { visible: { ...attributes }, redacted: 0 };
  const visible: TraceAttributes = {};
  let redacted = 0;
  for (const [key, value] of Object.entries(attributes)) {
    const numericSafe = SAFE_NUMERIC_SUFFIX.test(key) && (typeof value === "number" || typeof value === "boolean");
    if ((SAFE_ATTRIBUTE_KEYS.has(key) && isSafePrimitive(value)) || numericSafe) {
      if (typeof value === "string") {
        const sanitized = sanitizeProjectedString(key, value);
        if (sanitized === undefined) redacted += 1;
        else visible[key] = sanitized;
      } else {
        visible[key] = value;
      }
    } else redacted += 1;
  }
  return { visible, redacted };
}

function stringifySafe(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested);
}

function attributesText(attributes: TraceAttributes, raw: boolean): string {
  const projected = projectAttributes(attributes, raw);
  const entries = Object.entries(projected.visible).sort(([left], [right]) => left.localeCompare(right));
  const pieces = entries.map(([key, value]) => `${key}=${stringifySafe(value)}`);
  if (projected.redacted > 0) pieces.push(`[${projected.redacted} attribute${projected.redacted === 1 ? "" : "s"} redacted]`);
  return pieces.length > 0 ? ` {${pieces.join(" ")}}` : "";
}

function displayLabel(value: string, raw: boolean): string {
  if (raw) return escapeControls(value);
  return sanitizeProjectedString("label", value) ?? "[redacted-sensitive-label]";
}

function combinedAttributes(span: FlatTraceSpan): TraceAttributes {
  return { ...span.resourceAttributes, ...span.attributes };
}

function displaySourcePath(path: string, projectDir: string): string {
  return relative(projectDir, path) || ".";
}

function safeErrorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)) {
    return error.code;
  }
  return "READ_FAILED";
}

async function readReaderState(path: string): Promise<ReaderStateSnapshot> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { exists: false, fingerprint: "missing" };
    }
    throw error;
  }
  const baseFingerprint = `present:${metadata.size}:${metadata.mtimeMs}`;
  if (metadata.size > MAX_READER_STATE_BYTES) {
    return {
      exists: true,
      fingerprint: `${baseFingerprint}:oversize`,
      error: `reader-state.json exceeds the ${MAX_READER_STATE_BYTES} byte safety cap`,
    };
  }
  let decoded: unknown;
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_READER_STATE_BYTES) {
      return {
        exists: true,
        fingerprint: `${baseFingerprint}:grew-oversize`,
        error: `reader-state.json exceeds the ${MAX_READER_STATE_BYTES} byte safety cap`,
      };
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string") throw error;
    return {
      exists: true,
      fingerprint: `${baseFingerprint}:invalid-json`,
      error: "reader-state.json is not valid JSON",
    };
  }
  if (!isRecord(decoded)) {
    return { exists: true, fingerprint: `${baseFingerprint}:invalid-shape`, error: "reader-state.json is not an object" };
  }
  const mode = field(decoded, "mode");
  const status = field(decoded, "status");
  const startedAt = field(decoded, "startedAt");
  const validModes: readonly ReaderMode[] = ["local", "remote", "worker-disabled", "observe-disabled"];
  const validStatuses: readonly ReaderStatus[] = ["starting", "ready", "failed", "stopped"];
  if (field(decoded, "schemaVersion") !== 1
    || typeof mode !== "string" || !validModes.includes(mode as ReaderMode)
    || typeof status !== "string" || !validStatuses.includes(status as ReaderStatus)
    || typeof startedAt !== "string" || parseReaderStartedAtMs(startedAt) === undefined) {
    return {
      exists: true,
      fingerprint: `${baseFingerprint}:invalid-contract`,
      error: "reader-state.json does not match schemaVersion 1",
    };
  }
  const startedAtMs = parseReaderStartedAtMs(startedAt)!;
  const state: ReaderState = {
    schemaVersion: 1,
    mode: mode as ReaderMode,
    status: status as ReaderStatus,
    startedAt,
    startedAtMs,
  };
  return {
    exists: true,
    fingerprint: `${baseFingerprint}:${state.mode}:${state.status}:${state.startedAt}`,
    state,
  };
}

async function statTraceSource(path: string): Promise<SourceStatSnapshot> {
  try {
    const metadata = await stat(path);
    return {
      exists: true,
      fingerprint: `present:${metadata.size}:${metadata.mtimeMs}`,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { exists: false, fingerprint: "missing", size: 0, mtimeMs: 0 };
    }
    throw error;
  }
}

function readerStateRejection(state: ReaderState, envName: string): string | undefined {
  const env = shellArg(envName);
  if (state.mode === "remote") {
    return "trace reader is unavailable because this environment uses remote trace mode; " +
      "the retained local artifact is stale by contract. Inspect the remote observability surface or restart without SLOCKDEV_TRACE_WORKER_URL.";
  }
  if (state.mode === "worker-disabled") {
    return "trace reader is unavailable because the trace Worker is disabled (SLOCKDEV_TRACE_WORKER=0). " +
      `Restart with tracing enabled: ./raftdev start ${env}.`;
  }
  if (state.mode === "observe-disabled") {
    return "trace reader is unavailable because local trace observation is disabled (SLOCKDEV_TRACE_OBSERVE=0). " +
      `Restart with observation enabled: ./raftdev start ${env}.`;
  }
  if (state.status === "failed") {
    return `the local trace collector failed to start; inspect ./raftdev logs ${env}.`;
  }
  return undefined;
}

function sourceSummary(result: TraceReadResult, projectDir: string): string {
  const displayPath = displaySourcePath(result.path, projectDir);
  const stable = result.snapshotBytes === result.observedBytesAfterRead && result.mtimeMs === result.observedMtimeMsAfterRead;
  const stability = stable
    ? "stable"
    : `changed(snapshot=${result.snapshotBytes}B observed=${result.observedBytesAfterRead}B)`;
  return `source ${displayPath}: ${result.batches} batch${result.batches === 1 ? "" : "es"}, ` +
    `${result.spans.length} unique span${result.spans.length === 1 ? "" : "s"}, ` +
    `${result.snapshotBytes} byte snapshot, mtime=${result.mtimeMs > 0 ? new Date(result.mtimeMs).toISOString() : "missing"}, ` +
    `tail=${result.tailState}, snapshot=${stability}` +
    (result.exactDuplicates > 0 ? `, ${result.exactDuplicates} exact duplicate${result.exactDuplicates === 1 ? "" : "s"} ignored` : "");
}

function preferredServiceAlias(serviceName: string, segment: ServiceSegment): string {
  if (segment === "server") {
    const replica = serviceName.match(/(?:^|[-_.])server[-_.](\d+)$/i);
    if (replica) return `server-${Number(replica[1])}`;
    if (/(?:^|[-_.])server$/i.test(serviceName)) return "server";
  }
  return segment;
}

function safeServiceAliases(spans: FlatTraceSpan[]): Map<string, string> {
  const serviceSegments = new Map(spans.map((span) => [span.serviceName, span.segment] as const));
  const services = [...serviceSegments.entries()];
  const preferred = new Map<string, string>();
  for (const [serviceName, segment] of services) preferred.set(serviceName, preferredServiceAlias(serviceName, segment));
  const collisions = new Map<string, string[]>();
  for (const [serviceName, alias] of preferred) {
    const group = collisions.get(alias) ?? [];
    group.push(serviceName);
    collisions.set(alias, group);
  }
  const aliases = new Map<string, string>();
  for (const [alias, names] of collisions) {
    names.sort();
    if (names.length === 1) aliases.set(names[0]!, alias);
    else names.forEach((name, index) => aliases.set(name, `${serviceSegments.get(name)!}#${index + 1}`));
  }
  return aliases;
}

function freshnessLine(spans: FlatTraceSpan[], raw: boolean): string {
  const newest = new Map<string, bigint>();
  for (const span of spans) {
    const previous = newest.get(span.serviceName);
    if (previous === undefined || span.endTimeUnixNano > previous) newest.set(span.serviceName, span.endTimeUnixNano);
  }
  const aliases = safeServiceAliases(spans);
  const entries = [...newest.entries()].map(([serviceName, timestamp]) => ({
    label: raw ? JSON.stringify(escapeControls(serviceName)) : aliases.get(serviceName)!,
    timestamp,
  })).sort((left, right) => left.label.localeCompare(right.label, "en", { numeric: true }));
  return `recorded-span freshness by service: ${entries.map(({ label, timestamp }) => `${label}=${isoNano(timestamp)}`).join(" ")}`;
}

function isHealthRoot(span: FlatTraceSpan): boolean {
  const attrs = combinedAttributes(span);
  const route = [attrs["http.route"], attrs.route].find((value) => typeof value === "string");
  return typeof route === "string" && /(?:^|\/)(?:healthz?|readyz?|livez?|metrics)(?:\/|$)/i.test(route);
}

function findMatches(spans: FlatTraceSpan[], family: string, sinceMs: number): TraceMatch[] {
  const bound = BigInt(Math.trunc(sinceMs)) * 1_000_000n;
  const matches: TraceMatch[] = [];
  for (const span of spans) {
    if (span.startTimeUnixNano >= bound && isDotFamily(span.name, family)) {
      matches.push({ type: "span", span, timeUnixNano: span.startTimeUnixNano });
    }
    for (const event of span.events) {
      if (event.timeUnixNano >= bound && isDotFamily(event.name, family)) {
        matches.push({ type: "event", span, event, timeUnixNano: event.timeUnixNano });
      }
    }
  }
  return matches.sort((left, right) => left.timeUnixNano === right.timeUnixNano
    ? left.span.spanId.localeCompare(right.span.spanId)
    : left.timeUnixNano > right.timeUnixNano ? -1 : 1);
}

/** Render a complete same-trace forest and explicitly name missing service segments. */
export function renderTrace(spans: FlatTraceSpan[], raw = false): string[] {
  if (spans.length === 0) return [];
  const ordered = [...spans].sort((left, right) => left.startTimeUnixNano === right.startTimeUnixNano
    ? left.spanId.localeCompare(right.spanId)
    : left.startTimeUnixNano < right.startTimeUnixNano ? -1 : 1);
  const traceId = ordered[0]!.traceId;
  const lines = [`trace ${traceId} (${ordered.length} span${ordered.length === 1 ? "" : "s"})`];
  const segments = (["web", "server", "daemon"] as const).map((segment) =>
    `${segment}=${ordered.some((span) => span.segment === segment) ? "present" : "missing"}`,
  );
  lines.push(`segments: ${segments.join(" ")}`);
  const missing = (["web", "server", "daemon"] as const).filter(
    (segment) => !ordered.some((span) => span.segment === segment),
  );
  lines.push(`missing segments: ${missing.length === 0 ? "none" : missing.join(", ")}`);

  const bySpanId = new Map<string, FlatTraceSpan[]>();
  for (const span of ordered) {
    const existing = bySpanId.get(span.spanId) ?? [];
    existing.push(span);
    bySpanId.set(span.spanId, existing);
  }
  const children = new Map<FlatTraceSpan, FlatTraceSpan[]>();
  const roots: FlatTraceSpan[] = [];
  const orphans: Array<{ span: FlatTraceSpan; reason: string }> = [];
  for (const span of ordered) {
    if (!span.parentSpanId) {
      roots.push(span);
      continue;
    }
    const candidates = bySpanId.get(span.parentSpanId) ?? [];
    if (candidates.length === 1) {
      const list = children.get(candidates[0]!) ?? [];
      list.push(span);
      children.set(candidates[0]!, list);
    } else {
      orphans.push({
        span,
        reason: candidates.length === 0 ? `parent ${span.parentSpanId} not recorded` : `parent ${span.parentSpanId} is ambiguous`,
      });
    }
  }
  for (const list of children.values()) list.sort((a, b) => a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1);

  lines.push(`forest: ${roots.length} root${roots.length === 1 ? "" : "s"}, ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}`);
  const visited = new Set<FlatTraceSpan>();
  const active = new Set<FlatTraceSpan>();
  const renderNode = (span: FlatTraceSpan, depth: number, note?: string): void => {
    const indent = "  ".repeat(depth);
    if (active.has(span)) {
      lines.push(`${indent}- [cycle] [${span.segment}] ${displayLabel(span.name, raw)} span=${span.spanId}`);
      return;
    }
    if (visited.has(span)) return;
    visited.add(span);
    active.add(span);
    lines.push(
      `${indent}- [${span.segment}] ${raw ? `${displayLabel(span.serviceName, true)} ` : ""}${displayLabel(span.name, raw)} ` +
      `${formatDuration(span.startTimeUnixNano, span.endTimeUnixNano)} ` +
      `status=${statusLabel(span)} span=${span.spanId}${note ? ` (${note})` : ""}${attributesText(combinedAttributes(span), raw)}`,
    );
    for (const event of [...span.events].sort((a, b) => a.timeUnixNano < b.timeUnixNano ? -1 : 1)) {
      lines.push(`${indent}  * ${displayLabel(event.name, raw)} at=${isoNano(event.timeUnixNano)}${attributesText(event.attributes, raw)}`);
    }
    for (const child of children.get(span) ?? []) renderNode(child, depth + 1);
    active.delete(span);
  };
  for (const root of roots) renderNode(root, 0);
  for (const orphan of orphans) renderNode(orphan.span, 0, `orphan: ${orphan.reason}`);
  for (const span of ordered) {
    if (!visited.has(span)) renderNode(span, 0, "cycle/unreachable parent chain");
  }
  return lines;
}

function renderMatch(match: TraceMatch, raw: boolean): string {
  if (match.type === "span") {
    const span = match.span;
    return `span ${isoNano(match.timeUnixNano)} [${span.segment}] ${displayLabel(span.name, raw)} ` +
      `trace=${span.traceId} span=${span.spanId}${attributesText(combinedAttributes(span), raw)}`;
  }
  const event = match.event!;
  return `event ${isoNano(match.timeUnixNano)} [${match.span.segment}] ${displayLabel(match.span.name, raw)} > ${displayLabel(event.name, raw)} ` +
    `trace=${match.span.traceId} span=${match.span.spanId}${attributesText(event.attributes, raw)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCommandResult(parsed: ParsedTraceArgs, result: TraceReadResult): boolean {
  if (parsed.command === "show") return result.spans.some((span) => span.traceId === parsed.traceId);
  if (parsed.command === "find") return findMatches(result.spans, parsed.family!, parsed.sinceMs).length > 0;
  const bound = BigInt(Math.trunc(parsed.sinceMs)) * 1_000_000n;
  return result.spans.some((span) =>
    span.segment === "server" && span.name === "server.http.request" && !isHealthRoot(span) && span.startTimeUnixNano >= bound,
  );
}

function snapshotMayStillBeFlushing(result: TraceReadResult): boolean {
  return result.tailState === "partial-fragment"
    || result.snapshotBytes !== result.observedBytesAfterRead
    || result.mtimeMs !== result.observedMtimeMsAfterRead;
}

function noResultMessage(parsed: ParsedTraceArgs, result: TraceReadResult, waitedMs: number, projectDir: string): string {
  const waited = waitedMs === 0 ? "without waiting" : `after waiting up to ${waitedMs}ms for collector flush`;
  const displayPath = displaySourcePath(result.path, projectDir);
  if (!result.exists) {
    return `trace source is missing ${waited}: ${displayPath}. Start it with ./raftdev start ${shellArg(parsed.envName)} ` +
      `and ensure SLOCKDEV_TRACE_OBSERVE is not 0.`;
  }
  if (result.snapshotBytes === 0) {
    return `trace source is empty ${waited}: ${displayPath}. Send a dev request, then retry ./raftdev trace ${parsed.command} --env ${shellArg(parsed.envName)}.`;
  }
  if (parsed.command === "show") return `trace ${parsed.traceId} was not recorded ${waited}.`;
  if (parsed.command === "find") return `no span or event in the anchored family ${JSON.stringify(parsed.family)} was recorded ${waited}.`;
  return `no non-health server.http.request was recorded in the selected --since window ${waited}.`;
}

/** Execute `raftdev trace`; returns 0 success, 1 no source/match, 2 usage/data error. */
export async function runTraceCli(args: string[], options: RunTraceCliOptions): Promise<number> {
  const writeOut = options.stdout ?? ((value: string) => process.stdout.write(`${value}\n`));
  const writeErr = options.stderr ?? ((value: string) => process.stderr.write(`${value}\n`));
  const now = options.now ?? Date.now;
  let parsed: ParsedTraceArgs | "help";
  try {
    parsed = parseArgs(args, options.defaultEnvName, now());
  } catch (error) {
    writeErr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    for (const line of usageLines()) writeErr(line);
    return 2;
  }
  if (parsed === "help") {
    for (const line of usageLines()) writeOut(line);
    return 0;
  }
  if (parsed.raw) {
    writeErr("WARNING: --raw prints unredacted local trace attributes and service names; output may contain sensitive payload data.");
  }

  const environmentDir = join(options.projectDir, ".slockdev", parsed.envName);
  const sourcePath = join(environmentDir, "traces", "otlp.json");
  const readerStatePath = join(environmentDir, "traces", "reader-state.json");
  const startedAt = Date.now();
  const deadline = startedAt + parsed.waitMs;
  const settleDeadline = startedAt + Math.min(parsed.waitMs, LAST_INITIAL_SETTLE_MS);
  const emittedWarnings = new Set<string>();
  let result = emptyReadResult(sourcePath);
  let currentReaderState: ReaderState | undefined;
  let cachedResult: TraceReadResult | undefined;
  let cachedSourceFingerprint: string | undefined;
  let quietFingerprint: string | undefined;
  let quietSinceMs: number | undefined;
  let artifactPredatesCurrentRun = false;
  while (true) {
    let readerStateSnapshot: ReaderStateSnapshot;
    try {
      readerStateSnapshot = await readReaderState(readerStatePath);
    } catch (error) {
      writeErr(
        `ERROR: cannot read reader state ${displaySourcePath(readerStatePath, options.projectDir)}: ` +
        safeErrorCode(error),
      );
      return 2;
    }
    if (readerStateSnapshot.error) {
      writeErr(`ERROR: ${readerStateSnapshot.error}`);
      return 2;
    }
    currentReaderState = readerStateSnapshot.state;
    if (!readerStateSnapshot.exists && !emittedWarnings.has("legacy-reader-state")) {
      emittedWarnings.add("legacy-reader-state");
      writeErr("WARNING: reader-state.json is missing; using legacy local-artifact semantics.");
    }
    if (currentReaderState) {
      const rejection = readerStateRejection(currentReaderState, parsed.envName);
      if (rejection) {
        writeErr(`ERROR: ${rejection}`);
        return 2;
      }
      if (currentReaderState.status === "starting") {
        quietFingerprint = undefined;
        quietSinceMs = undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          writeErr(
            `trace collector is still starting after waiting up to ${parsed.waitMs}ms; ` +
            `inspect ./raftdev logs ${shellArg(parsed.envName)}.`,
          );
          return 1;
        }
        await sleep(Math.min(250, remaining));
        continue;
      }
    }

    let sourceStat: SourceStatSnapshot;
    try {
      sourceStat = await statTraceSource(sourcePath);
    } catch (error) {
      writeErr(
        `ERROR: cannot stat trace source ${displaySourcePath(sourcePath, options.projectDir)}: ` +
        safeErrorCode(error),
      );
      return 2;
    }
    artifactPredatesCurrentRun = Boolean(
      currentReaderState
      && sourceStat.exists
      && sourceStat.mtimeMs < currentReaderState.startedAtMs,
    );
    if (artifactPredatesCurrentRun) {
      result = emptyReadResult(sourcePath);
      result.exists = true;
      result.snapshotBytes = sourceStat.size;
      result.mtimeMs = sourceStat.mtimeMs;
      result.observedBytesAfterRead = sourceStat.size;
      result.observedMtimeMsAfterRead = sourceStat.mtimeMs;
    } else if (cachedResult && cachedSourceFingerprint === sourceStat.fingerprint) {
      result = cachedResult;
    } else {
      try {
        result = await readTraceFile(sourcePath);
      } catch (error) {
        writeErr(
          `ERROR: cannot read trace source ${displaySourcePath(sourcePath, options.projectDir)}: ` +
          safeErrorCode(error),
        );
        return 2;
      }
      const stableRead = result.snapshotBytes === result.observedBytesAfterRead
        && result.mtimeMs === result.observedMtimeMsAfterRead
        && result.snapshotBytes === sourceStat.size
        && result.mtimeMs === sourceStat.mtimeMs;
      if (stableRead) {
        cachedResult = result;
        cachedSourceFingerprint = sourceStat.fingerprint;
      } else {
        cachedResult = undefined;
        cachedSourceFingerprint = undefined;
      }
    }
    for (const warning of result.warnings) {
      if (!emittedWarnings.has(warning)) {
        emittedWarnings.add(warning);
        writeErr(`WARNING: ${warning}`);
      }
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) writeErr(`ERROR: ${error}`);
      writeErr(sourceSummary(result, options.projectDir));
      return 2;
    }
    const matched = hasCommandResult(parsed, result);
    const currentTime = Date.now();
    const initialLastSettleComplete = parsed.command !== "last" || currentTime >= settleDeadline;
    const remaining = deadline - currentTime;
    const observationFingerprint = `${readerStateSnapshot.fingerprint}|${sourceStat.fingerprint}|${result.tailState}|` +
      `${result.observedBytesAfterRead}:${result.observedMtimeMsAfterRead}`;
    const snapshotFlushing = snapshotMayStillBeFlushing(result);
    if (matched) {
      if (quietFingerprint !== observationFingerprint || snapshotFlushing) {
        quietFingerprint = observationFingerprint;
        quietSinceMs = currentTime;
      } else if (quietSinceMs === undefined) {
        quietSinceMs = currentTime;
      }
      const quietComplete = !snapshotFlushing
        && quietSinceMs !== undefined
        && currentTime - quietSinceMs >= MATCH_QUIET_MS;
      if (initialLastSettleComplete && quietComplete) break;
      if (remaining <= 0) {
        writeErr(
          `WARNING: the source did not remain quiet for ${MATCH_QUIET_MS}ms before --wait elapsed; ` +
          "showing the latest persisted partial observation.",
        );
        break;
      }
    } else {
      quietFingerprint = undefined;
      quietSinceMs = undefined;
    }
    if (remaining <= 0) {
      if (artifactPredatesCurrentRun) {
        writeErr(
          `the retained trace artifact predates the current reader run after waiting up to ${parsed.waitMs}ms; ` +
          `send a dev request or inspect ./raftdev logs ${shellArg(parsed.envName)}.`,
        );
      } else {
        writeErr(noResultMessage(parsed, result, parsed.waitMs, options.projectDir));
      }
      writeErr(sourceSummary(result, options.projectDir));
      if (result.spans.length > 0) writeErr(freshnessLine(result.spans, parsed.raw));
      return 1;
    }
    await sleep(Math.min(250, remaining));
  }

  if (currentReaderState?.status === "stopped") {
    writeOut(`reader state: archived local artifact (environment stopped; run started ${currentReaderState.startedAt})`);
  }
  writeOut(sourceSummary(result, options.projectDir));
  writeOut(freshnessLine(result.spans, parsed.raw));
  if (parsed.command === "find") {
    const matches = findMatches(result.spans, parsed.family!, parsed.sinceMs);
    const visible = matches.slice(0, parsed.limit);
    writeOut(`matches: showing ${visible.length} of ${matches.length} for anchored family ${JSON.stringify(parsed.family)}`);
    for (const match of visible) writeOut(renderMatch(match, parsed.raw));
    if (matches.length > visible.length) writeOut(`truncated: pass --limit up to ${MAX_LIMIT} to show more`);
    return 0;
  }

  let traceSpans: FlatTraceSpan[];
  if (parsed.command === "show") {
    traceSpans = result.spans.filter((span) => span.traceId === parsed.traceId);
  } else {
    const bound = BigInt(Math.trunc(parsed.sinceMs)) * 1_000_000n;
    const requests = result.spans.filter((span) =>
      span.segment === "server" && span.name === "server.http.request" && !isHealthRoot(span) && span.startTimeUnixNano >= bound,
    ).sort((left, right) => left.startTimeUnixNano > right.startTimeUnixNano ? -1 : 1);
    const request = requests[0]!;
    const projectedRequest = projectAttributes(combinedAttributes(request), parsed.raw).visible;
    writeOut(
      `latest persisted HTTP request: ${isoNano(request.startTimeUnixNano)} ` +
      `route=${stringifySafe(projectedRequest["http.route"] ?? "unknown")}`,
    );
    writeOut(`next: ./raftdev trace show ${request.traceId} --env ${shellArg(parsed.envName)}`);
    traceSpans = result.spans.filter((span) => span.traceId === request.traceId);
  }
  for (const line of renderTrace(traceSpans, parsed.raw)) writeOut(line);
  return 0;
}

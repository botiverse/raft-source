// Row encoding for the ScopeDB Append API (scopedb SDK >= 0.4).
//
// Append runs no ScopeQL projection: each NDJSON line must be a JSON object
// keyed by destination column, every value already in the exact JSON form its
// column type takes, and an unknown field or a type mismatch rejects the
// whole request (see the SDK's docs/usage.md "JSON encoding for Append").
// The legacy ingest statements were `$0["col"]::type AS col` casts; this
// module does those casts in code, driven by each writer's column list, so the
// list stays the single source of truth for what is written.

export type ScopeDbAppendColumnType = "string" | "int" | "timestamp" | "object";

export type ScopeDbAppendColumns = ReadonlyArray<readonly [string, ScopeDbAppendColumnType]>;

export class ScopeDbAppendEncodingError extends Error {
  readonly column: string;

  constructor(column: string, message: string) {
    super(`ScopeDB append column ${column}: ${message}`);
    this.name = "ScopeDbAppendEncodingError";
    this.column = column;
  }
}

// A ScopeDB timestamp is signed 64-bit nanoseconds since the Unix epoch.
const MAX_TIMESTAMP_ABS_MS = 9_223_372_036_854;
// 2 ** 63: the first integer magnitude outside the signed 64-bit token range.
const INT64_LIMIT = 9_223_372_036_854_775_808;
const RFC3339_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Field ranges the regex cannot express. Date.parse rolls impossible dates
 * over (2026-02-30 becomes 2026-03-02) and the text is forwarded as is, so the
 * calendar day is checked against a UTC round trip.
 */
function isRealRfc3339Instant(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(Number);
  if (month! < 1 || month! > 12 || hour! > 23 || minute! > 59 || second! > 59) return false;
  if (match[7] !== undefined && (offsetHour! > 23 || offsetMinute! > 59)) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCFullYear(year!); // Date.UTC maps years 0-99 to 1900-1999
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

function encodeString(column: string, value: unknown): string {
  if (typeof value === "string") return value;
  // The legacy `::string` cast turned JSON scalars into their text.
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ScopeDbAppendEncodingError(column, `expected a string, got ${describe(value)}`);
}

function encodeInt(column: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScopeDbAppendEncodingError(column, `expected an integer, got ${describe(value)}`);
  }
  // Append takes only integer tokens (no `1.5`, `1e3`); the legacy `::int`
  // cast accepted any number, so fractional values are truncated toward zero.
  const integer = Math.trunc(value);
  // Beyond the safe range JSON.stringify can emit an exponent or a rounded
  // value; neither is a faithful integer token.
  if (!Number.isSafeInteger(integer)) {
    throw new ScopeDbAppendEncodingError(column, "integer is outside the exactly representable range");
  }
  return integer === 0 ? 0 : integer; // never emit -0
}

function encodeTimestamp(column: string, value: unknown): string {
  let ms: number;
  if (typeof value === "string") {
    // Keep valid RFC 3339 text as is: it may carry sub-millisecond precision.
    // Anything else (date-only, no offset, epoch digits) is rejected rather
    // than reinterpreted in a guessed time zone.
    const match = RFC3339_WITH_OFFSET.exec(value);
    if (!match) {
      throw new ScopeDbAppendEncodingError(column, "timestamp string must be RFC 3339 with an explicit offset");
    }
    if (!isRealRfc3339Instant(match)) {
      throw new ScopeDbAppendEncodingError(column, "timestamp string is not a real calendar date and time");
    }
    ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new ScopeDbAppendEncodingError(column, "timestamp string is not a valid date");
    assertTimestampRange(column, ms);
    return value;
  }
  if (value instanceof Date) ms = value.getTime();
  // Append rejects numeric epochs; a number here is epoch milliseconds.
  else if (typeof value === "number") ms = value;
  else throw new ScopeDbAppendEncodingError(column, `expected a timestamp, got ${describe(value)}`);
  if (!Number.isFinite(ms)) throw new ScopeDbAppendEncodingError(column, "timestamp is not a finite time");
  assertTimestampRange(column, ms);
  return new Date(ms).toISOString();
}

function assertTimestampRange(column: string, ms: number): void {
  if (Math.abs(ms) > MAX_TIMESTAMP_ABS_MS) {
    throw new ScopeDbAppendEncodingError(column, "timestamp is outside the signed 64-bit nanosecond range");
  }
}

function encodeObject(column: string, value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date) {
    // Pass the object itself: a string holding serialized JSON is a mismatch.
    throw new ScopeDbAppendEncodingError(column, `expected a JSON object, got ${describe(value)}`);
  }
  assertJsonIntegersFit(column, value);
  return value;
}

/** The signed 64-bit integer-token limit also applies inside object values. */
function assertJsonIntegersFit(column: string, value: unknown): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) >= INT64_LIMIT && Math.abs(value) < 1e21) {
      // JSON.stringify writes these as plain digits (an integer token) that
      // ScopeDB rejects; from 1e21 it switches to exponent (float) notation.
      throw new ScopeDbAppendEncodingError(column, "nested integer is outside the signed 64-bit range");
    }
    return;
  }
  if (typeof value === "bigint") {
    throw new ScopeDbAppendEncodingError(column, "nested bigint cannot be JSON encoded");
  }
  if (typeof value !== "object" || value === null) return;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonIntegersFit(column, nested);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * One Append record: exactly the listed columns, in list order, each encoded
 * for its type. Fields not in the list are dropped; a missing or null value is
 * written as an explicit null (SQL NULL). Throws ScopeDbAppendEncodingError
 * when a value cannot be represented, so the caller can drop that row instead
 * of letting it reject a whole request.
 */
export function encodeScopeDbAppendRecord(
  row: object,
  columns: ScopeDbAppendColumns,
): Record<string, string | number | object | null> {
  const source = row as Record<string, unknown>;
  const record: Record<string, string | number | object | null> = {};
  for (const [column, type] of columns) {
    const value = source[column];
    if (value === undefined || value === null) {
      record[column] = null;
      continue;
    }
    switch (type) {
      case "string":
        record[column] = encodeString(column, value);
        break;
      case "int":
        record[column] = encodeInt(column, value);
        break;
      case "timestamp":
        record[column] = encodeTimestamp(column, value);
        break;
      case "object":
        record[column] = encodeObject(column, value);
        break;
    }
  }
  return record;
}

/** One NDJSON line (no trailing newline) for `Table.append()`. */
export function encodeScopeDbAppendLine(row: object, columns: ScopeDbAppendColumns): string {
  return JSON.stringify(encodeScopeDbAppendRecord(row, columns));
}

// Append requests allow 8 MiB of uncompressed NDJSON and 200,000 rows; stay
// at the SDK stream's 4 MiB default so one oversized row still fits.
export const SCOPEDB_APPEND_TARGET_BATCH_BYTES = 4 * 1024 * 1024;
export const SCOPEDB_APPEND_MAX_BATCH_ROWS = 200_000;

/**
 * Splits encoded NDJSON lines into Append-sized request bodies, preserving
 * order. A single line larger than the target gets a request of its own (the
 * SDK still rejects one above 8 MiB).
 */
export function chunkScopeDbAppendLines(
  lines: readonly string[],
  targetBytes: number = SCOPEDB_APPEND_TARGET_BATCH_BYTES,
  maxRows: number = SCOPEDB_APPEND_MAX_BATCH_ROWS,
): Array<{ ndjson: string; rows: number }> {
  const chunks: Array<{ ndjson: string; rows: number }> = [];
  let current: string[] = [];
  let currentBytes = 0;
  const encoder = new TextEncoder();
  for (const line of lines) {
    const bytes = encoder.encode(line).byteLength + 1;
    if (current.length > 0 && (currentBytes + bytes > targetBytes || current.length >= maxRows)) {
      chunks.push({ ndjson: current.join("\n"), rows: current.length });
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push({ ndjson: current.join("\n"), rows: current.length });
  return chunks;
}

/**
 * How a failed Append should be handled, read from the error the scopedb SDK
 * throws (structurally, so callers need no SDK import). It reads the scopedb
 * 0.4 outcomes ("failed", "ambiguous"); 0.4 never emits the 0.3 spellings:
 *
 * - `throttled`: HTTP 429 with no client-side timeout or cancellation
 *   (`writeDetails`). A 429 is an admission refusal whatever the body, so
 *   nothing committed and a re-send cannot duplicate. (scopedb 0.4 reports a
 *   JSON-bodied 429 without ScopeDB's error code, e.g. a gateway's
 *   `{"message": ...}`, as outcome "ambiguous" with no `cause`; it is still
 *   throttled here.) This overrides an outcome the body declared: 0.4 cannot
 *   tell a gateway's JSON 429 from ScopeDB declaring "may have committed" on a
 *   429, and nor can a stream with `retryAmbiguous` that ends on a 429 after an
 *   ambiguous attempt; Raft never enables `retryAmbiguous`.
 * - `unavailable`: HTTP 503 whose outcome the SDK synthesized for a body
 *   that is not JSON (a gateway's plain text): outcome "ambiguous" with the
 *   outcome-less HTTP failure kept as `cause`. Re-sent like 429.
 * - `rejected`: a structured rejection (outcome "failed": a 4xx whose JSON body
 *   carries ScopeDB's error `code`). A JSON body without a `code` is
 *   "ambiguous" in 0.4, i.e. `unknown` here. Retryable
 *   only when temporary, including a stream whose retry budget ran out on one
 *   (the SDK's AppendRetryExhaustedError, recognisable by its `retries`
 *   context: its `name` is "AppendRowsError").
 * - `unknown`: timeout, cancellation, lost response, another 5xx, or a 5xx
 *   with a JSON body: the batch may have committed, so a re-send can
 *   duplicate rows. scopedb 0.4 marks every JSON 5xx "ambiguous" with no
 *   `cause` (its migration guide: a 503 "does not prove that a batch was
 *   rejected"; tison confirmed ScopeDB's own refusals are 429), so those are
 *   dropped, not re-queued. Only a plain-body 503 is `unavailable`.
 * - `local`: not an Append response at all (encoding, configuration, ...).
 */
export type ScopeDbAppendFailureClass = "throttled" | "unavailable" | "rejected" | "unknown" | "local";

export interface ScopeDbAppendFailure {
  class: ScopeDbAppendFailureClass;
  /** Not committed and worth re-sending later (throttled, unavailable, or a temporary structured rejection). */
  retryable: boolean;
  httpStatus?: number;
  /** The server's Retry-After, when the SDK parsed one. */
  retryAfterMs?: number;
}

interface ScopeDbAppendErrorShape {
  httpStatus?: unknown;
  retryAfterMs?: unknown;
  writeDetails?: unknown;
  outcome?: unknown;
  cause?: unknown;
  isTemporary?: () => boolean;
  context?: () => ReadonlyMap<string, string>;
}

/**
 * True when the SDK made up outcome "ambiguous" for a response that carried no
 * structured ScopeDB outcome: its cause is the plain HTTP failure, which has
 * no outcome of its own. A structured outcome from the server has no cause.
 */
function isSdkSynthesizedUnknown(shape: ScopeDbAppendErrorShape): boolean {
  if (!isAmbiguousOutcome(shape.outcome)) return false;
  const cause = shape.cause;
  return typeof cause === "object" && cause !== null && (cause as ScopeDbAppendErrorShape).outcome === undefined;
}

/** May have committed. */
function isAmbiguousOutcome(outcome: unknown): boolean {
  return outcome === "ambiguous";
}

/** Confirmed not committed. */
function isFailedOutcome(outcome: unknown): boolean {
  return outcome === "failed";
}

function hasStreamRetryContext(err: unknown, shape: ScopeDbAppendErrorShape): boolean {
  if (typeof shape.context !== "function") return false;
  const context = shape.context.call(err);
  return context instanceof Map && context.has("retries");
}

export function classifyScopeDbAppendFailure(err: unknown): ScopeDbAppendFailure {
  if (typeof err !== "object" || err === null) return { class: "local", retryable: false };
  const shape = err as ScopeDbAppendErrorShape;
  const httpStatus = typeof shape.httpStatus === "number" ? shape.httpStatus : undefined;
  const retryAfterMs = typeof shape.retryAfterMs === "number" && Number.isFinite(shape.retryAfterMs) && shape.retryAfterMs >= 0
    ? shape.retryAfterMs
    : undefined;
  const base = {
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  if (shape.writeDetails !== undefined && shape.writeDetails !== null) return { class: "unknown", retryable: false, ...base };
  // An admission refusal, whatever outcome the SDK inferred from the body.
  if (httpStatus === 429) return { class: "throttled", retryable: true, ...base };
  // May have committed: never re-send.
  if (isAmbiguousOutcome(shape.outcome) && !isSdkSynthesizedUnknown(shape)) return { class: "unknown", retryable: false, ...base };
  if (httpStatus === 503) return { class: "unavailable", retryable: true, ...base };
  if (isFailedOutcome(shape.outcome)) {
    const temporary = (typeof shape.isTemporary === "function" && shape.isTemporary.call(err) === true)
      || hasStreamRetryContext(err, shape);
    return { class: "rejected", retryable: temporary, ...base };
  }
  if (isAmbiguousOutcome(shape.outcome) || httpStatus !== undefined) return { class: "unknown", retryable: false, ...base };
  return { class: "local", retryable: false, ...base };
}

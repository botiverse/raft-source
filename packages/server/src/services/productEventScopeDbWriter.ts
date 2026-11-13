// ScopeDB adapter for RFC-067 product events.
//
// Product events are their own table (product.events) in the trace events'
// ScopeDB workspace. Rows follow PostHog's event shape
// (docs/analytics/product-events.md) and carry only analytics_id as the user
// key, never a Raft user id.
//
// Requests only enqueue; a background flush writes batches with a committed
// Append (scopedb Table.append), so ScopeDB sees a few large writes
// instead of one per request. Append takes no ScopeQL cast: each row is
// encoded for its column types when it is queued (encodeScopeDbAppendLine,
// driven by the column lists below).

import { Client, ScopeDBError } from "scopedb";
import {
  classifyScopeDbAppendFailure,
  encodeScopeDbAppendLine,
  errorCodeOf,
  SCOPEDB_APPEND_TARGET_BATCH_BYTES,
  type AnalyticsId,
  type ProductEventSource,
  type ScopeDbAppendColumns,
  type ScopeDbAppendColumnType,
  type ServerId,
} from "@botiverse/raft-shared";
import { productEventIngestTotal } from "../metrics";
import { errorClassOf } from "../tracing/semanticTrace";
import { noteProductEventOutcome, noteProductEventWriteFailure, type ProductEventWriteFailure } from "./productEventIngestSummary";
import type { ScopeDbPersistenceTier } from "./scopeDbSdkPolicy";

export const PRODUCT_EVENTS_SCOPEDB_PERSISTENCE_TIER: ScopeDbPersistenceTier = "decision_support";

export const PRODUCT_EVENTS_TABLE = "product.events";

export interface ProductEventRow {
  uuid: string;
  event: string;
  source: ProductEventSource;
  /** ISO time the action happened. */
  timestamp: string;
  /** ISO time the row was received. */
  received_at: string;
  analytics_id: AnalyticsId | null;
  server_id: ServerId | null;
  client_session_id: string | null;
  app_version: string | null;
  platform: string | null;
  properties: Readonly<Record<string, string | number | boolean>>;
}

export interface RowSink<Row> {
  /** Queues rows for the next flush. Never throws; losses are counted. */
  enqueue(rows: readonly Row[]): void;
  /** Writes everything queued so far (server shutdown, tests). */
  flush(): Promise<void>;
}

export type ProductEventSink = RowSink<ProductEventRow>;

/**
 * product.public_visitors (2026-10-14, cindyz / Tenny in #proj-analytics):
 * the random visitor id a logged-out visitor's browser keeps after they accept
 * analytics cookies on a public page. It is personal data (an online
 * identifier), so it lives only here, in a table with a 395-day DATA
 * RETENTION, never in product.events, traces or logs. No account id: the link
 * to an account is the public_page_server_joined row in product.events with the
 * same uuid, and it disappears with this row.
 */
export const PUBLIC_VISITORS_TABLE = "product.public_visitors";

export interface PublicVisitorRow {
  /** The uuid of the product.events row this visit or join wrote. */
  uuid: string;
  event: string;
  server_id: ServerId;
  /** ISO time the row was received. */
  received_at: string;
  anonymous_id: string;
}

export type PublicVisitorSink = RowSink<PublicVisitorRow>;

type Columns<Row> = ReadonlyArray<readonly [keyof Row & string | "deployment_environment", ScopeDbAppendColumnType]>;

export const PRODUCT_EVENTS_COLUMNS: Columns<ProductEventRow> = [
  ["uuid", "string"],
  ["event", "string"],
  ["source", "string"],
  ["timestamp", "timestamp"],
  ["received_at", "timestamp"],
  ["analytics_id", "string"],
  ["server_id", "string"],
  ["client_session_id", "string"],
  ["app_version", "string"],
  ["platform", "string"],
  ["properties", "object"],
  ["deployment_environment", "string"],
];

export const PUBLIC_VISITORS_COLUMNS: Columns<PublicVisitorRow> = [
  ["uuid", "string"],
  ["event", "string"],
  ["server_id", "string"],
  ["received_at", "timestamp"],
  ["anonymous_id", "string"],
  ["deployment_environment", "string"],
];

/** Which table a sink writes, and the outcomes its rows are counted under. */
interface SinkTable {
  name: ProductEventWriteFailure["table"];
  /** ScopeQL `schema.table`, in the default `scopedb` database. */
  table: string;
  columns: ScopeDbAppendColumns;
  logPrefix: string;
  written: string;
  lost: string;
}

const PRODUCT_EVENTS_SINK: SinkTable = {
  name: "events",
  table: PRODUCT_EVENTS_TABLE,
  columns: PRODUCT_EVENTS_COLUMNS,
  logPrefix: "[product-events]",
  written: "written",
  lost: "lost",
};

// Its own queue and outcomes: if this table is missing or failing, only
// visitor ids are lost, never product.events rows (Tenny, 2026-10-14).
const PUBLIC_VISITORS_SINK: SinkTable = {
  name: "public_visitors",
  table: PUBLIC_VISITORS_TABLE,
  columns: PUBLIC_VISITORS_COLUMNS,
  logPrefix: "[public-visitors]",
  written: "public_visitor_written",
  lost: "public_visitor_lost",
};

function countRows(outcome: string, count: number): void {
  if (count > 0) productEventIngestTotal.inc({ outcome }, count);
  noteProductEventOutcome(outcome, count);
}

/** Bounded fields only: the store's error text may echo row contents. */
function writeFailureOf(table: ProductEventWriteFailure["table"], err: unknown): ProductEventWriteFailure {
  const failure: ProductEventWriteFailure = { table, error_class: errorClassOf(err) };
  if (err instanceof ScopeDBError) {
    failure.kind = err.kind;
    if (err.httpStatus !== undefined) failure.http_status = err.httpStatus;
  }
  // From the HTTP status, not AppendRowsError.outcome: the SDK reports a 429
  // or 503 whose body is not ScopeDB's structured error (a gateway's plain
  // text) as outcome "ambiguous", though the server refused and nothing
  // committed. Only class "unknown" here (timeout, lost response, other 5xx) means
  // the retry can duplicate rows.
  const classified = classifyScopeDbAppendFailure(err);
  if (classified.class !== "local") failure.append_failure = classified.class;
  const code = errorCodeOf(err);
  if (code) failure.error_code = code;
  return failure;
}

export interface ScopeDbProductEventSinkConfig {
  endpoint: string;
  apiKey: string;
  /** Stamped on every row (DEPLOYMENT_ENV), so staging and prod rows can share a table. */
  deploymentEnvironment?: string | null;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  /** First retry delay after a failed write; doubles per attempt up to maxRetryDelayMs. */
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
  /**
   * A batch still failing this long after the sink started failing is
   * dropped and counted as lost (rows queued during the outage join the
   * failing batch and share its window; a success or a drop restarts it).
   * Every error kind waits the window, permanent ones too: which kinds an
   * upgrade or a cold start produces is not known yet (write_failed will
   * show), and a permanently failing batch is lost either way. Ten minutes rides out a ScopeDB restart or upgrade: the
   * 0.6 upgrade (2026-10-24 04:38–04:45Z) lost 393 rows to the old limit of
   * 5 attempts (~30 s), and new replicas lose their first writes at a deploy.
   */
  maxRetryWindowMs?: number;
  /** Optional cap on attempts per batch as well (tests); unlimited by default. */
  maxAttempts?: number;
}

const PRODUCT_EVENT_MAX_RETRY_WINDOW_MS = 10 * 60_000;

function appendTarget(table: string): { schema: string; name: string } {
  const [schema, name, ...rest] = table.split(".");
  if (!schema || !name || rest.length > 0) throw new Error(`expected schema.table, got ${table}`);
  return { schema, name };
}

class ScopeDbRowSink<Row extends object> implements RowSink<Row> {
  private readonly client: Pick<Client, "table">;
  private readonly table: SinkTable;
  private readonly deploymentEnvironment: string | null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly maxRetryWindowMs: number;
  // Encoded NDJSON lines (deployment_environment stamped), oldest first.
  private queue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Single flight: one drain at a time; every flush() caller (timer, full
  // batch, shutdown) awaits the same drain.
  private draining: Promise<void> | null = null;
  // Consecutive failed attempts for the batch at the head of the queue; while
  // > 0 the sink is backing off and only the retry timer starts a drain.
  private failedAttempts = 0;
  // When the head batch first failed (Date.now()), for the retry window.
  private failingSinceMs = 0;
  // Retry-After of the last failed write, when the server sent one.
  private retryAfterMs: number | undefined;

  constructor(config: ScopeDbProductEventSinkConfig, table: SinkTable, client?: Pick<Client, "table">) {
    this.client = client ?? new Client(config.endpoint, { apiKey: config.apiKey });
    this.table = table;
    this.deploymentEnvironment = config.deploymentEnvironment ?? null;
    this.batchSize = Math.max(1, config.batchSize ?? 500);
    this.flushIntervalMs = Math.max(1, config.flushIntervalMs ?? 2_000);
    this.maxQueueSize = Math.max(this.batchSize, config.maxQueueSize ?? 20_000);
    this.retryBaseMs = Math.max(1, config.retryBaseMs ?? 2_000);
    this.maxRetryDelayMs = Math.max(this.retryBaseMs, config.maxRetryDelayMs ?? 60_000);
    this.maxAttempts = Math.max(1, config.maxAttempts ?? Number.POSITIVE_INFINITY);
    this.maxRetryWindowMs = Math.max(0, config.maxRetryWindowMs ?? PRODUCT_EVENT_MAX_RETRY_WINDOW_MS);
  }

  enqueue(rows: readonly Row[]): void {
    for (const row of rows) {
      try {
        this.queue.push(encodeScopeDbAppendLine({ ...row, deployment_environment: this.deploymentEnvironment }, this.table.columns));
      } catch (err) {
        // A row ScopeDB would reject (e.g. a timestamp it cannot store) is
        // lost on its own instead of failing every batch it would join.
        countRows(this.table.lost, 1);
        noteProductEventWriteFailure(writeFailureOf(this.table.name, err));
      }
    }
    this.trimOverflow();
    if (this.failedAttempts > 0) return; // backing off: the retry timer drains
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.scheduleFlush(this.flushIntervalMs);
  }

  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      if (await this.writeBatch(batch)) {
        this.failedAttempts = 0;
        continue;
      }
      if (this.failedAttempts === 0) this.failingSinceMs = Date.now();
      this.failedAttempts += 1;
      if (this.failedAttempts >= this.maxAttempts || Date.now() - this.failingSinceMs >= this.maxRetryWindowMs) {
        // Give up on this batch (a permanent error, or an outage longer than the window); keep the rest.
        countRows(this.table.lost, batch.length);
        this.failedAttempts = 0;
        continue;
      }
      // Transient (rate limit, outage): put it back and retry with backoff.
      this.queue.unshift(...batch);
      this.trimOverflow();
      // Never sooner than the server's Retry-After (capped like the backoff).
      const delay = Math.min(
        Math.max(this.retryBaseMs * 2 ** (this.failedAttempts - 1), this.retryAfterMs ?? 0),
        this.maxRetryDelayMs,
      );
      this.scheduleFlush(delay);
      return;
    }
  }

  /**
   * Up to batchSize rows, and no more than Append's 4 MiB target of NDJSON so
   * a batch never meets the 8 MiB request limit (always at least one row).
   */
  private takeBatch(): string[] {
    let count = 0;
    let bytes = 0;
    while (count < this.queue.length && count < this.batchSize) {
      const lineBytes = Buffer.byteLength(this.queue[count]!) + 1;
      if (count > 0 && bytes + lineBytes > SCOPEDB_APPEND_TARGET_BATCH_BYTES) break;
      bytes += lineBytes;
      count += 1;
    }
    return this.queue.splice(0, count);
  }

  /** Oldest rows go first when the queue is full (e.g. during a long outage). */
  private trimOverflow(): void {
    const overflow = this.queue.length - this.maxQueueSize;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      countRows(this.table.lost, overflow);
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  /** True when the store accepted the batch (a short write is counted as loss, not retried). */
  private async writeBatch(rows: string[]): Promise<boolean> {
    // Persistence tier: decision_support. Committed Append (one attempt per
    // call; this loop owns retry); failures are retried with backoff for up to
    // the retry window (checked after each attempt, so 10-11 minutes), and
    // every row that is finally dropped (failed batch, full queue, short
    // write, unencodable row) is counted. takeBatch keeps every request
    // inside Append's 8 MiB / 200k-row limits.
    try {
      const { schema, name } = appendTarget(this.table.table);
      const result = await this.client.table(name, { schema }).append(rows.join("\n"));
      countRows(this.table.written, result.num_rows_inserted);
      countRows(this.table.lost, rows.length - result.num_rows_inserted);
      return true;
    } catch (err) {
      // Error class only: the store's error text may echo row contents.
      console.warn(`${this.table.logPrefix} ScopeDB write failed; will retry:`, errorClassOf(err));
      noteProductEventWriteFailure(writeFailureOf(this.table.name, err));
      this.retryAfterMs = classifyScopeDbAppendFailure(err).retryAfterMs;
      return false;
    }
  }
}

export class ScopeDbProductEventSink extends ScopeDbRowSink<ProductEventRow> {
  constructor(config: ScopeDbProductEventSinkConfig, client?: Pick<Client, "table">) {
    super(config, PRODUCT_EVENTS_SINK, client);
  }
}

export class ScopeDbPublicVisitorSink extends ScopeDbRowSink<PublicVisitorRow> {
  constructor(config: ScopeDbProductEventSinkConfig, client?: Pick<Client, "table">) {
    super(config, PUBLIC_VISITORS_SINK, client);
  }
}

/**
 * Product events share the trace events' ScopeDB workspace and write key
 * (product.events is a separate table there; decided in #proj-analytics,
 * 2026-10-08, recorded in RFC-067 §7). A complete SCOPEDB_PRODUCT_* pair
 * overrides that, for a separate key later; the pair is never mixed with the
 * trace one. Null when neither pair is configured.
 */
export function createProductEventSinkFromEnv(env: NodeJS.ProcessEnv = process.env): ProductEventSink | null {
  const config = resolveProductScopeDbConfig(env);
  if (!config) return null;
  return new ScopeDbProductEventSink({
    ...config,
    deploymentEnvironment: env.DEPLOYMENT_ENV?.trim() || env.NODE_ENV?.trim() || null,
  });
}

/** Same ScopeDB config as product events; null when neither pair is configured. */
export function createPublicVisitorSinkFromEnv(env: NodeJS.ProcessEnv = process.env): PublicVisitorSink | null {
  const config = resolveProductScopeDbConfig(env);
  if (!config) return null;
  return new ScopeDbPublicVisitorSink({
    ...config,
    deploymentEnvironment: env.DEPLOYMENT_ENV?.trim() || env.NODE_ENV?.trim() || null,
  });
}

export type ProductScopeDbStore = "product" | "trace_events" | "none";

/** Which env pair resolveProductScopeDbConfig takes, for the startup event. Never the values. */
export function productScopeDbStore(env: NodeJS.ProcessEnv): ProductScopeDbStore {
  if (env.SCOPEDB_PRODUCT_ENDPOINT?.trim() && env.SCOPEDB_PRODUCT_WRITE_KEY?.trim()) return "product";
  if (env.SCOPEDB_TRACE_EVENTS_ENDPOINT?.trim() && env.SCOPEDB_TRACE_EVENTS_WRITE_KEY?.trim()) return "trace_events";
  return "none";
}

export function resolveProductScopeDbConfig(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = (message) => console.warn(message),
): { endpoint: string; apiKey: string } | null {
  const productEndpoint = env.SCOPEDB_PRODUCT_ENDPOINT?.trim();
  const productKey = env.SCOPEDB_PRODUCT_WRITE_KEY?.trim();
  if (productEndpoint && productKey) return { endpoint: productEndpoint, apiKey: productKey };
  if (productEndpoint || productKey) {
    warn("[product-events] only one of SCOPEDB_PRODUCT_ENDPOINT / SCOPEDB_PRODUCT_WRITE_KEY is set; ignoring both and using the trace events' ScopeDB config");
  }
  const traceEndpoint = env.SCOPEDB_TRACE_EVENTS_ENDPOINT?.trim();
  const traceKey = env.SCOPEDB_TRACE_EVENTS_WRITE_KEY?.trim();
  if (traceEndpoint && traceKey) return { endpoint: traceEndpoint, apiKey: traceKey };
  return null;
}

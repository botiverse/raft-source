import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { noopTracer, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import * as schema from "./schema.js";
import { migratePglite } from "./pgliteMigrations.js";
import { closeRisingWavePool } from "./risingwave.js";
import { dbPoolConnections, dbPoolWaitingRequests, pgPoolReadOnlyClientRecycledTotal } from "../metrics.js";
import { getCurrentTraceContext } from "../tracing/semanticTrace.js";

let _tracer: Tracer = noopTracer;
const dbTraceAttributes = new AsyncLocalStorage<Record<string, string | number | boolean>>();
const databaseCloseHooksForTests = new Set<() => Promise<void>>();

export function setDbTracer(t: Tracer) {
  _tracer = t;
}

export function registerDatabaseCloseHookForTests(hook: () => Promise<void>): () => void {
  databaseCloseHooksForTests.add(hook);
  return () => {
    databaseCloseHooksForTests.delete(hook);
  };
}

async function runDatabaseCloseHooksForTests(): Promise<void> {
  const hooks = [...databaseCloseHooksForTests].reverse();
  const errors: Error[] = [];
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Database background work failed while closing");
}

export function withDbTraceAttributes<T>(attrs: Record<string, string | number | boolean>, fn: () => T): T {
  const parentAttrs = dbTraceAttributes.getStore();
  return dbTraceAttributes.run({ ...parentAttrs, ...attrs }, fn);
}

type DbStatementKind = "select" | "insert" | "update" | "delete" | "transaction" | "unknown";

interface QueryIdentity {
  rawSql: string;
  fingerprint: string;
  hash: string;
  exactHash: string;
  statementKind: DbStatementKind;
}

type PgErrorLike = {
  code?: unknown;
  message?: unknown;
};

interface PoolCheckoutState {
  label: string;
  queueMs: number;
  startMs: number;
  queryIdentity: QueryIdentity;
  traceParent: TraceContext | null;
  traceAttributes?: Record<string, string | number | boolean>;
}

interface InstrumentedPoolClient extends pg.PoolClient {
  __slockDbInstrumentation?: {
    checkout?: PoolCheckoutState;
    readOnlyRecycleError?: Error;
  };
}

interface InstrumentedPool extends pg.Pool {
  __slockDbInstrumented?: boolean;
}

interface ReadOnlyRecoveryState {
  lastLoggedAtMs: number;
  suppressedLogs: number;
  logIntervalMs: number;
  now(): number;
}

export function isReadOnlyTransactionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const pgError = err as PgErrorLike;
  if (pgError.code === "25006") return true;

  const message = typeof pgError.message === "string" ? pgError.message : "";
  return /\bread[- ]only\b.*\btransaction\b/i.test(message);
}

function createReadOnlyRecoveryState(): ReadOnlyRecoveryState {
  return {
    lastLoggedAtMs: 0,
    suppressedLogs: 0,
    logIntervalMs: 5_000,
    now: Date.now,
  };
}

function recycleErrorFor(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error("Postgres connection entered read-only transaction state");
}

function recordReadOnlyRecovery(label: string, err: unknown, state: ReadOnlyRecoveryState): Error {
  const recycleErr = recycleErrorFor(err);
  const pgError = err as PgErrorLike;
  const sqlstate = typeof pgError.code === "string" ? pgError.code : "unknown";
  const attrs = {
    event_kind: "db_pool_recovery",
    pool: label,
    sqlstate,
    outcome: "client_discarded",
    reason: "read_only_transaction",
  };

  pgPoolReadOnlyClientRecycledTotal.labels(label).inc();
  if (_tracer !== noopTracer) {
    _tracer.startSpan("server.db.pool.read_only_client_recycled", {
      surface: "server",
      attrs,
    }).end("ok");
  }

  const now = state.now();
  if (now - state.lastLoggedAtMs < state.logIntervalMs) {
    state.suppressedLogs += 1;
    return recycleErr;
  }

  const suppressedLogs = state.suppressedLogs;
  state.lastLoggedAtMs = now;
  state.suppressedLogs = 0;
  console.warn(JSON.stringify({
    event: "db.pg_pool.read_only_client_recycled",
    pool_label: label,
    sqlstate,
    action: "destroy_client_on_release",
    suppressed_logs: suppressedLogs,
  }));
  return recycleErr;
}

function queryTextFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const text = (input as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
}

function statementKindFromText(text: string | undefined): DbStatementKind {
  if (!text) return "unknown";
  const keyword = text.trimStart().match(/^[a-zA-Z]+/)?.[0]?.toLowerCase();
  switch (keyword) {
    case "select":
    case "with":
      return "select";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "begin":
    case "commit":
    case "rollback":
    case "savepoint":
      return "transaction";
    default:
      return "unknown";
  }
}

function normalizeSqlShape(text: string | undefined): string {
  if (!text) return "unknown";
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z_][A-Za-z0-9_]*\$/g, "?")
    .replace(/\$\$[\s\S]*?\$\$/g, "?")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "?")
    .replace(/\$\d+\b/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim() || "unknown";
}

function normalizeSqlFingerprint(text: string | undefined): string {
  return normalizeSqlShape(text).slice(0, 240);
}

function rawSqlForTrace(text: string | undefined): string {
  return (text?.trim() || "(none)").slice(0, 2_000);
}

function hashFingerprint(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

function queryIdentityFromInput(input: unknown): QueryIdentity {
  const text = queryTextFromInput(input);
  const normalizedShape = normalizeSqlShape(text);
  const fingerprint = normalizeSqlFingerprint(text);
  return {
    rawSql: rawSqlForTrace(text),
    fingerprint,
    hash: hashFingerprint(fingerprint),
    exactHash: hashFingerprint(normalizedShape),
    statementKind: statementKindFromText(text),
  };
}

function releaseDiscarded(args: unknown[]): boolean {
  return args[0] === true || args[0] instanceof Error;
}

function recordConnectionSpan(checkout: PoolCheckoutState, releaseArgs: unknown[]) {
  const holdMs = Date.now() - checkout.startMs;
  if (holdMs <= 100 || _tracer === noopTracer) return;
  const discarded = releaseDiscarded(releaseArgs);
  _tracer.startSpan("server.db.connection", {
    parent: checkout.traceParent,
    surface: "server",
    attrs: {
      event_kind: "db_connection",
      pool: checkout.label,
      queue_ms: checkout.queueMs,
      hold_ms: holdMs,
      pool_occupancy_ms: holdMs,
      db_operation: "unknown",
      statement_kind: checkout.queryIdentity.statementKind,
      query: checkout.queryIdentity.rawSql,
      query_hash: checkout.queryIdentity.hash,
      query_exact_hash: checkout.queryIdentity.exactHash,
      query_fingerprint: checkout.queryIdentity.fingerprint,
      discarded,
      ...checkout.traceAttributes,
    },
  }).end("ok", {
    attrs: {
      outcome: discarded ? "discarded" : "released",
      reason: discarded ? "release_discarded" : "release_completed",
    },
  });
}

function checkoutErrorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function recordConnectionCheckoutFailure(
  label: string,
  queueMs: number,
  queryIdentity: QueryIdentity,
  traceAttributes: Record<string, string | number | boolean> | undefined,
  traceParent: TraceContext | null,
  err: unknown,
) {
  if (_tracer === noopTracer) return;
  _tracer.startSpan("server.db.connection", {
    parent: traceParent,
    surface: "server",
    attrs: {
      event_kind: "db_connection",
      outcome: "checkout_failed",
      reason: "pool_connect_failed",
      pool: label,
      queue_ms: queueMs,
      hold_ms: 0,
      pool_occupancy_ms: 0,
      db_operation: "unknown",
      statement_kind: queryIdentity.statementKind,
      query: queryIdentity.rawSql,
      query_hash: queryIdentity.hash,
      query_exact_hash: queryIdentity.exactHash,
      query_fingerprint: queryIdentity.fingerprint,
      discarded: true,
      checkout_failed: true,
      checkout_error_class: checkoutErrorClass(err),
      ...traceAttributes,
    },
  }).end("error");
}

function markReadOnlyRecycle(
  instrumented: InstrumentedPoolClient,
  label: string,
  err: unknown,
  state: ReadOnlyRecoveryState,
) {
  if (!isReadOnlyTransactionError(err)) return;
  if (!instrumented.__slockDbInstrumentation) return;
  if (!instrumented.__slockDbInstrumentation.readOnlyRecycleError) {
    instrumented.__slockDbInstrumentation.readOnlyRecycleError = recordReadOnlyRecovery(label, err, state);
  }
}

function readOnlyRecoveryReleaseArgs(label: string, releaseArgs: unknown[], state: ReadOnlyRecoveryState): unknown[] {
  if (releaseArgs.length > 0 && isReadOnlyTransactionError(releaseArgs[0])) {
    return [recordReadOnlyRecovery(label, releaseArgs[0], state)];
  }
  return releaseArgs;
}

function preparePoolClient(
  label: string,
  client: pg.PoolClient,
  queueMs: number,
  readOnlyRecoveryState: ReadOnlyRecoveryState,
): pg.PoolClient {
  const instrumented = client as InstrumentedPoolClient;
  if (!instrumented.__slockDbInstrumentation) {
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    const state = {};
    instrumented.__slockDbInstrumentation = state;

    client.query = ((...args: unknown[]) => {
      const checkout = instrumented.__slockDbInstrumentation?.checkout;
      if (checkout) {
        checkout.queryIdentity = queryIdentityFromInput(args[0]);
        checkout.traceAttributes = dbTraceAttributes.getStore();
      }
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        const queryArgs = args.slice(0, -1);
        return originalQuery(...queryArgs as [never], (err: Error | undefined, ...rest: unknown[]) => {
          markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
          callback(err, ...rest);
        });
      }

      try {
        const result = originalQuery(...args as [never]);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).catch((err) => {
            markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
            throw err;
          });
        }
        return result;
      } catch (err) {
        markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
        throw err;
      }
    }) as pg.PoolClient["query"];

    client.release = ((...args: unknown[]) => {
      const checkout = instrumented.__slockDbInstrumentation?.checkout;
      const readOnlyRecycleError = instrumented.__slockDbInstrumentation?.readOnlyRecycleError;
      const releaseArgs = readOnlyRecycleError ? [readOnlyRecycleError] : args;
      if (instrumented.__slockDbInstrumentation) {
        instrumented.__slockDbInstrumentation.checkout = undefined;
        instrumented.__slockDbInstrumentation.readOnlyRecycleError = undefined;
      }
      if (checkout) {
        recordConnectionSpan(checkout, releaseArgs);
      }
      return originalRelease(...releaseArgs as [never]);
    }) as pg.PoolClient["release"];
  }

  instrumented.__slockDbInstrumentation.checkout = {
    label,
    queueMs,
    startMs: Date.now(),
    queryIdentity: queryIdentityFromInput(undefined),
    traceParent: getCurrentTraceContext(),
    traceAttributes: dbTraceAttributes.getStore(),
  };
  return client;
}

export function instrumentPool(label: string, pool: pg.Pool) {
  const instrumented = pool as InstrumentedPool;
  if (instrumented.__slockDbInstrumented) return;
  instrumented.__slockDbInstrumented = true;
  const readOnlyRecoveryState = createReadOnlyRecoveryState();

  const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient> | void;
  pool.connect = ((...args: unknown[]) => {
    const queueStart = Date.now();
    const traceAttributes = dbTraceAttributes.getStore();
    const traceParent = getCurrentTraceContext();
    const callback = args[0];
    if (typeof callback === "function") {
      return originalConnect((err: Error | undefined, client: pg.PoolClient | undefined, release: unknown) => {
        if (!client) {
          recordConnectionCheckoutFailure(
            label,
            Date.now() - queueStart,
            queryIdentityFromInput(undefined),
            traceAttributes,
            traceParent,
            err,
          );
          callback(err, client, release);
          return;
        }
        const prepared = preparePoolClient(label, client, Date.now() - queueStart, readOnlyRecoveryState);
        callback(err, prepared, prepared.release.bind(prepared));
      });
    }

    return (originalConnect(...args) as Promise<pg.PoolClient>).then(
      (client) => preparePoolClient(label, client, Date.now() - queueStart, readOnlyRecoveryState),
      (err) => {
        recordConnectionCheckoutFailure(
          label,
          Date.now() - queueStart,
          queryIdentityFromInput(undefined),
          traceAttributes,
          traceParent,
          err,
        );
        throw err;
      },
    );
  }) as pg.Pool["connect"];

  pool.query = ((...args: unknown[]) => {
    const callback = args[args.length - 1];
    const queueStart = Date.now();
    const queryIdentity = queryIdentityFromInput(args[0]);
    const traceAttributes = dbTraceAttributes.getStore();
    const traceParent = getCurrentTraceContext();
    const finishQuery = (client: pg.PoolClient, checkout: PoolCheckoutState, releaseArgs: unknown[]) => {
      const finalReleaseArgs = readOnlyRecoveryReleaseArgs(label, releaseArgs, readOnlyRecoveryState);
      if (finalReleaseArgs.length > 0) {
        client.release(finalReleaseArgs[0] as never);
      } else {
        client.release();
      }
      recordConnectionSpan(checkout, finalReleaseArgs);
    };

    if (typeof callback === "function") {
      const queryArgs = args.slice(0, -1);
      (originalConnect() as Promise<pg.PoolClient>).then((client) => {
        const checkout = {
          label,
          queueMs: Date.now() - queueStart,
          startMs: Date.now(),
          queryIdentity,
          traceParent,
          traceAttributes,
        };
        const query = client.query as (...queryArgs: unknown[]) => unknown;
        try {
          query(...queryArgs, (queryErr: Error | undefined, result: unknown) => {
            finishQuery(client, checkout, queryErr ? [queryErr] : []);
            callback(queryErr, result);
          });
        } catch (queryErr) {
          finishQuery(client, checkout, [queryErr]);
          callback(queryErr, undefined);
        }
      }, (err) => {
        recordConnectionCheckoutFailure(label, Date.now() - queueStart, queryIdentity, traceAttributes, traceParent, err);
        callback(err, undefined);
      });
      return;
    }

    return (originalConnect() as Promise<pg.PoolClient>).then((client) => {
      const checkout = {
        label,
        queueMs: Date.now() - queueStart,
        startMs: Date.now(),
        queryIdentity,
        traceParent,
        traceAttributes,
      };
      return Promise.resolve((client.query as (...queryArgs: unknown[]) => unknown)(...args)).then(
        (result) => {
          finishQuery(client, checkout, []);
          return result;
        },
        (err) => {
          finishQuery(client, checkout, [err]);
          throw err;
        },
      );
    }, (err) => {
      recordConnectionCheckoutFailure(label, Date.now() - queueStart, queryIdentity, traceAttributes, traceParent, err);
      throw err;
    });
  }) as pg.Pool["query"];
}

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

export class SearchQueryAbortedError extends Error {
  readonly code = "SEARCH_QUERY_ABORTED";

  constructor(message = "Message search query aborted", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchQueryAbortedError";
  }
}

export function isSearchQueryAbortedError(error: unknown): boolean {
  return error instanceof SearchQueryAbortedError
    || (
      !!error
      && typeof error === "object"
      && (
        (error as { name?: unknown }).name === "SearchQueryAbortedError"
        || (error as { code?: unknown }).code === "SEARCH_QUERY_ABORTED"
      )
    );
}

type SearchQueryResult<T extends pg.QueryResultRow> = Pick<pg.QueryResult<T>, "rows">;

type PgCancelableClient = pg.PoolClient & {
  processID?: number | null;
  secretKey?: number | null;
};

export interface PgSearchCancelContext<T extends pg.QueryResultRow = pg.QueryResultRow> {
  pool: pg.Pool;
  client: pg.PoolClient;
  query: pg.Query;
  backendPid: number | null;
}

export type PgSearchQueryCanceller = (context: PgSearchCancelContext) => void;

export interface CancellableSearchSqlOptions {
  signal?: AbortSignal;
  cancelQuery?: PgSearchQueryCanceller;
}

const pgDialect = new PgDialect();

/**
 * Return the exact normalized SQL hash emitted as `query_exact_hash` by the
 * primary-pool connection instrumentation. The human-readable fingerprint is
 * intentionally truncated, but this hash covers the complete normalized SQL.
 */
export function getSqlTraceHash(query: SQL): string {
  return queryIdentityFromInput(pgDialect.sqlToQuery(query).sql).exactHash;
}

let _db: Database | null = null;
let _pool: pg.Pool | null = null;
let _pglite: PGlite | null = null;
let _searchDb: Database | null = null;
let _searchPool: pg.Pool | null = null;

function abortErrorFor(signal?: AbortSignal): SearchQueryAbortedError {
  return new SearchQueryAbortedError("Message search query aborted", {
    cause: signal?.reason,
  });
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortErrorFor(signal);
  }
}

function isPgQueryCanceledError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && (error as { code?: unknown }).code === "57014";
}

async function connectPoolWithAbort(pool: pg.Pool, signal?: AbortSignal): Promise<pg.PoolClient> {
  throwIfSearchAborted(signal);
  const connectPromise = pool.connect();
  if (!signal) return connectPromise;

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortErrorFor(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([connectPromise, abortPromise]);
  } catch (error) {
    if (isSearchQueryAbortedError(error)) {
      connectPromise.then((client) => client.release(), () => {});
    }
    throw error;
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function cancelPgQuery(context: PgSearchCancelContext): void {
  const client = context.client as PgCancelableClient;
  if (client.processID == null || client.secretKey == null) return;

  const cancelClient = new pg.Client(context.pool.options);
  const cancelConnection = (cancelClient as unknown as {
    connection?: { once(event: "error", listener: (error: Error) => void): void };
  }).connection;
  cancelConnection?.once("error", (error) => {
    console.warn("Failed to send pg cancel request for message search:", error);
  });
  try {
    (cancelClient as unknown as { cancel(targetClient: PgCancelableClient, query: pg.Query): void })
      .cancel(client, context.query);
  } catch (error) {
    console.warn("Failed to send pg cancel request for message search:", error);
  }
}

export async function executeCancellablePgPoolSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  statement: SQL,
  options: CancellableSearchSqlOptions = {},
): Promise<SearchQueryResult<T>> {
  const { signal, cancelQuery = cancelPgQuery } = options;
  const client = await connectPoolWithAbort(pool, signal);
  const pgQuery = pgDialect.sqlToQuery(statement);

  let resolveQuery!: (value: pg.QueryResult<T>) => void;
  let rejectQuery!: (reason: unknown) => void;
  const queryPromise = new Promise<pg.QueryResult<T>>((resolve, reject) => {
    resolveQuery = resolve;
    rejectQuery = reject;
  });
  const query = new pg.Query(
    pgQuery.sql,
    pgQuery.params as unknown[],
    (error, result) => {
      if (error) {
        rejectQuery(error);
        return;
      }
      resolveQuery(result as pg.QueryResult<T>);
    },
  );

  const abortError = abortErrorFor(signal);
  let queryDone = false;
  let cancelRequested = false;
  const onAbort = () => {
    if (queryDone || cancelRequested) return;
    cancelRequested = true;
    const backendPid = (client as PgCancelableClient).processID ?? null;
    cancelQuery({ pool, client, query, backendPid });
  };

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    throwIfSearchAborted(signal);
    client.query(query);
    const result = await queryPromise;
    queryDone = true;
    if (cancelRequested) throw abortError;
    return result;
  } catch (error) {
    queryDone = true;
    if (cancelRequested || (signal?.aborted && isPgQueryCanceledError(error))) {
      throw abortError;
    }
    throw error;
  } finally {
    queryDone = true;
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (cancelRequested) {
      client.release(abortError);
    } else {
      client.release();
    }
  }
}

export async function executeSearchSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  statement: SQL,
  options: CancellableSearchSqlOptions = {},
): Promise<SearchQueryResult<T>> {
  throwIfSearchAborted(options.signal);
  const searchPool = _searchPool;
  if (!searchPool) {
    return getSearchDb().execute<T>(statement) as Promise<SearchQueryResult<T>>;
  }
  return executeCancellablePgPoolSql<T>(searchPool, statement, options);
}

function isPgliteUrl(connectionString: string) {
  return connectionString.startsWith("pglite://");
}

function getPgliteDataDir(connectionString: string): string | undefined {
  const raw = connectionString.slice("pglite://".length).trim();
  if (!raw || raw === ":memory:" || raw === "memory") return undefined;
  return raw;
}

function createPool(connectionString: string) {
  const isNeon = connectionString.includes("neon.tech");
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_MAX_CONNECTIONS) || 50,
    // Timeout waiting for a free connection from the pool (fail fast instead of queuing forever)
    connectionTimeoutMillis: 10_000,
    // Close idle connections after 60s — must be shorter than Fly.io NAT timeout (~5min)
    // so we never hand out a connection that Fly's network has silently dropped.
    idleTimeoutMillis: 60_000,
    ssl: isNeon ? { rejectUnauthorized: false } : undefined,
    // TCP keepalive: probe after 10s of silence on a checked-out connection.
    // This detects dead connections (e.g., Fly NAT drop) within ~30s instead of TCP's default ~20min.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("Unexpected pg pool error (likely a disconnected idle client):", err.message);
  });
  return pool;
}

export async function initDatabase(
  databaseUrl: string,
  searchDatabaseUrl?: string,
  options: { log?: (...args: unknown[]) => void } = {},
) {
  if (isPgliteUrl(databaseUrl)) {
    return initPgliteDatabase(new PGlite(getPgliteDataDir(databaseUrl)));
  }

  _pool = createPool(databaseUrl);
  instrumentPool("primary", _pool);
  _db = drizzleNodePg(_pool, { schema });
  _pglite = null;

  const hasSearchReplica = !!searchDatabaseUrl && searchDatabaseUrl !== databaseUrl;
  const log = options.log ?? console.log;
  if (hasSearchReplica) {
    _searchPool = createPool(searchDatabaseUrl);
    instrumentPool("search", _searchPool);
    _searchDb = drizzleNodePg(_searchPool, { schema });
    log("[db] search: using read replica");
  } else {
    _searchPool = _pool;
    _searchDb = _db;
    log("[db] search: using primary (no replica configured)");
  }
  return _db;
}

/** Attach a caller-created PGlite instance, including one restored from a datadir. */
export async function initPgliteDatabase(client: PGlite): Promise<Database> {
  try {
    await migratePglite(client);
  } catch (error) {
    await client.close();
    throw error;
  }
  _pglite = client;
  _db = drizzlePglite(client, { schema }) as unknown as Database;
  _pool = null;
  _searchPool = null;
  _searchDb = _db;
  return _db;
}

export function getDb() {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

export function isDatabaseInitialized() {
  return Boolean(_db);
}

export function getPool() {
  if (!_pool) throw new Error("Database not initialized. Call initDatabase() first.");
  return _pool;
}

export function getSearchDb() {
  if (!_searchDb) throw new Error("Database not initialized. Call initDatabase() first.");
  return _searchDb;
}

export async function pingDatabase() {
  const db = getDb();
  await db.execute(sql`SELECT 1`);
}

let _poolMetricsTimer: ReturnType<typeof setInterval> | null = null;

function emitPoolMetricsSpan(tracer: Tracer, label: string, pool: pg.Pool): void {
  const attrs: Record<string, unknown> = {
    pool: label,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
  const rejected = (pool as unknown as { rejectedCount?: number }).rejectedCount;
  if (typeof rejected === "number") {
    attrs.rejected = rejected;
  }
  tracer.startSpan("server.db.pool.stats", {
    surface: "server",
    attrs,
  }).end("ok");
}

export function startPoolMetricsReporting(tracer?: Tracer): void {
  if (_poolMetricsTimer) return;
  const t = tracer ?? noopTracer;
  const report = () => {
    const primary = _pool;
    if (!primary) return;
    reportPoolMetrics("primary", primary);
    emitPoolMetricsSpan(t, "primary", primary);
    const search = _searchPool;
    if (search && search !== primary) {
      reportPoolMetrics("search", search);
      emitPoolMetricsSpan(t, "search", search);
    }
  };
  report();
  _poolMetricsTimer = setInterval(report, 30_000);
  _poolMetricsTimer.unref?.();
}

function reportPoolMetrics(poolName: "primary" | "search", pool: pg.Pool): void {
  dbPoolConnections.set({ pool: poolName, state: "total" }, pool.totalCount);
  dbPoolConnections.set({ pool: poolName, state: "idle" }, pool.idleCount);
  dbPoolWaitingRequests.set({ pool: poolName }, pool.waitingCount);
}

export function stopPoolMetricsReporting(): void {
  if (_poolMetricsTimer) {
    clearInterval(_poolMetricsTimer);
    _poolMetricsTimer = null;
  }
}

export async function closeDatabase() {
  stopPoolMetricsReporting();
  const errors: Error[] = [];
  const closers = [
    runDatabaseCloseHooksForTests,
    closeRisingWavePool,
    ...(_pool ? [() => _pool!.end()] : []),
    ...(_searchPool && _searchPool !== _pool ? [() => _searchPool!.end()] : []),
    ...(_pglite ? [() => _pglite!.close()] : []),
  ];
  try {
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    _db = null;
    _searchDb = null;
    _pool = null;
    _pglite = null;
    _searchPool = null;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Database cleanup failed");
}

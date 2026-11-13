import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { attachPoolClientErrorHandler } from "./pgPoolErrorHandler";
import { prewarmPool, resolvePoolPrewarmCount } from "./poolPrewarm";
import { connectErrorCategory, connectPermitWaitMs, connectPhases, createConnectGate, gatedClientClass, resolveConnectConcurrency, resolveConnectTransportTimeoutMs, type ConnectAttemptFailure, type ConnectGate, type ConnectPhases } from "./connectGate";
import { noopTracer, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import * as schema from "./schema";
import { migratePglite } from "./pgliteMigrations";
import { closeRisingWavePool, getRisingWavePoolState, isRisingWaveConfigured } from "./risingwave";
import {
  isInTransaction,
  recordSecondConnectionInsideTransaction,
  refuseInsideExecutorOnly,
  scopeTransactions,
  setSavepointLeakReporter,
  type Database,
} from "./ambientTransaction";
import {
  dbPoolConnectPermitWait,
  dbPoolConnections,
  dbPoolWaitingRequests,
  pgPoolReadOnlyClientRecycledTotal,
} from "../metrics";
import {
  observeStatement,
  recordStatementError,
  statementKindFromText,
  type DbStatementKind,
} from "./statementMetrics";
import { errorClassOf, getCurrentTraceContext, recordTraceEvent } from "../tracing/semanticTrace";
import { beginLockOrderStep } from "./lockOrderRecorder";
import { beginStatementStat } from "./statementStats";

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
  // Set once a statement other than BEGIN/COMMIT/ROLLBACK/SAVEPOINT has run, so
  // the span names the work the connection was held for, not the closing COMMIT.
  hasWorkStatement?: boolean;
  // False for the first checkout of a newly opened client: its queueMs then
  // includes opening the connection (reported as connect_ms).
  connectionReused: boolean;
  // Round trip of the first statement run on this checkout, from send to
  // result. Separates "the database/pooler answered slowly" from "the
  // connection was held for other work" when hold_ms is high.
  firstQueryStartMs?: number;
  firstQueryMs?: number;
  // Splits firstQueryMs into hops: until the statement's bytes were handed to
  // the kernel (the last socket write before the reply; local to the process),
  // and until the reply's first bytes arrived (network plus everything remote).
  firstQueryWriteMs?: number;
  firstQueryFirstByteMs?: number;
  // Stable per client in this process, so spans of one connection can be grouped.
  connectionId: number;
  // How long the client sat idle in the pool before this checkout (reused only).
  idleMs?: number;
  // New clients only: part of connect_ms spent queued behind other handshakes
  // of this pool (./connectGate).
  connectPermitWaitMs?: number;
  // New clients only: where the handshake spent its time (./connectGate).
  connectPhases?: ConnectPhases;
  traceParent: TraceContext | null;
  traceAttributes?: Record<string, string | number | boolean>;
}

interface InstrumentedPoolClient extends pg.PoolClient {
  __slockDbInstrumentation?: {
    checkout?: PoolCheckoutState;
    readOnlyRecycleError?: Error;
  };
}

type InstrumentedRelease = pg.PoolClient["release"] & { __slockDbInstrumentedRelease?: true };

// Clients this process has already checked out at least once. Shared by the
// connect and pool.query paths, so a client first used by either counts as
// reused afterwards (connection_reused on server.db.connection).
const seenPoolClients = new WeakSet<object>();

function markClientCheckedOut(client: object): boolean {
  const reused = seenPoolClients.has(client);
  seenPoolClients.add(client);
  return reused;
}

const poolClientIds = new WeakMap<object, number>();
let nextPoolClientId = 1;
// When each client was last released, for idle_ms on its next checkout.
const poolClientReleasedAtMs = new WeakMap<object, number>();

function poolClientId(client: object): number {
  let id = poolClientIds.get(client);
  if (id === undefined) {
    id = nextPoolClientId;
    nextPoolClientId += 1;
    poolClientIds.set(client, id);
  }
  return id;
}

type SocketWrite = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => boolean;

// The checkout whose first statement a client's socket is timing (both the
// connect path and pool.query set it; cleared on release).
const socketTimingCheckouts = new WeakMap<object, PoolCheckoutState>();
const socketInstrumentedClients = new WeakSet<object>();

/** Starts socket timing and connection identity for one checkout of `client`. */
function beginCheckoutTiming(client: pg.PoolClient, checkout: PoolCheckoutState) {
  if (!socketInstrumentedClients.has(client)) {
    socketInstrumentedClients.add(client);
    instrumentClientSocket(client as InstrumentedPoolClient);
  }
  socketTimingCheckouts.set(client, checkout);
}

function endCheckoutTiming(client: object) {
  socketTimingCheckouts.delete(client);
  poolClientReleasedAtMs.set(client, Date.now());
}

function checkoutIdentity(client: object, connectionReused: boolean): Pick<PoolCheckoutState, "connectionId" | "idleMs"> {
  const releasedAtMs = poolClientReleasedAtMs.get(client);
  return {
    connectionId: poolClientId(client),
    ...(connectionReused && releasedAtMs !== undefined ? { idleMs: Math.max(0, Date.now() - releasedAtMs) } : {}),
  };
}

/**
 * Times the first statement of each checkout on the client's socket: when its
 * bytes were flushed (write callback) and when the reply's first bytes came
 * back. Installed once per client; a client without a socket (tests, other
 * drivers) simply reports neither.
 */
function instrumentClientSocket(instrumented: InstrumentedPoolClient) {
  const socket = (instrumented as unknown as { connection?: { stream?: { write?: SocketWrite; on?: (event: string, listener: () => void) => void } } })
    .connection?.stream;
  if (!socket || typeof socket.write !== "function" || typeof socket.on !== "function") return;
  const originalWrite = socket.write.bind(socket) as SocketWrite;
  const pendingFirstQuery = () => {
    const checkout = socketTimingCheckouts.get(instrumented);
    return checkout && checkout.firstQueryStartMs !== undefined && checkout.firstQueryFirstByteMs === undefined && checkout.firstQueryMs === undefined
      ? checkout
      : null;
  };
  socket.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const checkout = pendingFirstQuery();
    if (!checkout) return originalWrite(chunk, encodingOrCallback, callback);
    const flushed = () => {
      // The last write before the reply counts (parse/bind/execute/sync are separate writes).
      if (checkout.firstQueryFirstByteMs === undefined && checkout.firstQueryStartMs !== undefined) {
        checkout.firstQueryWriteMs = Date.now() - checkout.firstQueryStartMs;
      }
    };
    if (typeof encodingOrCallback === "function") {
      return originalWrite(chunk, (err?: Error) => { flushed(); (encodingOrCallback as (err?: Error) => void)(err); });
    }
    if (typeof callback === "function") {
      return originalWrite(chunk, encodingOrCallback, (err?: Error) => { flushed(); (callback as (err?: Error) => void)(err); });
    }
    return originalWrite(chunk, encodingOrCallback, flushed);
  }) as SocketWrite;
  socket.on("data", () => {
    const checkout = pendingFirstQuery();
    if (checkout && checkout.firstQueryStartMs !== undefined) checkout.firstQueryFirstByteMs = Date.now() - checkout.firstQueryStartMs;
  });
}

interface InstrumentedPool extends pg.Pool {
  __slockDbInstrumented?: boolean;
  __slockDbLabel?: string;
}

function isSubmittable(input: unknown): boolean {
  return !!input && typeof (input as { submit?: unknown }).submit === "function";
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
  _tracer.emitEvent("server.db.pool.read_only_client_recycled", {
    surface: "server",
    parent: getCurrentTraceContext(),
    attrs,
  });

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

// Savepoints that outlive the ambient transaction they joined (un-awaited work)
// and the 25P01 / 3B001 their RELEASE hits: see ambientTransaction.ts. The
// event goes through the request's tracer so it carries its scope attrs
// (route, server); the stack names the code that opened the savepoint.
setSavepointLeakReporter((report) => {
  const stack = report.kind === "outer_finished_with_open_savepoints"
    ? report.openSavepointStacks.join("\n---\n")
    : report.stack;
  recordTraceEvent("server.db.ambient_transaction.savepoint_leak", {
    event_kind: "db_savepoint_leak",
    kind: report.kind,
    outcome: report.kind === "outer_finished_with_open_savepoints" ? report.outcome : "none",
    sqlstate: report.kind === "savepoint_statement_failed" ? report.sqlstate : "none",
    open_savepoints: report.kind === "outer_finished_with_open_savepoints" ? report.openSavepointStacks.length : 1,
    stack,
  }, _tracer);
  console.warn(JSON.stringify({
    event: "db.ambient_transaction.savepoint_leak",
    trace_id: getCurrentTraceContext()?.traceId ?? null,
    ...report,
  }));
});

function queryTextFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const text = (input as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
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

/**
 * Lock conflicts PostgreSQL resolved by aborting this statement: 40P01
 * deadlock_detected, 40001 serialization_failure, 55P03 lock_not_available.
 */
const LOCK_CONFLICT_SQLSTATES = new Set(["40P01", "40001", "55P03"]);

/**
 * db.lock_conflict: recorded when the statement fails, before the error
 * reaches any caller, so a caller that swallows it (or code that never goes
 * through withTransientTransactionRetry) still leaves a trace. Prod 10-18: 3
 * deadlocks in Neon's log, no server-side trace of either side, and Neon's
 * log export carries no DETAIL (#proj-o11y:058cb07b, tygg). Only the
 * normalized fingerprint (no literal values) and its hash; the event joins
 * its route/worker and query name through the current trace.
 */
function recordLockConflict(label: string, err: unknown, identityOf: () => QueryIdentity): void {
  const code = (err as PgErrorLike | null)?.code;
  if (typeof code !== "string" || !LOCK_CONFLICT_SQLSTATES.has(code)) return;
  const identity = identityOf();
  const ambient = dbTraceAttributes.getStore();
  recordTraceEvent("db.lock_conflict", {
    event_kind: "db_lock_conflict",
    sqlstate: code,
    pool: label,
    in_transaction: isInTransaction(),
    statement_kind: identity.statementKind,
    sql_hash: identity.hash,
    sql_fingerprint: identity.fingerprint.slice(0, 500),
    ...(typeof ambient?.db_callsite === "string" ? { db_callsite: ambient.db_callsite } : {}),
  }, _tracer);
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
  // Reused checkouts are recorded only when held > 100 ms (volume). Every new
  // connection is recorded, so new-connection counts and connect_ms are complete
  // (Neon connection-limit analysis, 10-12). record_condition tells readers
  // which rule admitted the span; never read a count of all checkouts from it.
  const recordCondition = !checkout.connectionReused ? "new_connection" : holdMs > 100 ? "hold_over_100ms" : null;
  if (recordCondition === null || _tracer === noopTracer) return;
  const discarded = releaseDiscarded(releaseArgs);
  _tracer.startSpan("server.db.connection", {
    parent: checkout.traceParent,
    surface: "server",
    startTimeMs: checkout.startMs - checkout.queueMs,
    attrs: {
      event_kind: "db_connection",
      record_condition: recordCondition,
      pool: checkout.label,
      queue_ms: checkout.queueMs,
      hold_ms: holdMs,
      pool_occupancy_ms: holdMs,
      connection_reused: checkout.connectionReused,
      ...(checkout.connectionReused ? {} : { connect_ms: checkout.queueMs }),
      ...(checkout.connectPermitWaitMs === undefined ? {} : { connect_permit_wait_ms: checkout.connectPermitWaitMs }),
      ...connectPhaseAttrs(checkout.connectPhases),
      ...(checkout.firstQueryMs === undefined ? {} : { first_query_ms: checkout.firstQueryMs }),
      ...(checkout.firstQueryWriteMs === undefined ? {} : { first_query_write_ms: checkout.firstQueryWriteMs }),
      ...(checkout.firstQueryFirstByteMs === undefined ? {} : { first_query_first_byte_ms: checkout.firstQueryFirstByteMs }),
      connection_id: checkout.connectionId,
      ...(checkout.idleMs === undefined ? {} : { idle_ms: checkout.idleMs }),
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
  return errorClassOf(err);
}

/** The connect gate of each pool, by label, so a checkout failure can say how full it was. */
const connectGatesByPool = new Map<string, ConnectGate>();

function connectGateAttrs(label: string): Record<string, number> {
  const gate = connectGatesByPool.get(label);
  if (!gate) return {};
  const state = gate.state();
  return { connect_in_flight: state.connecting, connect_queued: state.queued, connect_limit: gate.limit };
}

function recordConnectionCheckoutFailure(
  label: string,
  queueMs: number,
  queryIdentity: QueryIdentity,
  traceAttributes: Record<string, string | number | boolean> | undefined,
  traceParent: TraceContext | null,
  err: unknown,
) {
  // Before the tracer check: the counter must move even with tracing off.
  recordStatementError(label, err);
  if (_tracer === noopTracer) return;
  _tracer.startSpan("server.db.connection", {
    parent: traceParent,
    surface: "server",
    startTimeMs: Date.now() - queueMs,
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
      checkout_error_category: connectErrorCategory(err),
      ...connectGateAttrs(label),
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
  const connectionReused = markClientCheckedOut(client);
  if (!instrumented.__slockDbInstrumentation) {
    const originalQuery = client.query.bind(client);
    const state = {};
    instrumented.__slockDbInstrumentation = state;

    client.query = ((...args: unknown[]) => {
      const checkout = instrumented.__slockDbInstrumentation?.checkout;
      const timesFirstQuery = Boolean(checkout && checkout.firstQueryStartMs === undefined);
      if (checkout && timesFirstQuery) checkout.firstQueryStartMs = Date.now();
      const statementStartMs = Date.now();
      let statementKind: DbStatementKind = "unknown";
      // pool.query times its own statement (no checkout here); a submittable
      // (pg.Query) completes after this call returns, so its caller times it.
      const timesStatement = Boolean(checkout) && !isSubmittable(args[0]);
      const finishLockOrderStep = beginLockOrderStep(
        queryTextFromInput(args[0]),
        Array.isArray(args[1]) ? args[1] : (args[0] as { values?: unknown } | null)?.values,
        () => queryIdentityFromInput(args[0]).hash,
      );
      const finishStatementStat = beginStatementStat(() => queryIdentityFromInput(args[0]).hash);
      const finishStatement = (err?: unknown) => {
        finishLockOrderStep?.(err);
        finishStatementStat?.(err);
        if (checkout && timesFirstQuery && checkout.firstQueryMs === undefined && checkout.firstQueryStartMs !== undefined) {
          checkout.firstQueryMs = Date.now() - checkout.firstQueryStartMs;
        }
        if (checkout && timesStatement) observeStatement(checkout.label, statementKind, statementStartMs, err);
        // Rare, so the statement's identity is only built when one happens.
        if (err) recordLockConflict(checkout?.label ?? label, err, () => queryIdentityFromInput(args[0]));
      };
      if (checkout) {
        const queryIdentity = queryIdentityFromInput(args[0]);
        statementKind = queryIdentity.statementKind;
        const isWorkStatement = queryIdentity.statementKind !== "transaction";
        if (isWorkStatement || !checkout.hasWorkStatement) {
          checkout.queryIdentity = queryIdentity;
          checkout.traceAttributes = dbTraceAttributes.getStore();
          checkout.hasWorkStatement ||= isWorkStatement;
        }
      }
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        const queryArgs = args.slice(0, -1);
        return originalQuery(...queryArgs as [never], (err: Error | undefined, ...rest: unknown[]) => {
          finishStatement(err);
          markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
          callback(err, ...rest);
        });
      }

      try {
        const result = originalQuery(...args as [never]);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (value) => {
              finishStatement();
              return value;
            },
            (err) => {
              finishStatement(err);
              markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
              throw err;
            },
          );
        }
        finishStatement();
        return result;
      } catch (err) {
        finishStatement(err);
        markReadOnlyRecycle(instrumented, checkout?.label ?? "unknown", err, readOnlyRecoveryState);
        throw err;
      }
    }) as pg.PoolClient["query"];

  }

  // pg-pool assigns a fresh client.release on every checkout, so the release
  // hook must be re-installed per checkout; installing it once per client
  // dropped the connection span (and the read-only recycle) for every reuse.
  if (!(client.release as InstrumentedRelease).__slockDbInstrumentedRelease) {
    const originalRelease = client.release.bind(client);
    const release = ((...args: unknown[]) => {
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
      endCheckoutTiming(client);
      return originalRelease(...releaseArgs as [never]);
    }) as InstrumentedRelease;
    release.__slockDbInstrumentedRelease = true;
    client.release = release;
  }

  const checkout: PoolCheckoutState = {
    label,
    queueMs,
    connectionReused,
    ...checkoutIdentity(client, connectionReused),
    ...(connectionReused ? {} : { connectPermitWaitMs: connectPermitWaitMs(client), connectPhases: connectPhases(client) }),
    startMs: Date.now(),
    queryIdentity: queryIdentityFromInput(undefined),
    traceParent: getCurrentTraceContext(),
    traceAttributes: dbTraceAttributes.getStore(),
  };
  instrumented.__slockDbInstrumentation.checkout = checkout;
  beginCheckoutTiming(client, checkout);
  return client;
}

export function instrumentPool(label: string, pool: pg.Pool) {
  const instrumented = pool as InstrumentedPool;
  if (instrumented.__slockDbInstrumented) return;
  instrumented.__slockDbInstrumented = true;
  instrumented.__slockDbLabel = label;
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
      // pool.query runs exactly one statement right after checkout, so its round
      // trip is the whole hold.
      checkout.firstQueryMs ??= Date.now() - checkout.startMs;
      observeStatement(label, queryIdentity.statementKind, checkout.startMs, releaseArgs[0]);
      endCheckoutTiming(client);
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
        const connectionReused = markClientCheckedOut(client);
        const checkout: PoolCheckoutState = {
          label,
          queueMs: Date.now() - queueStart,
          connectionReused,
          ...checkoutIdentity(client, connectionReused),
          startMs: Date.now(),
          queryIdentity,
          traceParent,
          traceAttributes,
        };
        checkout.firstQueryStartMs = checkout.startMs;
        beginCheckoutTiming(client, checkout);
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
      const connectionReused = markClientCheckedOut(client);
      const checkout: PoolCheckoutState = {
        label,
        queueMs: Date.now() - queueStart,
        connectionReused,
        ...checkoutIdentity(client, connectionReused),
        startMs: Date.now(),
        queryIdentity,
        traceParent,
        traceAttributes,
      };
      checkout.firstQueryStartMs = checkout.startMs;
      beginCheckoutTiming(client, checkout);
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

export type { Database, DatabaseExecutor, DatabaseTransaction } from "./ambientTransaction";

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
// Public server SEO task #4: a small pool used only to authenticate the
// raft.build service credential, so its waits never touch the content pool.
let _authUrl: string | null = null;
let _authPool: pg.Pool | null = null;
let _authDb: Database | null = null;

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
  // The Client instance itself must carry an 'error' listener: a dropped
  // connection makes pg emit 'error' on the Client, and an unhandled 'error'
  // event crashes the process (task #269).
  cancelClient.on("error", (error) => {
    console.warn("Failed to send pg cancel request for message search:", error);
  });
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

  const poolLabel = (pool as InstrumentedPool).__slockDbLabel;
  let statementStartMs: number | undefined;
  try {
    throwIfSearchAborted(signal);
    statementStartMs = Date.now();
    client.query(query);
    const result = await queryPromise;
    queryDone = true;
    if (poolLabel) observeStatement(poolLabel, statementKindFromText(pgQuery.sql), statementStartMs);
    if (cancelRequested) throw abortError;
    return result;
  } catch (error) {
    queryDone = true;
    const callerAborted = cancelRequested || (signal?.aborted && isPgQueryCanceledError(error));
    // A cancel the caller asked for is not a database timeout; keep it out of 57014.
    if (poolLabel && statementStartMs !== undefined && !isSearchQueryAbortedError(error) && !callerAborted) {
      observeStatement(poolLabel, statementKindFromText(pgQuery.sql), statementStartMs, error);
    }
    if (callerAborted) {
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

const REPLICA_CONNECTION_ERROR_CODES = new Set([
  // Connection exception class, admin/crash shutdown, "cannot connect now", too many connections.
  "08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03", "53300",
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);

/**
 * Why a failed replica search query may run once more on the primary, or null
 * when it must not: the replica could not be reached or dropped the connection
 * ("connection"), or it cancelled the query to apply WAL ("recovery_conflict",
 * 40001). Statement timeouts, query errors and caller aborts are not retried,
 * and neither is waiting for a free connection in the search pool itself
 * ("timeout exceeded when trying to connect"): that is load, and moving it onto
 * the primary would spread it there.
 */
export function searchReplicaFallbackReason(error: unknown): "connection" | "recovery_conflict" | null {
  if (!error || typeof error !== "object" || isSearchQueryAbortedError(error)) return null;
  const code = (error as { code?: unknown }).code;
  if (code === "40001") return "recovery_conflict";
  if (typeof code === "string" && REPLICA_CONNECTION_ERROR_CODES.has(code)) return "connection";
  const message = error instanceof Error ? error.message : "";
  if (/timeout exceeded when trying to connect|waiting for a connect permit/i.test(message)) return null;
  if (/connection terminated|connection error|due to connection timeout/i.test(message)) return "connection";
  return null;
}

type PoolSqlExecutor = <T extends pg.QueryResultRow>(
  pool: pg.Pool,
  statement: SQL,
  options: CancellableSearchSqlOptions,
) => Promise<SearchQueryResult<T>>;

/**
 * Run a search query on the replica; when the replica fails for a reason
 * `searchReplicaFallbackReason` accepts, run it once on the primary and record
 * `server.db.search_replica_fallback` so the fallbacks can be counted.
 */
export async function executeSearchSqlWithPrimaryFallback<T extends pg.QueryResultRow = pg.QueryResultRow>(
  searchPool: pg.Pool,
  primaryPool: pg.Pool,
  statement: SQL,
  options: CancellableSearchSqlOptions = {},
  execute: PoolSqlExecutor = executeCancellablePgPoolSql,
): Promise<SearchQueryResult<T>> {
  try {
    return await execute<T>(searchPool, statement, options);
  } catch (error) {
    const reason = searchReplicaFallbackReason(error);
    if (!reason || options.signal?.aborted) throw error;
    recordTraceEvent("server.db.search_replica_fallback", {
      reason,
      error_code: connectErrorCategory(error),
    });
    return execute<T>(primaryPool, statement, options);
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
  // A separate replica pool is a second connection relative to the ambient
  // transaction; surface it in the audit so search reads can't silently split
  // off from an in-flight transaction.
  refuseInsideExecutorOnly("executeSearchSql()");
  recordSecondConnectionInsideTransaction("executeSearchSql");
  const primaryPool = _pool;
  if (!primaryPool || primaryPool === searchPool) {
    return executeCancellablePgPoolSql<T>(searchPool, statement, options);
  }
  return executeSearchSqlWithPrimaryFallback<T>(searchPool, primaryPool, statement, options);
}

function isPgliteUrl(connectionString: string) {
  return connectionString.startsWith("pglite://");
}

function getPgliteDataDir(connectionString: string): string | undefined {
  const raw = connectionString.slice("pglite://".length).trim();
  if (!raw || raw === ":memory:" || raw === "memory") return undefined;
  return raw;
}

// How long an idle client stays in the pool before it is closed. Every new
// connection costs a 600-700 ms TLS + auth handshake through Neon's proxy, and
// the proxy refused ~14k new connections in the 24 h to 10-12 ("Too many
// database connection attempts are currently ongoing"). Replaying that day's
// pool sizes, a 5 min timeout opens ~71% fewer connections than 60 s.
// Safe to hold for 5 minutes: TCP keepalive (below) sends a probe every 10 s
// of silence, which keeps the AWS NAT gateway flow (350 s idle limit) alive,
// and Neon's PgBouncer does not close idle clients (checked by holding pooled
// connections idle for 330 s and 620 s on production).
export const DEFAULT_PG_POOL_IDLE_TIMEOUT_MS = 300_000;

/** `PG_POOL_IDLE_TIMEOUT_MS` (default 300000). Values below 1000 fall back to the default. */
export function resolvePoolIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PG_POOL_IDLE_TIMEOUT_MS;
  const parsed = raw === undefined || raw.trim() === "" ? DEFAULT_PG_POOL_IDLE_TIMEOUT_MS : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_PG_POOL_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
}

// Exported for the task #269 real-PG teeth: the child process in
// pgPoolErrorHandler.realPg.child.ts must exercise this exact wiring (helper
// + attach site), not a mirror of it.
// Which side a stuck connect is on (o11y 2026-10-15): queued behind full
// permits, or the handshake itself; and the error category, not text.
/** A handshake's phase timings as span attributes (absent phases are left out). */
function connectPhaseAttrs(phases: ConnectPhases | undefined): Record<string, number> {
  if (!phases) return {};
  return {
    ...(phases.dnsMs === undefined ? {} : { connect_dns_ms: phases.dnsMs }),
    ...(phases.tcpMs === undefined ? {} : { connect_tcp_ms: phases.tcpMs }),
    ...(phases.tlsMs === undefined ? {} : { connect_tls_ms: phases.tlsMs }),
    ...(phases.authMs === undefined ? {} : { connect_auth_ms: phases.authMs }),
  };
}

function recordConnectAttemptFailure(label: string, gate: ConnectGate, failure: ConnectAttemptFailure): void {
  const gateState = gate.state();
  _tracer.emitEvent("server.db.connect_attempt_failed", {
    surface: "server",
    parent: getCurrentTraceContext(),
    attrs: {
      event_kind: "db_connect_attempt",
      pool: label,
      stage: failure.stage,
      connect_permit_wait_ms: failure.permitWaitMs,
      handshake_ms: failure.handshakeMs,
      error_category: failure.errorCategory,
      ...(failure.handshakeStage ? { handshake_stage: failure.handshakeStage } : {}),
      ...connectPhaseAttrs(failure.phases),
      connect_in_flight: gateState.connecting,
      connect_queued: gateState.queued,
      connect_limit: gate.limit,
    },
  });
}

export function createPool(
  connectionString: string,
  options: { min?: number; label?: string; connectConcurrency?: number } = {},
) {
  const isNeon = connectionString.includes("neon.tech");
  const label = options.label ?? "pg";
  // At most this many handshakes in flight per pool; the rest queue (./connectGate).
  const connectGate = createConnectGate(options.connectConcurrency ?? resolveConnectConcurrency(process.env));
  connectGatesByPool.set(label, connectGate);
  const pool = new pg.Pool({
    Client: gatedClientClass(connectGate, (waitMs) => {
      dbPoolConnectPermitWait.labels(label).observe(waitMs / 1000);
    }, (failure) => recordConnectAttemptFailure(label, connectGate, failure), resolveConnectTransportTimeoutMs(process.env)),
    connectionString,
    max: pgMaxConnections(),
    // Idle clients up to `min` are not closed by idleTimeoutMillis. Set only on
    // the primary pool, to the pre-warm count (see ./poolPrewarm).
    min: options.min ?? 0,
    // Timeout waiting for a free connection from the pool (fail fast instead of queuing forever)
    connectionTimeoutMillis: 10_000,
    // Close idle connections after PG_POOL_IDLE_TIMEOUT_MS (default 5 min, see above).
    idleTimeoutMillis: resolvePoolIdleTimeoutMs(process.env),
    ssl: isNeon ? { rejectUnauthorized: false } : undefined,
    // TCP keepalive: probe after 10s of silence on the socket, idle in the pool
    // or checked out. Keeps NAT flows alive and detects dead connections within
    // ~30s instead of TCP's default ~20min.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("Unexpected pg pool error (likely a disconnected idle client):", err.message);
  });
  // Checked-out clients lose pg-pool's idle 'error' listener; without our own,
  // a server-side connection drop between queries kills the process (task #269).
  attachPoolClientErrorHandler(pool, "pg");
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

  _authUrl = databaseUrl;
  _pool = createPool(databaseUrl, { min: resolvePoolPrewarmCount(process.env, pgMaxConnections()), label: "primary" });
  instrumentPool("primary", _pool);
  _rootDb = drizzleNodePg(_pool, { schema });
  _db = scopeTransactions(_rootDb);
  _pglite = null;

  const hasSearchReplica = !!searchDatabaseUrl && searchDatabaseUrl !== databaseUrl;
  const log = options.log ?? console.log;
  if (hasSearchReplica) {
    _searchPool = createPool(searchDatabaseUrl, { label: "search" });
    instrumentPool("search", _searchPool);
    _searchDb = scopeTransactions(drizzleNodePg(_searchPool, { schema }));
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
  _rootDb = drizzlePglite(client, { schema }) as unknown as Database;
  _db = scopeTransactions(_rootDb);
  _pool = null;
  _searchPool = null;
  _searchDb = _db;
  return _db;
}

/**
 * The open transaction is the ambient connection.
 *
 * Functions take their executor as an optional argument that defaults to getDb(), and
 * some capture `const db = getDb()` before opening a transaction. Either way a caller
 * that forgets to pass its transaction down used to query the ROOT pool while its own
 * transaction was open: a second connection that cannot see the transaction's
 * uncommitted rows and can wait on a lock the transaction holds (on the
 * single-connection test database, a hang). Nothing in the types catches that.
 *
 * So the root database is wrapped: while a transaction callback is running, every use
 * of the root -- through getDb() or through a handle taken earlier -- goes to that
 * transaction. A root `transaction(...)` inside one becomes a savepoint on it. After
 * the callback settles the scope is closed, so a promise that outlives the commit is
 * back on the pool.
 *
 * getRootDb() is the deliberate escape hatch: a separate connection even inside a
 * transaction. An audit over the full server suite (2026-09-25) found no code that
 * needs one; any future use should say why at the call site.
 *
 * RAFT_TX_POOL_AUDIT_FILE (tests/diagnostics): records every second-connection use
 * made inside a transaction — the root escape hatch (getRootDb), a separate search
 * replica (getSearchDb / executeSearchSql when a replica pool exists), or any other
 * path that reaches a connection outside the ambient transaction. Each entry carries
 * the source label and a stack.
 */
let _rootDb: Database | null = null;

export function getDb() {
  if (!_db) throw new Error("Database not initialized. Call initDatabase() first.");
  return _db;
}

/**
 * A connection OUTSIDE any open transaction -- only for work that must not join it.
 * Say why at the call site.
 */
export function getRootDb(): Database {
  if (!_rootDb) throw new Error("Database not initialized. Call initDatabase() first.");
  refuseInsideExecutorOnly("getRootDb()");
  recordSecondConnectionInsideTransaction("getRootDb");
  return _rootDb;
}

export function isDatabaseInitialized() {
  return Boolean(_db);
}

/**
 * Pool gauges only — a read-only view of the primary pool's size, for tracing.
 * The raw `pg.Pool` is not exposed: that would be a Proxy-bypassing escape hatch
 * able to open a second connection inside a transaction (the exact hazard #8319
 * closes).
 */
export function getPoolMetrics(): { waitingCount: number; totalCount: number; idleCount: number } | null {
  if (!_pool) return null;
  return { waitingCount: _pool.waitingCount, totalCount: _pool.totalCount, idleCount: _pool.idleCount };
}

export function getSearchDb() {
  if (!_searchDb) throw new Error("Database not initialized. Call initDatabase() first.");
  // When a separate read replica is configured, getSearchDb() reaches a connection
  // outside the ambient transaction — a second connection. The no-replica case is
  // just _db (the wrapped primary), so only the replica case is a hazard to audit.
  if (_searchDb !== _db) recordSecondConnectionInsideTransaction("getSearchDb");
  return _searchDb;
}

function pgMaxConnections(): number {
  return Number(process.env.PG_MAX_CONNECTIONS) || 50;
}

/**
 * Open PG_POOL_PREWARM (default 10) primary connections before the server
 * listens. Primary pool only; the search pool stays on demand. Never throws and
 * is bounded (2s per connect, 5s overall), so it cannot hold startup.
 */
export async function prewarmPrimaryPool(): Promise<void> {
  const pool = _pool;
  if (!pool) return;
  const count = resolvePoolPrewarmCount(process.env, pgMaxConnections());
  if (count === 0) return;
  try {
    await prewarmPool(pool, { count });
  } catch (error) {
    console.warn("[db] pool pre-warm skipped:", error instanceof Error ? error.message : String(error));
  }
}

export async function pingDatabase() {
  const db = getDb();
  await db.execute(sql`SELECT 1`);
}

let _poolMetricsTimer: ReturnType<typeof setInterval> | null = null;

export function startPoolMetricsReporting(): void {
  if (_poolMetricsTimer) return;
  const report = () => {
    const primary = _pool;
    if (!primary) return;
    reportPoolMetrics("primary", primary);
    const search = _searchPool;
    if (search && search !== primary) {
      reportPoolMetrics("search", search);
    }
    if (isRisingWaveConfigured()) {
      // Read-only peek: reports zeros until the first RW read opens the pool.
      const rw = getRisingWavePoolState();
      dbPoolConnections.set({ pool: "risingwave", state: "total" }, rw.rw_pool_total);
      dbPoolConnections.set({ pool: "risingwave", state: "idle" }, rw.rw_pool_idle);
      dbPoolWaitingRequests.set({ pool: "risingwave" }, rw.rw_pool_waiting);
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

/**
 * The bounded authentication database (task #4): at most two connections, a
 * connection wait, statement timeout and client query timeout of `timeoutMs`
 * each, no retry. A caller that times out never queues on, or later takes, a
 * connection of the content pool. Null on PGlite or before initDatabase.
 */
export function getBoundedAuthDb(timeoutMs: number): Database | null {
  if (!_authUrl) return null;
  if (!_authDb) {
    _authPool = new pg.Pool({
      connectionString: _authUrl,
      max: 2,
      min: 0,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs + 50,
      idleTimeoutMillis: 30_000,
      application_name: "raft-public-search-auth",
      ssl: _authUrl.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    _authPool.on("error", (err) => {
      console.error("Unexpected pg auth pool error:", err.message);
    });
    attachPoolClientErrorHandler(_authPool, "pg-auth");
    _authDb = drizzleNodePg(_authPool, { schema });
  }
  return _authDb;
}

export async function closeDatabase() {
  stopPoolMetricsReporting();
  const errors: Error[] = [];
  const closers = [
    runDatabaseCloseHooksForTests,
    closeRisingWavePool,
    ...(_pool ? [() => _pool!.end()] : []),
    ...(_searchPool && _searchPool !== _pool ? [() => _searchPool!.end()] : []),
    ...(_authPool ? [() => _authPool!.end()] : []),
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
    _rootDb = null;
    _searchDb = null;
    _pool = null;
    _pglite = null;
    _searchPool = null;
    _authPool = null;
    _authDb = null;
    _authUrl = null;
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Database cleanup failed");
}

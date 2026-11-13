import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Ambient-transaction state, split out of index.ts so external sinks
// (RisingWave query, Redis client, APNs send, the audited global fetch) can
// query "am I inside a transaction?" without importing all of db/index.ts
// (which would create index -> risingwave -> index module cycles).

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

// A root transaction opened while an ambient transaction is running joins it
// as a SAVEPOINT. If the outer callback did not await that work (`void f()`, an
// event listener, a timer), the outer used to COMMIT and hand its pool client
// back while the savepoint was still running: the savepoint's remaining
// statements then ran outside any transaction, or inside ANOTHER request's
// transaction on the reused client (prod 2026-10-13: ~2,200 RELEASE SAVEPOINT
// 25P01 a day, plus 3B001 / 25P02 in the requests they landed in).
//
// So: the outer waits for its open savepoints before it COMMITs (or ROLLBACKs),
// up to SAVEPOINT_DRAIN_TIMEOUT_MS, after which it rolls back with
// SavepointDrainTimeoutError. Once the outer callback has returned, a new root
// transaction no longer joins it; it runs as its own transaction. Both cases
// are reported with the call stack that opened the savepoint.
type OpenSavepoint = { stack: string; done: Promise<unknown> };
type TransactionScope = {
  tx: DatabaseTransaction;
  active: boolean;
  /** The outer callback has returned; the outer is draining savepoints and about to COMMIT/ROLLBACK. */
  finishing: boolean;
  openSavepoints: Set<OpenSavepoint>;
  /** afterAmbientTransaction work, run once the outer has committed or rolled back. */
  afterSettled: Array<() => void>;
  /** afterAmbientCommit work by key (one per key), run only once the outer has committed. */
  afterCommitted: Map<string, () => void>;
  /**
   * Set (to what the section is, for the error) while runExecutorOnly's callback
   * runs: the root database is off limits there, the ambient transaction included.
   */
  executorOnly?: string;
};
const transactionScope = new AsyncLocalStorage<TransactionScope>();

export const SAVEPOINT_DRAIN_TIMEOUT_MS = 10_000;
let savepointDrainTimeoutMs = SAVEPOINT_DRAIN_TIMEOUT_MS;

export function setSavepointDrainTimeoutMsForTests(ms: number): number {
  const previous = savepointDrainTimeoutMs;
  savepointDrainTimeoutMs = ms;
  return previous;
}

/**
 * RESIDUAL RISK: on this path the outer rolls back and hands its pool client
 * back while the un-awaited savepoint is STILL running, so its later statements
 * can land outside any transaction or in another request's transaction on the
 * reused client: the original 25P01 / 3B001 failure. With the known kick sites
 * moved to afterAmbientTransaction this should never happen; any occurrence is
 * a new leak site and the most severe event of this class. Investigate each one.
 */
export class SavepointDrainTimeoutError extends Error {
  constructor(openSavepoints: number, timeoutMs: number) {
    super(`transaction rolled back: ${openSavepoints} un-awaited savepoint(s) still running after ${timeoutMs}ms`);
    this.name = "SavepointDrainTimeoutError";
  }
}

export type SavepointLeakReport =
  | { kind: "outer_finished_with_open_savepoints"; outcome: "drained" | "timed_out"; openSavepointStacks: string[] }
  | { kind: "transaction_while_outer_finishing"; stack: string }
  | { kind: "savepoint_statement_failed"; sqlstate: string; stack: string };

let savepointLeakReporter: (report: SavepointLeakReport) => void = (report) => {
  console.warn(JSON.stringify({ event: "db.ambient_transaction.savepoint_leak", ...report }));
};

/** Set by db/index.ts so reports carry the trace context; tests capture them. Returns the previous reporter. */
export function setSavepointLeakReporter(
  reporter: (report: SavepointLeakReport) => void,
): (report: SavepointLeakReport) => void {
  const previous = savepointLeakReporter;
  savepointLeakReporter = reporter;
  return previous;
}

// 25P01 = RELEASE/ROLLBACK TO outside a transaction block; 3B001 = the
// savepoint is not in the (other) transaction the statement landed in.
const SAVEPOINT_LEAK_SQLSTATES = new Set(["25P01", "3B001"]);

function sqlstateOf(error: unknown): string | null {
  // drizzle wraps driver errors; the pg error (with .code) is the cause.
  for (let e = error as { code?: unknown; cause?: unknown } | null, depth = 0; e && depth < 3; depth += 1) {
    if (typeof e.code === "string") return e.code;
    e = e.cause as typeof e;
  }
  return null;
}

function callSiteStack(): string {
  return (new Error().stack ?? "").split("\n").slice(3, 15).join("\n");
}

function activeTransaction(): DatabaseTransaction | null {
  const scope = transactionScope.getStore();
  return scope?.active ? scope.tx : null;
}

/** A use of the root database inside runExecutorOnly: the section may read and write only through the executor it was handed. */
export class ExecutorOnlyDatabaseAccessError extends Error {
  constructor(readonly section: string, readonly source: string) {
    super(`${section} may use the database only through the executor it is handed, not ${source}`);
    this.name = "ExecutorOnlyDatabaseAccessError";
  }
}

/**
 * Run `fn` with the root database off limits: inside it (and everything it
 * awaits), any use of getDb() (a query, a transaction; a handle taken earlier
 * too), getRootDb() or the search database throws
 * ExecutorOnlyDatabaseAccessError. Only a handle passed in explicitly, the
 * executor the caller hands `fn`, still works.
 *
 * For code another module's transaction runs on its behalf (a first-party
 * app's write inside a reaction's transaction): what it reads and writes is
 * then visible at its call sites, and nothing it calls can quietly add
 * statements to the caller's transaction through the ambient connection, or
 * reach a second connection while that transaction is open. `section` names
 * it in the error.
 *
 * The transaction's own bookkeeping is shared with the section
 * (afterAmbientTransaction / afterAmbientCommit registered inside still run
 * with the outer transaction). Works with no transaction open as well.
 */
export function runExecutorOnly<T>(section: string, fn: () => Promise<T>): Promise<T> {
  const outer = transactionScope.getStore();
  // Derived, not copied: `active`, `finishing` and the collections stay the outer scope's own.
  const scope = outer
    ? Object.create(outer, { executorOnly: { value: section, enumerable: true } }) as TransactionScope
    : { ...newTransactionScope(null as never), active: false, executorOnly: section };
  return transactionScope.run(scope, fn);
}

/** Throws inside runExecutorOnly; `source` names what was reached for (getRootDb, getSearchDb). */
export function refuseInsideExecutorOnly(source: string): void {
  const section = transactionScope.getStore()?.executorOnly;
  if (section) throw new ExecutorOnlyDatabaseAccessError(section, source);
}

/** Waits for savepoints the outer callback left running. Returns false on timeout. */
async function drainOpenSavepoints(scope: TransactionScope): Promise<boolean> {
  if (scope.openSavepoints.size === 0) return true;
  const open = [...scope.openSavepoints];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    (async () => {
      // Sequential: waiting on one already-running promise after another, not a fan-out.
      for (const savepoint of open) await savepoint.done.then(() => undefined, () => undefined);
      return false;
    })(),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), savepointDrainTimeoutMs); }),
  ]);
  clearTimeout(timer);
  savepointLeakReporter({
    kind: "outer_finished_with_open_savepoints",
    outcome: timedOut ? "timed_out" : "drained",
    openSavepointStacks: open.map((savepoint) => savepoint.stack),
  });
  return !timedOut;
}

/** The live transaction scope, consumed by scopeTransactions in index.ts. */
function newTransactionScope(tx: DatabaseTransaction): TransactionScope {
  return { tx, active: true, finishing: false, openSavepoints: new Set(), afterSettled: [], afterCommitted: new Map() };
}

function runInTransactionScope<T>(scope: TransactionScope, fn: () => Promise<T>): Promise<T> {
  return transactionScope.run(scope, async () => {
    try {
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await fn() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      scope.finishing = true;
      const openCount = scope.openSavepoints.size;
      const drained = await drainOpenSavepoints(scope);
      if (!outcome.ok) throw outcome.error;
      if (!drained) throw new SavepointDrainTimeoutError(openCount, savepointDrainTimeoutMs);
      return outcome.value;
    } finally {
      scope.active = false;
    }
  });
}

function joinAsSavepoint(
  scope: TransactionScope,
  callback: (tx: DatabaseTransaction) => Promise<unknown>,
): Promise<unknown> {
  const stack = callSiteStack();
  const done = (async () => {
    try {
      return await scope.tx.transaction(callback as never);
    } catch (error) {
      const code = sqlstateOf(error);
      if (code && SAVEPOINT_LEAK_SQLSTATES.has(code)) {
        savepointLeakReporter({ kind: "savepoint_statement_failed", sqlstate: code, stack });
      }
      throw error;
    }
  })();
  const open: OpenSavepoint = { stack, done };
  scope.openSavepoints.add(open);
  done.then(() => scope.openSavepoints.delete(open), () => scope.openSavepoints.delete(open));
  return done;
}

/**
 * Wrap a root database so that while a top-level transaction callback runs,
 * every use of the root resolves to that transaction (and a nested root
 * transaction becomes a savepoint). The live transaction handle is deliberately
 * kept private here — sinks only get isInTransaction(), never the tx object.
 */
export function scopeTransactions(root: Database): Database {
  const transaction = root.transaction.bind(root);
  const scopedTransaction = ((callback: (tx: DatabaseTransaction) => Promise<unknown>, config?: unknown) => {
    const scope = transactionScope.getStore();
    if (scope?.active && !scope.finishing) return joinAsSavepoint(scope, callback);
    if (scope?.active) savepointLeakReporter({ kind: "transaction_while_outer_finishing", stack: callSiteStack() });
    let ownScope: TransactionScope | null = null;
    const settled = transaction(async (tx) => {
      ownScope = newTransactionScope(tx);
      return await runInTransactionScope(ownScope, () => callback(tx));
    }, config as never);
    const runOutside = (works: Iterable<() => void>, label: string) => {
      for (const work of works) {
        transactionScope.exit(() => {
          try {
            work();
          } catch (error) {
            console.error(`[db] ${label} work failed:`, error);
          }
        });
      }
    };
    const runAfterSettled = () => runOutside((ownScope as TransactionScope | null)?.afterSettled ?? [], "afterAmbientTransaction");
    return settled.then(
      (value) => {
        runOutside((ownScope as TransactionScope | null)?.afterCommitted.values() ?? [], "afterAmbientCommit");
        runAfterSettled();
        return value;
      },
      (error: unknown) => { runAfterSettled(); throw error; },
    );
  }) as Database["transaction"];
  return new Proxy(root, {
    get(target, prop, receiver) {
      // One scope lookup for both questions: is the root off limits here, and is a transaction open.
      const scope = transactionScope.getStore();
      // Symbols are inspection (console.log of the handle) and `then` is a promise asking whether the handle is one: neither is a query.
      if (scope?.executorOnly && typeof prop === "string" && prop !== "then") {
        throw new ExecutorOnlyDatabaseAccessError(scope.executorOnly, `getDb().${prop}`);
      }
      if (prop === "transaction") return scopedTransaction;
      const source = (scope?.active ? scope.tx : null) ?? target;
      const value = Reflect.get(source, prop, source === target ? receiver : source);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

/**
 * Run `work` once the ambient transaction (if any) has committed or rolled
 * back, outside its context; with none open, run it now. For kicking a worker
 * that must see this transaction's rows on its own connection (an outbox
 * drain): started inside the transaction it would read the rows through the
 * transaction and open its own transaction as a savepoint that can outlive
 * the commit.
 *
 * It also runs after a rollback: a kicked drain then reads only committed rows
 * and finds none of this transaction's. It is a latency kick, not delivery:
 * work lost to a crash between COMMIT and the kick is left to the worker's
 * periodic sweep (mobile push outbox 15s, assistant doorbells 5s, app
 * notification deliveries 15s).
 */
export function afterAmbientTransaction(work: () => void): void {
  const scope = transactionScope.getStore();
  if (scope?.active) scope.afterSettled.push(work);
  else work();
}

/**
 * Run `work` once the ambient transaction (if any) has COMMITTED, outside its
 * context; never after a rollback; with none open, run it now. For a hint to
 * other processes that must describe committed state only (a socket
 * "changed" ping). Work is kept per `key`: a second call with the same key in
 * the same transaction is dropped, so one transaction announces a thing once.
 * Work that throws is logged, after a commit or now, never thrown.
 *
 * Limits: a savepoint that rolls back inside an outer transaction that then
 * commits does not take back what it registered (a spurious hint, never a
 * missed one); work lost to a crash between COMMIT and the call is lost.
 */
export function afterAmbientCommit(key: string, work: () => void): void {
  const scope = transactionScope.getStore();
  if (!scope?.active) {
    // The write has committed (autocommit): as after a commit, a failing
    // hint is logged, never thrown into the writer.
    try {
      work();
    } catch (error) {
      console.error("[db] afterAmbientCommit work failed:", error);
    }
    return;
  }
  if (!scope.afterCommitted.has(key)) scope.afterCommitted.set(key, work);
}

/**
 * READ-ONLY: whether the current async context is inside an ambient transaction.
 * Exposed for external sinks to self-report when invoked inside a transaction.
 * Deliberately does NOT expose the transaction handle — only a boolean.
 */
export function isInTransaction(): boolean {
  return activeTransaction() !== null;
}

function appendAuditEntry(source: string): void {
  const file = process.env.RAFT_TX_POOL_AUDIT_FILE;
  if (!file) return;
  const stack = (new Error().stack ?? "").split("\n").slice(3, 14).join("\n");
  appendFileSync(file, `${JSON.stringify({ source, stack })}\n`);
}

// "armed" provenance: an `armed source=X` record is written the first time a
// sink is actually exercised (called) in this run — or, for fetch, when its
// wrapper is installed. This is stronger than a single module-load header: it
// proves EVERY sink was genuinely reached, so a sink that was never called in a
// whole run cannot present its absence as "zero hits". A consumer must require
// all four armed records before trusting the results.
const armedSources = new Set<string>();

function markArmed(source: string): void {
  if (armedSources.has(source)) return;
  armedSources.add(source);
  const file = process.env.RAFT_TX_POOL_AUDIT_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ armed: source })}\n`);
  } catch {
    // Unwritable path (e.g. a per-test temp dir before it is created): best-effort.
  }
}

/**
 * Records a second-connection access (getRootDb / getSearchDb replica /
 * executeSearchSql replica) made inside a transaction.
 */
export function recordSecondConnectionInsideTransaction(source: string): void {
  if (!activeTransaction()) return;
  appendAuditEntry(source);
}

/**
 * Audit hook for external sinks: marks the sink armed (first call), then records
 * a hit if it ran while a transaction was open. Returns true if it recorded a
 * hit, so tests can assert without re-checking.
 */
export function recordExternalSinkInsideTransaction(source: string): boolean {
  markArmed(source);
  if (!activeTransaction()) return false;
  appendAuditEntry(source);
  return true;
}

let wrapInstalled = false;

/**
 * Wrap the global fetch so any fetch() issued while a transaction is open is
 * recorded to the audit file. Installed at process startup ONLY when
 * RAFT_TX_POOL_AUDIT_FILE is set, so production is untouched by default. The
 * wrapper delegates to the previous global fetch (preserving any prior wrapper).
 * Records `armed source=fetch` when it actually installs, so "fetch zero hits"
 * is distinguishable from "fetch wrapper never installed".
 */
export function installAuditedGlobalFetch(): void {
  if (wrapInstalled || !process.env.RAFT_TX_POOL_AUDIT_FILE) return;
  wrapInstalled = true;
  markArmed("fetch");
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    recordExternalSinkInsideTransaction("fetch");
    return original(input, init);
  }) as typeof globalThis.fetch;
}

// Install the audited global fetch at module load (not just in server.ts's
// bootstrap): db/index.ts imports this module in BOTH the test process and the
// production bootstrap, so the wrapper is live wherever the audit is armed.
if (process.env.RAFT_TX_POOL_AUDIT_FILE) {
  installAuditedGlobalFetch();
}

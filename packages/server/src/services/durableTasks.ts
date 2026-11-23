import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { currentDate, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { durableTasks } from "../db/schema";
import { errorClassOf, runWithTraceSpan } from "../tracing/semanticTrace";
import { durableTasksOpenGauge, durableTasksTotal } from "../metrics";

// RFC 073 durable tasks. A task row is written in the same transaction as the
// state change that needs follow-up work; the originating request runs it
// inline after commit; any replica recovers it once its lease has expired.
// Every write after a claim is fenced on (claimed_by, attempts). The task
// system does not serialize per entity: handlers are idempotent and guard their
// own entity writes with revisions.

type DurableTaskRow = typeof durableTasks.$inferSelect;

/** Closed set of task kinds, `<area>.<task>`; each kind registers exactly one definition. */
export type DurableTaskKind = string & { readonly __brand: "DurableTaskKind" };

export function durableTaskKind(value: string): DurableTaskKind {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value)) throw new Error(`DURABLE_TASK_KIND_INVALID:${value}`);
  return value as DurableTaskKind;
}

/** A failure that cannot succeed on retry: the task goes straight to needs_attention. */
export class DurableTaskPermanentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DurableTaskPermanentError";
  }
}

/**
 * Not a failure: the handler can't start yet (no free slot on this replica)
 * and hands the task back to run after `delayMs`. The attempt is given back
 * (max_attempts raised by one: attempts keeps counting claims and stays
 * >= 1), so waiting never spends the attempt budget.
 */
export class DurableTaskDeferral extends Error {
  constructor(readonly delayMs: number, readonly reason: string) {
    super(reason);
    this.name = "DurableTaskDeferral";
  }
}

export interface DurableTaskContext {
  taskId: number;
  attempt: number;
  /** Push the lease forward during long steps. Returns false when this attempt was fenced out: stop working. */
  extendLease(): Promise<boolean>;
}

export interface DurableTaskDefinition<P> {
  kind: DurableTaskKind;
  payloadVersion: number;
  /** Validate a stored payload; throw DurableTaskPermanentError for unknown versions or shapes. */
  decode(payload: unknown, payloadVersion: number): P;
  /** Must be idempotent and revision-guard its entity writes: a task can run twice. */
  handle(payload: P, context: DurableTaskContext): Promise<void>;
  /** Covers the longest gap between extendLease() calls. */
  leaseMs: number;
  maxAttempts: number;
  /** Delay before retrying after failed attempt N; defaults to durableTaskBackoffMs (graphile). */
  backoffMs?(attempt: number): number;
  /** Defaults to "every non-permanent error is retryable". */
  retryable?(error: unknown): boolean;
  /** Code-shaped cause recorded in last_error; defaults to the error class. */
  errorCode?(error: unknown): string;
}

/** What a producer needs to create a task; the handler is bound at registration. */
export type DurableTaskSpec<P> = Pick<DurableTaskDefinition<P>, "kind" | "payloadVersion" | "leaseMs" | "maxAttempts" | "decode" | "backoffMs">;

export class DurableTaskRegistry {
  private readonly definitions = new Map<string, DurableTaskDefinition<unknown>>();

  register<P>(definition: DurableTaskDefinition<P>): this {
    if (this.definitions.has(definition.kind)) throw new Error(`DURABLE_TASK_KIND_DUPLICATE:${definition.kind}`);
    this.definitions.set(definition.kind, definition as DurableTaskDefinition<unknown>);
    return this;
  }

  get(kind: string): DurableTaskDefinition<unknown> | undefined {
    return this.definitions.get(kind);
  }

  kinds(): string[] {
    return [...this.definitions.keys()];
  }
}

/** A claimed attempt: the fencing token for every write until it finishes. */
export interface DurableTaskClaim {
  task: DurableTaskRow;
  claimedBy: string;
  attempt: number;
}

/**
 * Write the task in the caller's transaction, already claimed by the caller for
 * its inline run (attempt 1), so recovery leaves it alone until that lease
 * expires. Run it with runDurableTask(claim) after the transaction commits.
 */
export async function createDurableTask<P>(
  executor: DatabaseExecutor,
  input: { definition: DurableTaskSpec<P>; payload: P; now?: Date },
): Promise<DurableTaskClaim> {
  const now = input.now ?? currentDate();
  const claimedBy = `inline:${randomUUID()}`;
  const [task] = await executor.insert(durableTasks)
    .values({
      kind: input.definition.kind,
      payloadVersion: input.definition.payloadVersion,
      payload: input.payload as unknown as Record<string, unknown>,
      state: "open",
      attempts: 1,
      maxAttempts: input.definition.maxAttempts,
      claimedBy,
      leaseUntil: new Date(now.getTime() + input.definition.leaseMs),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  durableTasksTotal.inc({ kind: input.definition.kind, outcome: "created" });
  return { task: task!, claimedBy, attempt: 1 };
}

function fenced(claim: DurableTaskClaim) {
  return and(
    eq(durableTasks.id, claim.task.id),
    eq(durableTasks.state, "open"),
    eq(durableTasks.claimedBy, claim.claimedBy),
    eq(durableTasks.attempts, claim.attempt),
  );
}

export async function extendDurableTaskLease(
  claim: DurableTaskClaim,
  leaseMs: number,
  now: Date = currentDate(),
): Promise<boolean> {
  const [task] = await getDb().update(durableTasks)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(fenced(claim))
    .returning({ id: durableTasks.id });
  return Boolean(task);
}

/** graphile-worker's backoff: exp(min(attempts, 10)) seconds (~6h at most). */
export function durableTaskBackoffMs(attempts: number): number {
  return Math.round(Math.exp(Math.min(Math.max(attempts, 1), 10)) * 1_000);
}

export type DurableTaskOutcome = "succeeded" | "retry" | "deferred" | "needs_attention" | "fenced";

export type DurableTaskResult =
  | { ok: true }
  | { ok: false; retryable: boolean; errorCode: string }
  /** DurableTaskDeferral: back after `delayMs`, the attempt not counted. */
  | { ok: false; deferredMs: number; errorCode: string };

export async function finishDurableTask(
  claim: DurableTaskClaim,
  result: DurableTaskResult,
  now: Date = currentDate(),
  backoffMs: (attempt: number) => number = durableTaskBackoffMs,
): Promise<DurableTaskOutcome> {
  let outcome: Exclude<DurableTaskOutcome, "fenced">;
  let set: PgUpdateSetSource<typeof durableTasks>;
  if (!result.ok && "deferredMs" in result) {
    // The claim counted an attempt; one more allowed keeps the budget for real tries.
    outcome = "deferred";
    set = {
      claimedBy: null,
      maxAttempts: sql`${durableTasks.maxAttempts} + 1`,
      leaseUntil: new Date(now.getTime() + result.deferredMs),
      lastError: result.errorCode,
    };
  } else if (result.ok) {
    outcome = "succeeded";
    set = { state: "succeeded", finishedAt: now, claimedBy: null, lastError: null };
  } else if (result.retryable && claim.attempt < claim.task.maxAttempts) {
    outcome = "retry";
    set = {
      claimedBy: null,
      leaseUntil: new Date(now.getTime() + backoffMs(claim.attempt)),
      lastError: result.errorCode,
    };
  } else {
    outcome = "needs_attention";
    set = { state: "needs_attention", claimedBy: null, lastError: result.errorCode };
  }
  const [updated] = await getDb().update(durableTasks)
    .set({ ...set, updatedAt: now })
    .where(fenced(claim))
    .returning({ id: durableTasks.id });
  return updated ? outcome : "fenced";
}

/** Run one claimed attempt through its definition and record the fenced outcome. */
export async function runDurableTask(
  claim: DurableTaskClaim,
  registry: DurableTaskRegistry,
  options: { tracer?: Tracer; clock?: () => Date } = {},
): Promise<DurableTaskOutcome> {
  const tracer = options.tracer ?? noopTracer;
  const clock = options.clock ?? currentDate;
  const definition = registry.get(claim.task.kind);
  const kind = claim.task.kind;
  const span = tracer.startSpan("server.durable_task.run", {
    surface: "server",
    kind: "internal",
    attrs: { task_kind: kind, attempt: claim.attempt },
  });
  let result: DurableTaskResult;
  try {
    if (!definition) throw new DurableTaskPermanentError("DURABLE_TASK_KIND_UNKNOWN");
    const payload = definition.decode(claim.task.payload, claim.task.payloadVersion);
    await runWithTraceSpan(span, () => definition.handle(payload, {
      taskId: claim.task.id,
      attempt: claim.attempt,
      extendLease: () => extendDurableTaskLease(claim, definition.leaseMs, clock()),
    }), tracer);
    result = { ok: true };
  } catch (error) {
    const permanent = error instanceof DurableTaskPermanentError;
    if (error instanceof DurableTaskDeferral) result = { ok: false, deferredMs: Math.max(0, error.delayMs), errorCode: error.reason };
    else result = {
      ok: false,
      retryable: !permanent && (definition?.retryable?.(error) ?? true),
      errorCode: permanent ? error.code : definition?.errorCode?.(error) ?? `ERROR_${errorClassOf(error)}`,
    };
  }
  const outcome = await finishDurableTask(claim, result, clock(), definition?.backoffMs ?? durableTaskBackoffMs);
  durableTasksTotal.inc({ kind, outcome });
  span.end(outcome === "succeeded" || outcome === "deferred" ? "ok" : "error", {
    attrs: { outcome, ...(result.ok ? {} : { error_code: result.errorCode }) },
  });
  return outcome;
}

/**
 * Recovery claim, one atomic statement: open tasks of known kinds whose lease
 * expired (a lost inline run, a crashed recovery attempt, or a retry that is
 * due). Tasks whose attempt budget is already spent go to needs_attention
 * instead of being claimed.
 */
export async function claimExpiredDurableTasks(input: {
  workerId: string;
  registry: DurableTaskRegistry;
  limit?: number;
  now?: Date;
}): Promise<DurableTaskClaim[]> {
  const now = input.now ?? currentDate();
  const kinds = input.registry.kinds();
  if (kinds.length === 0) return [];
  const db = getDb();
  await db.update(durableTasks)
    .set({ state: "needs_attention", claimedBy: null, lastError: sql`coalesce(${durableTasks.lastError}, 'LEASE_EXPIRED')`, updatedAt: now })
    .where(and(
      eq(durableTasks.state, "open"),
      lt(durableTasks.leaseUntil, now),
      sql`${durableTasks.attempts} >= ${durableTasks.maxAttempts}`,
    ));
  const claimToken = `${input.workerId}:${randomUUID()}`;
  // Callers claim one task and run it before claiming the next (default limit 1),
  // so a claimed task never waits behind others while its lease runs down.
  // Provisional lease from the longest registered kind; a run extends as needed.
  const leaseMs = Math.max(...kinds.map((kind) => input.registry.get(kind)!.leaseMs));
  const claimed = await db.execute<DurableTaskRow>(sql`
    UPDATE ${durableTasks}
    SET claimed_by = ${claimToken}, attempts = attempts + 1,
        lease_until = ${new Date(now.getTime() + leaseMs)}, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM ${durableTasks}
      WHERE state = 'open' AND lease_until < ${now} AND kind IN ${kinds} AND attempts < max_attempts
      ORDER BY lease_until
      LIMIT ${input.limit ?? 1}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const ids = (claimed.rows as Array<{ id: number | string }>).map((row) => Number(row.id));
  if (ids.length === 0) return [];
  const rows = await db.select().from(durableTasks).where(inArray(durableTasks.id, ids));
  return rows
    .filter((task) => task.claimedBy === claimToken)
    .map((task) => ({ task, claimedBy: claimToken, attempt: task.attempts }));
}

export const DURABLE_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Delete succeeded tasks past retention (batched). needs_attention rows are kept until handled. */
export async function pruneDurableTasks(now: Date = currentDate()): Promise<number> {
  const db = getDb();
  const expired = db.select({ id: durableTasks.id }).from(durableTasks)
    .where(and(eq(durableTasks.state, "succeeded"), lt(durableTasks.finishedAt, new Date(now.getTime() - DURABLE_TASK_RETENTION_MS))))
    .limit(1_000);
  const deleted = await db.delete(durableTasks).where(inArray(durableTasks.id, expired)).returning({ id: durableTasks.id });
  return deleted.length;
}

export async function observeDurableTasks(now: Date = currentDate()): Promise<void> {
  const rows = await getDb().select({
    kind: durableTasks.kind,
    active: sql<number>`count(*) FILTER (WHERE ${durableTasks.leaseUntil} >= ${now})::int`,
    overdue: sql<number>`count(*) FILTER (WHERE ${durableTasks.leaseUntil} < ${now})::int`,
  })
    .from(durableTasks)
    .where(eq(durableTasks.state, "open"))
    .groupBy(durableTasks.kind);
  durableTasksOpenGauge.reset();
  for (const row of rows) {
    durableTasksOpenGauge.set({ kind: row.kind, lease: "active" }, row.active);
    durableTasksOpenGauge.set({ kind: row.kind, lease: "overdue" }, row.overdue);
  }
}

/** Off until the first user ships (RFC 073 rollout step 1). */
export const DURABLE_TASKS_ENABLED_ENV = "DURABLE_TASKS_ENABLED";

export function durableTasksEnabled(): boolean {
  return process.env[DURABLE_TASKS_ENABLED_ENV] === "true";
}

/** Recovery loop: on startup and every ~60s (jittered), claim and run expired tasks. */
export function startDurableTaskRecovery(input: {
  registry: DurableTaskRegistry;
  tracer?: Tracer;
  workerId?: string;
  intervalMs?: number;
  enabled?: boolean;
}): { stop(): void } {
  if (!(input.enabled ?? durableTasksEnabled())) return { stop() {} };
  const workerId = input.workerId ?? `server:${hostname()}`;
  let running = false;
  let stopped = false;
  const recover = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // One claim per iteration: claim, run, repeat until nothing is due.
      while (!stopped) {
        const [claim] = await claimExpiredDurableTasks({ workerId, registry: input.registry, limit: 1 });
        if (!claim) break;
        await runDurableTask(claim, input.registry, { tracer: input.tracer });
      }
      await pruneDurableTasks();
      await observeDurableTasks();
    } catch (error) {
      console.error("[DurableTasks] recovery failed", error);
    } finally {
      running = false;
    }
  };
  const baseMs = input.intervalMs ?? 60_000;
  const timer = setClockInterval(() => void recover(), Math.round(baseMs * (0.8 + Math.random() * 0.4)));
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  void recover();
  return {
    stop() {
      stopped = true;
      clearInterval(timer as ReturnType<typeof setInterval>);
    },
  };
}

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/index";

/**
 * Holds for data written before attachment_object_holds existed, the check
 * that they match the implicit rule, and a read-only report of what a later
 * offline cleanup would collect. Nothing here deletes bytes or holds.
 *
 * Implicit rule (what the reservation cleanup has always checked): an object
 * is referenced while a linked (message_id set), non-revoked attachment row
 * or a pending upload reservation points at it. Each such row is a holder.
 *
 * Run the backfill only after every server instance runs the hold-writing
 * code: an older instance links and consumes without touching holds. During
 * the rollout an older instance can also end a reservation or revoke an
 * attachment without removing its hold; such a stale hold blocks the cleanup
 * of that object, so the backfill removes it and reconcile fails on it.
 *
 * reconcile and report are full scans: they run in one REPEATABLE READ, READ
 * ONLY transaction (one snapshot for every count) with a statement_timeout,
 * and can be pointed at a read replica.
 */

export const ATTACHMENT_OBJECT_HOLD_GRACE_DAYS = 30;
/** Default statement_timeout for each reconcile/report query. */
export const ATTACHMENT_OBJECT_HOLD_READ_STATEMENT_TIMEOUT_MS = 120_000;
const MAX_BATCH_SIZE = 5_000;
const MAX_SAMPLE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AttachmentObjectHoldBackfillBatchInput = Readonly<{
  /** Exclusive lower bound on attachment_objects.id; null starts at the beginning. */
  afterObjectId: string | null;
  limit: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Timestamp for objects found without a hold; defaults to the transaction time. */
  now?: Date;
}>;

export type AttachmentObjectHoldBackfillBatchResult = Readonly<{
  scannedObjects: number;
  activeObjects: number;
  attachmentHoldsInserted: number;
  reservationHoldsInserted: number;
  unheldSinceSet: number;
  unheldSinceCleared: number;
  /**
   * upload_reservation holds of active objects whose reservation is no longer
   * pending (consumed/canceled/expired by an instance on the previous release,
   * which does not remove the hold) or does not exist.
   */
  staleReservationHoldsRemoved: number;
  /**
   * attachment holds of active objects whose attachment is no longer linked
   * and non-revoked (revoked by an instance on the previous release) or no
   * longer exists (its message or channel was deleted).
   */
  staleAttachmentHoldsRemoved: number;
  /**
   * Holds removed from objects already gc_pending/deleted. Writers never add
   * one there; an instance still on the previous release can leave one when
   * it ends a reservation during the rollout. Removing it frees nothing.
   */
  holdsOnNonActiveRemoved: number;
  /** Last object id this batch covered; pass as afterObjectId to continue. */
  lastObjectId: string | null;
  done: boolean;
}>;

function uuidList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

/**
 * hold.holder_id as a uuid, so a lookup of the holder row compares uuid to
 * uuid and can use attachments_pkey / attachment_upload_reservations_pkey;
 * `projection.id::text = hold.holder_id` cannot (no index covers id::text).
 * The other direction (`hold.holder_id = projection.id::text`, holds PK on
 * the inner side) is already index-compatible and stays text.
 *
 * Only use it where the same scan filters hold.holder_type to 'attachment' or
 * 'upload_reservation': both holders' ids are uuids. (A guarded cast, CASE
 * WHEN holder_id ~ '<uuid>' ..., cost 8x on a full scan in the EXPLAIN run.)
 * A non-uuid there fails the query (22P02) instead of being misread.
 */
const HOLDER_UUID = sql.raw("hold.holder_id::uuid");

const LINKED = sql`projection.message_id IS NOT NULL AND projection.revoked_at IS NULL`;

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

function assertBatchInput(input: AttachmentObjectHoldBackfillBatchInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_BATCH_SIZE) {
    throw new Error(`Hold backfill batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  if (input.afterObjectId !== null && !UUID_RE.test(input.afterObjectId)) {
    throw new Error("Hold backfill cursor must be an attachment object id (uuid)");
  }
}

/**
 * One batch in its own transaction: lock the next `limit` objects by id
 * (FOR NO KEY UPDATE, which conflicts with the adders, the removers and the
 * cleanup), drop holds left on objects that are no longer active and stale
 * holds of active objects, add the missing holds, and align unheld_since.
 * Idempotent; resumable from any cursor.
 *
 * Dropping a stale hold cannot race a writer: adding and removing need the
 * object lock this batch holds, and the one write without it (a send handing
 * a pending reservation's hold to its attachment) only rewrites a hold this
 * batch does not consider stale: before it commits, the DELETEs see a
 * reservation hold whose reservation is still pending; after, an attachment
 * hold whose attachment is linked (both commit in the send's transaction).
 */
export async function backfillAttachmentObjectHoldsBatch(
  db: Database,
  input: AttachmentObjectHoldBackfillBatchInput,
): Promise<AttachmentObjectHoldBackfillBatchResult> {
  assertBatchInput(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${input.lockTimeoutMs ?? 2_000}ms`}, true)`);
    await tx.execute(sql`SELECT set_config('statement_timeout', ${`${input.statementTimeoutMs ?? 30_000}ms`}, true)`);
    const after = input.afterObjectId ? sql`WHERE id > ${input.afterObjectId}::uuid` : sql``;
    const locked = rowsOf<{ id: string; lifecycle_state: string }>(await tx.execute(sql`
      SELECT id::text AS id, lifecycle_state
        FROM attachment_objects
        ${after}
       ORDER BY id
       LIMIT ${input.limit}
         FOR NO KEY UPDATE
    `));
    const lastObjectId = locked.at(-1)?.id ?? input.afterObjectId;
    const done = locked.length < input.limit;
    const active = locked.filter((row) => row.lifecycle_state === "active").map((row) => row.id);
    const nonActive = locked.filter((row) => row.lifecycle_state !== "active").map((row) => row.id);
    const holdsOnNonActiveRemoved = nonActive.length === 0 ? 0 : (await tx.execute(sql`
      DELETE FROM attachment_object_holds WHERE object_id IN (${uuidList(nonActive)}) RETURNING 1
    `)).rows.length;
    if (active.length === 0) {
      return {
        scannedObjects: locked.length,
        activeObjects: 0,
        attachmentHoldsInserted: 0,
        reservationHoldsInserted: 0,
        unheldSinceSet: 0,
        unheldSinceCleared: 0,
        staleReservationHoldsRemoved: 0,
        staleAttachmentHoldsRemoved: 0,
        holdsOnNonActiveRemoved,
        lastObjectId,
        done,
      };
    }
    const ids = uuidList(active);
    const staleReservationHolds = await tx.execute(sql`
      DELETE FROM attachment_object_holds hold
       WHERE hold.object_id IN (${ids})
         AND hold.holder_type = 'upload_reservation'
         AND NOT EXISTS (
           SELECT 1 FROM attachment_upload_reservations reservation
            WHERE reservation.id = ${HOLDER_UUID}
              AND reservation.object_id = hold.object_id
              AND reservation.state = 'pending'
         )
      RETURNING 1
    `);
    const staleAttachmentHolds = await tx.execute(sql`
      DELETE FROM attachment_object_holds hold
       WHERE hold.object_id IN (${ids})
         AND hold.holder_type = 'attachment'
         AND NOT EXISTS (
           SELECT 1 FROM attachments projection
            WHERE projection.id = ${HOLDER_UUID}
              AND projection.object_id = hold.object_id
              AND ${LINKED}
         )
      RETURNING 1
    `);
    const attachmentHolds = await tx.execute(sql`
      INSERT INTO attachment_object_holds (holder_type, holder_id, object_id)
      SELECT 'attachment', projection.id::text, projection.object_id
        FROM attachments projection
       WHERE projection.object_id IN (${ids})
         AND projection.message_id IS NOT NULL
         AND projection.revoked_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING 1
    `);
    const reservationHolds = await tx.execute(sql`
      INSERT INTO attachment_object_holds (holder_type, holder_id, object_id)
      SELECT 'upload_reservation', reservation.id::text, reservation.object_id
        FROM attachment_upload_reservations reservation
       WHERE reservation.object_id IN (${ids})
         AND reservation.state = 'pending'
      ON CONFLICT DO NOTHING
      RETURNING 1
    `);
    const cleared = await tx.execute(sql`
      UPDATE attachment_objects object SET unheld_since = NULL
       WHERE object.id IN (${ids})
         AND object.unheld_since IS NOT NULL
         AND EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id)
      RETURNING 1
    `);
    const stamped = await tx.execute(sql`
      UPDATE attachment_objects object
         SET unheld_since = ${input.now ? sql`${input.now.toISOString()}::timestamptz` : sql`CURRENT_TIMESTAMP`}
       WHERE object.id IN (${ids})
         AND object.unheld_since IS NULL
         AND NOT EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id)
      RETURNING 1
    `);
    return {
      scannedObjects: locked.length,
      activeObjects: active.length,
      attachmentHoldsInserted: attachmentHolds.rows.length,
      reservationHoldsInserted: reservationHolds.rows.length,
      unheldSinceSet: stamped.rows.length,
      unheldSinceCleared: cleared.rows.length,
      staleReservationHoldsRemoved: staleReservationHolds.rows.length,
      staleAttachmentHoldsRemoved: staleAttachmentHolds.rows.length,
      holdsOnNonActiveRemoved,
      lastObjectId,
      done,
    };
  });
}

const RETRYABLE_CODES = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "57014", // query_canceled (statement_timeout)
]);

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  const seen = new Set<object>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : null;
  }
  return null;
}

export type AttachmentObjectHoldBackfillRunInput = Readonly<{
  db: Database;
  cursor: string | null;
  batchSize: number;
  maxBatches?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxAttemptsPerBatch?: number;
  sleep?: (ms: number) => Promise<void>;
  sleepMs?: number;
  /** Return "stop" to end cleanly before the next batch (pause file, deadline). */
  beforeBatch?: () => Promise<"continue" | "stop">;
  /** Called after each committed batch, e.g. to persist the cursor. */
  onBatch?: (result: AttachmentObjectHoldBackfillBatchResult) => Promise<void>;
  log?: (record: Record<string, unknown>) => void;
}>;

export type AttachmentObjectHoldBackfillRunResult = Readonly<{
  batches: number;
  cursor: string | null;
  done: boolean;
  totals: Readonly<{
    scannedObjects: number;
    attachmentHoldsInserted: number;
    reservationHoldsInserted: number;
    unheldSinceSet: number;
    unheldSinceCleared: number;
    staleReservationHoldsRemoved: number;
    staleAttachmentHoldsRemoved: number;
    holdsOnNonActiveRemoved: number;
  }>;
}>;

export async function runAttachmentObjectHoldBackfill(
  input: AttachmentObjectHoldBackfillRunInput,
): Promise<AttachmentObjectHoldBackfillRunResult> {
  const sleep = input.sleep ?? (async () => undefined);
  const maxAttempts = input.maxAttemptsPerBatch ?? 5;
  const totals = {
    scannedObjects: 0,
    attachmentHoldsInserted: 0,
    reservationHoldsInserted: 0,
    unheldSinceSet: 0,
    unheldSinceCleared: 0,
    staleReservationHoldsRemoved: 0,
    staleAttachmentHoldsRemoved: 0,
    holdsOnNonActiveRemoved: 0,
  };
  let cursor = input.cursor;
  let batches = 0;
  for (;;) {
    if (input.maxBatches !== undefined && batches >= input.maxBatches) {
      return { batches, cursor, done: false, totals };
    }
    if ((await input.beforeBatch?.()) === "stop") return { batches, cursor, done: false, totals };
    let result: AttachmentObjectHoldBackfillBatchResult | null = null;
    for (let attempt = 1; !result; attempt += 1) {
      try {
        result = await backfillAttachmentObjectHoldsBatch(input.db, {
          afterObjectId: cursor,
          limit: input.batchSize,
          lockTimeoutMs: input.lockTimeoutMs,
          statementTimeoutMs: input.statementTimeoutMs,
        });
      } catch (error) {
        const code = postgresErrorCode(error);
        if (!code || !RETRYABLE_CODES.has(code) || attempt >= maxAttempts) {
          input.log?.({ event: "attachment_object_holds.backfill.failed", cursor, attempt, code });
          throw error;
        }
        input.log?.({ event: "attachment_object_holds.backfill.retry", cursor, attempt, code });
        await sleep((input.sleepMs ?? 100) * 2 ** attempt);
      }
    }
    batches += 1;
    cursor = result.lastObjectId;
    totals.scannedObjects += result.scannedObjects;
    totals.attachmentHoldsInserted += result.attachmentHoldsInserted;
    totals.reservationHoldsInserted += result.reservationHoldsInserted;
    totals.unheldSinceSet += result.unheldSinceSet;
    totals.unheldSinceCleared += result.unheldSinceCleared;
    totals.staleReservationHoldsRemoved += result.staleReservationHoldsRemoved;
    totals.staleAttachmentHoldsRemoved += result.staleAttachmentHoldsRemoved;
    totals.holdsOnNonActiveRemoved += result.holdsOnNonActiveRemoved;
    input.log?.({ event: "attachment_object_holds.backfill.batch", ...result });
    await input.onBatch?.(result);
    if (result.done) return { batches, cursor, done: true, totals };
    await sleep(input.sleepMs ?? 100);
  }
}

type Sample = Readonly<{ count: number; sample: Array<Record<string, string>> }>;
type ReadExecutor = Pick<Database, "execute">;

export type AttachmentObjectHoldReadOptions = Readonly<{
  /** statement_timeout for each query; defaults to ATTACHMENT_OBJECT_HOLD_READ_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
}>;

/**
 * Run `read` in one REPEATABLE READ, READ ONLY transaction (every count comes
 * from one snapshot; a write fails with 25006) with a statement_timeout per
 * query. Works on a hot standby.
 */
export async function withAttachmentObjectHoldReadSnapshot<T>(
  db: Database,
  options: AttachmentObjectHoldReadOptions,
  read: (executor: ReadExecutor) => Promise<T>,
): Promise<T> {
  const statementTimeoutMs = options.statementTimeoutMs ?? ATTACHMENT_OBJECT_HOLD_READ_STATEMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
    throw new Error("statementTimeoutMs must be a positive integer");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`);
    return read(tx);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function countAndSample(db: ReadExecutor, from: SQL, select: SQL, sampleSize: number): Promise<Sample> {
  const [counted] = rowsOf<{ count: number | string }>(await db.execute(sql`SELECT count(*) AS count ${from}`));
  const sample = sampleSize > 0
    ? rowsOf<Record<string, string>>(await db.execute(sql`SELECT ${select} ${from} LIMIT ${sampleSize}`))
    : [];
  return { count: Number(counted?.count ?? 0), sample };
}

export type AttachmentObjectHoldReconciliation = Readonly<{
  objects: Readonly<Record<"active" | "gc_pending" | "deleted", number>>;
  holds: Readonly<Record<"attachment" | "upload_reservation", number>>;
  /** Linked, non-revoked attachment of an active object with no matching hold. Must be 0. */
  missingAttachmentHolds: Sample;
  /** Pending reservation of an active object with no matching hold. Must be 0. */
  missingReservationHolds: Sample;
  /** Active objects a holder row references that have no hold at all. Must be 0. */
  referencedObjectsWithoutHold: Sample;
  /** A hold on an object that is not active. Must be 0. */
  holdsOnNonActiveObjects: Sample;
  /**
   * A hold whose holder row no longer qualifies. Must be 0: it never frees
   * bytes early, but it blocks the reservation cleanup of its object forever.
   * The backfill removes it.
   */
  staleHolds: Sample;
  /** Linked/pending holder rows pointing at a non-active object (predates holds; cannot be held). */
  referencedNonActiveObjects: Sample;
  /** Active, held, but unheld_since set. */
  heldWithUnheldSince: number;
  /** Active, no hold, unheld_since NULL: the backfill has not reached it. */
  unheldUntracked: number;
  ok: boolean;
}>;

/**
 * Read-only (see withAttachmentObjectHoldReadSnapshot). Safe to run before and
 * after the backfill, on the primary or a read replica.
 */
export async function reconcileAttachmentObjectHolds(
  database: Database,
  options: { sampleSize?: number } & AttachmentObjectHoldReadOptions = {},
): Promise<AttachmentObjectHoldReconciliation> {
  return withAttachmentObjectHoldReadSnapshot(database, options, (db) => reconcileInSnapshot(db, options));
}

async function reconcileInSnapshot(
  db: ReadExecutor,
  options: { sampleSize?: number },
): Promise<AttachmentObjectHoldReconciliation> {
  const sampleSize = Math.min(Math.max(options.sampleSize ?? 10, 0), MAX_SAMPLE);
  const objectCounts = rowsOf<{ lifecycle_state: string; count: number | string }>(await db.execute(sql`
    SELECT lifecycle_state, count(*) AS count FROM attachment_objects GROUP BY lifecycle_state
  `));
  const holdCounts = rowsOf<{ holder_type: string; count: number | string }>(await db.execute(sql`
    SELECT holder_type, count(*) AS count FROM attachment_object_holds GROUP BY holder_type
  `));
  const objectCount = (state: string) => Number(objectCounts.find((row) => row.lifecycle_state === state)?.count ?? 0);
  const holdCount = (type: string) => Number(holdCounts.find((row) => row.holder_type === type)?.count ?? 0);

  const missingAttachmentHolds = await countAndSample(db, sql`
    FROM attachments projection
    JOIN attachment_objects object ON object.id = projection.object_id AND object.lifecycle_state = 'active'
   WHERE ${LINKED}
     AND NOT EXISTS (
       SELECT 1 FROM attachment_object_holds hold
        WHERE hold.holder_type = 'attachment'
          AND hold.holder_id = projection.id::text
          AND hold.object_id = projection.object_id
     )
  `, sql`projection.id::text AS "attachmentId", projection.object_id::text AS "objectId"`, sampleSize);
  const missingReservationHolds = await countAndSample(db, sql`
    FROM attachment_upload_reservations reservation
    JOIN attachment_objects object ON object.id = reservation.object_id AND object.lifecycle_state = 'active'
   WHERE reservation.state = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM attachment_object_holds hold
        WHERE hold.holder_type = 'upload_reservation'
          AND hold.holder_id = reservation.id::text
          AND hold.object_id = reservation.object_id
     )
  `, sql`reservation.id::text AS "reservationId", reservation.object_id::text AS "objectId"`, sampleSize);
  const referencedObjectsWithoutHold = await countAndSample(db, sql`
    FROM attachment_objects object
   WHERE object.lifecycle_state = 'active'
     AND NOT EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id)
     AND (
       EXISTS (SELECT 1 FROM attachments projection WHERE projection.object_id = object.id AND ${LINKED})
       OR EXISTS (
         SELECT 1 FROM attachment_upload_reservations reservation
          WHERE reservation.object_id = object.id AND reservation.state = 'pending'
       )
     )
  `, sql`object.id::text AS "objectId"`, sampleSize);
  const holdsOnNonActiveObjects = await countAndSample(db, sql`
    FROM attachment_object_holds hold
    JOIN attachment_objects object ON object.id = hold.object_id
   WHERE object.lifecycle_state <> 'active'
  `, sql`hold.holder_type AS "holderType", hold.holder_id AS "holderId", hold.object_id::text AS "objectId", object.lifecycle_state AS "lifecycleState"`, sampleSize);
  // One branch per holder type (not an OR of two NOT EXISTS), so each is an
  // anti-join instead of a per-row subplan.
  const staleHolds = await countAndSample(db, sql`
    FROM (
      SELECT hold.holder_type, hold.holder_id, hold.object_id
        FROM attachment_object_holds hold
       WHERE hold.holder_type = 'attachment'
         AND NOT EXISTS (
           SELECT 1 FROM attachments projection
            WHERE projection.id = ${HOLDER_UUID}
              AND projection.object_id = hold.object_id
              AND ${LINKED})
      UNION ALL
      SELECT hold.holder_type, hold.holder_id, hold.object_id
        FROM attachment_object_holds hold
       WHERE hold.holder_type = 'upload_reservation'
         AND NOT EXISTS (
           SELECT 1 FROM attachment_upload_reservations reservation
            WHERE reservation.id = ${HOLDER_UUID}
              AND reservation.object_id = hold.object_id
              AND reservation.state = 'pending')
    ) hold
  `, sql`hold.holder_type AS "holderType", hold.holder_id AS "holderId", hold.object_id::text AS "objectId"`, sampleSize);
  const referencedNonActiveObjects = await countAndSample(db, sql`
    FROM attachment_objects object
   WHERE object.lifecycle_state <> 'active'
     AND (
       EXISTS (SELECT 1 FROM attachments projection WHERE projection.object_id = object.id AND ${LINKED})
       OR EXISTS (
         SELECT 1 FROM attachment_upload_reservations reservation
          WHERE reservation.object_id = object.id AND reservation.state = 'pending'
       )
     )
  `, sql`object.id::text AS "objectId", object.lifecycle_state AS "lifecycleState"`, sampleSize);
  const [timestamps] = rowsOf<{ held_with_unheld_since: number | string; unheld_untracked: number | string }>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE held AND object.unheld_since IS NOT NULL) AS held_with_unheld_since,
        count(*) FILTER (WHERE NOT held AND object.unheld_since IS NULL) AS unheld_untracked
      FROM attachment_objects object
      CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id) AS held
      ) held_check
      WHERE object.lifecycle_state = 'active'
    `),
  );
  return {
    objects: { active: objectCount("active"), gc_pending: objectCount("gc_pending"), deleted: objectCount("deleted") },
    holds: { attachment: holdCount("attachment"), upload_reservation: holdCount("upload_reservation") },
    missingAttachmentHolds,
    missingReservationHolds,
    referencedObjectsWithoutHold,
    holdsOnNonActiveObjects,
    staleHolds,
    referencedNonActiveObjects,
    heldWithUnheldSince: Number(timestamps?.held_with_unheld_since ?? 0),
    unheldUntracked: Number(timestamps?.unheld_untracked ?? 0),
    ok: missingAttachmentHolds.count === 0
      && missingReservationHolds.count === 0
      && referencedObjectsWithoutHold.count === 0
      && holdsOnNonActiveObjects.count === 0
      && staleHolds.count === 0,
  };
}

export type AttachmentObjectCollectionReport = Readonly<{
  mode: "record_only";
  graceDays: number;
  cutoff: string;
  /** Active, no hold, unheld for at least the grace period. */
  candidates: number;
  candidateBytes: number;
  oldestUnheldSince: string | null;
  newestUnheldSince: string | null;
  sampleObjectIds: string[];
  /** Candidates a holder row still references. Must be 0; non-zero means do not collect. */
  stillReferenced: Sample;
  /** Active, no hold, unheld_since NULL: not yet eligible (the backfill has not reached them). */
  unheldUntracked: number;
  /** Active, no hold, inside the grace period. */
  unheldWithinGrace: number;
}>;

/**
 * What a later offline cleanup WOULD collect. Read-only (see
 * withAttachmentObjectHoldReadSnapshot): deletes, marks and moves nothing.
 */
export async function reportCollectableAttachmentObjects(
  database: Database,
  options: { now?: Date; graceDays?: number; sampleSize?: number } & AttachmentObjectHoldReadOptions = {},
): Promise<AttachmentObjectCollectionReport> {
  const graceDays = options.graceDays ?? ATTACHMENT_OBJECT_HOLD_GRACE_DAYS;
  if (!Number.isFinite(graceDays) || graceDays < 0) throw new Error("graceDays must be a non-negative number");
  return withAttachmentObjectHoldReadSnapshot(database, options, (db) => reportInSnapshot(db, { ...options, graceDays }));
}

async function reportInSnapshot(
  db: ReadExecutor,
  options: { now?: Date; graceDays: number; sampleSize?: number },
): Promise<AttachmentObjectCollectionReport> {
  const graceDays = options.graceDays;
  const sampleSize = Math.min(Math.max(options.sampleSize ?? 20, 0), MAX_SAMPLE);
  const nowSql = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`CURRENT_TIMESTAMP`;
  const cutoffSql = sql`(${nowSql} - make_interval(secs => ${graceDays * 86_400}))`;
  const unheldActive = sql`
    FROM attachment_objects object
   WHERE object.lifecycle_state = 'active'
     AND NOT EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id)
  `;
  const [summary] = rowsOf<{
    cutoff: Date | string;
    candidates: number | string;
    candidate_bytes: number | string | null;
    oldest: Date | string | null;
    newest: Date | string | null;
    untracked: number | string;
    within_grace: number | string;
  }>(await db.execute(sql`
    SELECT
      ${cutoffSql} AS cutoff,
      count(*) FILTER (WHERE object.unheld_since <= ${cutoffSql}) AS candidates,
      coalesce(sum(object.size_bytes) FILTER (WHERE object.unheld_since <= ${cutoffSql}), 0) AS candidate_bytes,
      min(object.unheld_since) FILTER (WHERE object.unheld_since <= ${cutoffSql}) AS oldest,
      max(object.unheld_since) FILTER (WHERE object.unheld_since <= ${cutoffSql}) AS newest,
      count(*) FILTER (WHERE object.unheld_since IS NULL) AS untracked,
      count(*) FILTER (WHERE object.unheld_since > ${cutoffSql}) AS within_grace
    ${unheldActive}
  `));
  const candidatePredicate = sql`${unheldActive} AND object.unheld_since <= ${cutoffSql}`;
  const sampleObjectIds = sampleSize > 0
    ? rowsOf<{ id: string }>(await db.execute(sql`
        SELECT object.id::text AS id ${candidatePredicate} ORDER BY object.unheld_since, object.id LIMIT ${sampleSize}
      `)).map((row) => row.id)
    : [];
  const stillReferenced = await countAndSample(db, sql`
    ${candidatePredicate}
     AND (
       EXISTS (SELECT 1 FROM attachments projection WHERE projection.object_id = object.id AND ${LINKED})
       OR EXISTS (
         SELECT 1 FROM attachment_upload_reservations reservation
          WHERE reservation.object_id = object.id AND reservation.state = 'pending'
       )
     )
  `, sql`object.id::text AS "objectId"`, sampleSize);
  const iso = (value: Date | string | null | undefined) =>
    value === null || value === undefined ? null : new Date(value).toISOString();
  return {
    mode: "record_only",
    graceDays,
    cutoff: iso(summary?.cutoff) ?? "",
    candidates: Number(summary?.candidates ?? 0),
    candidateBytes: Number(summary?.candidate_bytes ?? 0),
    oldestUnheldSince: iso(summary?.oldest),
    newestUnheldSince: iso(summary?.newest),
    sampleObjectIds,
    stillReferenced,
    unheldUntracked: Number(summary?.untracked ?? 0),
    unheldWithinGrace: Number(summary?.within_grace ?? 0),
  };
}

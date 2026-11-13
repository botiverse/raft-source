import { sql, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import type { AttachmentObjectHolderType } from "../db/schema";

/**
 * Platform holds on stored bytes (attachment_objects).
 *
 * A hold is "this holder keeps these bytes alive". The platform may only
 * collect an object that has no hold; holders never ask each other. Every
 * call runs inside the holder's own transaction so the hold commits or rolls
 * back with the holder row it describes.
 *
 * Race rule with collection (any path that moves an object out of `active`):
 *   - add: `SELECT ... FOR NO KEY UPDATE` on the object and require `active`;
 *     else fail with AttachmentObjectHoldError (the caller re-uploads).
 *   - collection: `SELECT ... FOR UPDATE` on the object, re-check that it has
 *     no hold, then mark it `gc_pending`.
 * The two locks conflict, so either the hold commits first and the collector
 * sees it, or the object leaves `active` first and the add fails.
 *
 * A send hands the reservation's hold to the linked attachment with one
 * UPDATE (transferAttachmentObjectHoldsWithExecutor).
 *
 * `unheld_since` is set when the last hold goes and cleared when a hold is
 * added. Adding and removing both take FOR NO KEY UPDATE up front, so the
 * "no hold left" check and the timestamp are serialized, and neither ever
 * upgrades a weaker row lock to write unheld_since (two adders that each held
 * FOR SHARE and then both UPDATEd the row would deadlock).
 */

export type AttachmentObjectHold = Readonly<{
  holderType: AttachmentObjectHolderType;
  holderId: string;
  objectId: string;
}>;

export class AttachmentObjectHoldError extends Error {
  readonly code = "object_not_active" as const;

  constructor(readonly objectId: string, readonly lifecycleState: string | null) {
    super(lifecycleState
      ? `Attachment object ${objectId} is ${lifecycleState} and cannot take a new hold. Re-upload the file.`
      : `Attachment object ${objectId} does not exist and cannot take a new hold. Re-upload the file.`);
    this.name = "AttachmentObjectHoldError";
  }
}

function holdKey(hold: AttachmentObjectHold): string {
  return `${hold.holderType}\u0000${hold.holderId}\u0000${hold.objectId}`;
}

function uniqueHolds(holds: readonly AttachmentObjectHold[]): AttachmentObjectHold[] {
  const byKey = new Map<string, AttachmentObjectHold>();
  for (const hold of holds) byKey.set(holdKey(hold), hold);
  return [...byKey.values()];
}

function sortedObjectIds(holds: readonly AttachmentObjectHold[]): string[] {
  return [...new Set(holds.map((hold) => hold.objectId))].sort();
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

function holdTuples(holds: readonly AttachmentObjectHold[]): SQL {
  return sql.join(
    holds.map((hold) => sql`(${hold.holderType}, ${hold.holderId}, ${hold.objectId}::uuid)`),
    sql`, `,
  );
}

function timestampOrNow(now: Date | undefined): SQL {
  return now ? sql`${now.toISOString()}::timestamptz` : sql`CURRENT_TIMESTAMP`;
}

/**
 * Add holds (idempotent). Fails, adding nothing, when any object is missing
 * or not `active`. Locks the objects FOR NO KEY UPDATE (in id order) before
 * reading them: some callers (a send whose attachment has no pending
 * reservation) hold no lock on the object yet, and the add may write
 * unheld_since below. A caller that already holds FOR UPDATE keeps it.
 */
export async function addAttachmentObjectHoldsWithExecutor(
  executor: DatabaseExecutor,
  holds: readonly AttachmentObjectHold[],
): Promise<void> {
  const unique = uniqueHolds(holds);
  if (unique.length === 0) return;
  const objectIds = sortedObjectIds(unique);
  const locked = await executor.execute(sql`
    SELECT id::text AS id, lifecycle_state, unheld_since IS NOT NULL AS unheld
      FROM attachment_objects
     WHERE id IN (${uuidList(objectIds)})
     ORDER BY id
       FOR NO KEY UPDATE
  `);
  const rows = new Map(
    (locked.rows as Array<{ id: string; lifecycle_state: string; unheld: boolean }>)
      .map((row) => [row.id, row]),
  );
  for (const objectId of objectIds) {
    const row = rows.get(objectId);
    if (!row || row.lifecycle_state !== "active") {
      throw new AttachmentObjectHoldError(objectId, row?.lifecycle_state ?? null);
    }
  }
  await executor.execute(sql`
    INSERT INTO attachment_object_holds (holder_type, holder_id, object_id)
    VALUES ${holdTuples(unique)}
    ON CONFLICT DO NOTHING
  `);
  // Rare: only an object with no hold has unheld_since set. The row is
  // already locked FOR NO KEY UPDATE above, so this is not a lock upgrade.
  const unheld = objectIds.filter((objectId) => rows.get(objectId)?.unheld);
  if (unheld.length > 0) {
    await executor.execute(sql`
      UPDATE attachment_objects SET unheld_since = NULL
       WHERE id IN (${uuidList(unheld)}) AND unheld_since IS NOT NULL
    `);
  }
}

export async function addAttachmentObjectHoldWithExecutor(
  executor: DatabaseExecutor,
  hold: AttachmentObjectHold,
): Promise<void> {
  await addAttachmentObjectHoldsWithExecutor(executor, [hold]);
}

/**
 * Remove holds (idempotent; a hold that does not exist is ignored). An object
 * whose last hold this removes gets `unheld_since`. Returns how many hold rows
 * were deleted.
 */
export async function removeAttachmentObjectHoldsWithExecutor(
  executor: DatabaseExecutor,
  holds: readonly AttachmentObjectHold[],
  now?: Date,
): Promise<number> {
  const unique = uniqueHolds(holds);
  if (unique.length === 0) return 0;
  const objectIds = sortedObjectIds(unique);
  await executor.execute(sql`
    SELECT id FROM attachment_objects
     WHERE id IN (${uuidList(objectIds)})
     ORDER BY id
       FOR NO KEY UPDATE
  `);
  const deleted = await executor.execute(sql`
    DELETE FROM attachment_object_holds
     WHERE (holder_type, holder_id, object_id) IN (${holdTuples(unique)})
    RETURNING object_id::text AS object_id
  `);
  const deletedRows = deleted.rows as Array<{ object_id: string }>;
  const touched = [...new Set(deletedRows.map((row) => row.object_id))].sort();
  if (touched.length > 0) {
    await executor.execute(sql`
      UPDATE attachment_objects object SET unheld_since = ${timestampOrNow(now)}
       WHERE object.id IN (${uuidList(touched)})
         AND object.unheld_since IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = object.id
         )
    `);
  }
  return deletedRows.length;
}

export async function removeAttachmentObjectHoldWithExecutor(
  executor: DatabaseExecutor,
  hold: AttachmentObjectHold,
  now?: Date,
): Promise<number> {
  return removeAttachmentObjectHoldsWithExecutor(executor, [hold], now);
}

export type AttachmentObjectHoldTransfer = Readonly<{
  from: AttachmentObjectHold;
  to: AttachmentObjectHold;
}>;

/**
 * Hand an existing hold to a new holder of the same object, e.g. a pending
 * reservation to the attachment a send links (one UPDATE on the send path).
 *
 * No object lock is needed: while the `from` hold exists the object cannot be
 * collected (collection re-checks holds under FOR UPDATE), so it is active,
 * and the hold count does not change, so unheld_since does not either. A
 * transfer whose `from` hold is missing (data written before holds) or whose
 * `to` hold already exists falls back to add + remove.
 */
export async function transferAttachmentObjectHoldsWithExecutor(
  executor: DatabaseExecutor,
  transfers: readonly AttachmentObjectHoldTransfer[],
  now?: Date,
): Promise<void> {
  if (transfers.length === 0) return;
  for (const transfer of transfers) {
    if (transfer.from.objectId !== transfer.to.objectId) {
      throw new Error("A hold can only be transferred between holders of the same object.");
    }
  }
  const values = sql.join(transfers.map(({ from, to }) => sql`(
    ${from.holderType}::text, ${from.holderId}::text, ${to.holderType}::text, ${to.holderId}::text, ${from.objectId}::uuid
  )`), sql`, `);
  const moved = await executor.execute(sql`
    UPDATE attachment_object_holds hold
       SET holder_type = transfer.to_type, holder_id = transfer.to_id, created_at = CURRENT_TIMESTAMP
      FROM (VALUES ${values}) AS transfer(from_type, from_id, to_type, to_id, object_id)
     WHERE hold.holder_type = transfer.from_type
       AND hold.holder_id = transfer.from_id
       AND hold.object_id = transfer.object_id
       AND NOT EXISTS (
         SELECT 1 FROM attachment_object_holds existing
          WHERE existing.holder_type = transfer.to_type
            AND existing.holder_id = transfer.to_id
            AND existing.object_id = transfer.object_id
       )
    RETURNING hold.holder_type, hold.holder_id, hold.object_id::text AS object_id
  `);
  const movedKeys = new Set((moved.rows as Array<{ holder_type: AttachmentObjectHolderType; holder_id: string; object_id: string }>)
    .map((row) => holdKey({ holderType: row.holder_type, holderId: row.holder_id, objectId: row.object_id })));
  const fallback = transfers.filter((transfer) => !movedKeys.has(holdKey(transfer.to)));
  if (fallback.length === 0) return;
  await addAttachmentObjectHoldsWithExecutor(executor, fallback.map((transfer) => transfer.to));
  await removeAttachmentObjectHoldsWithExecutor(executor, fallback.map((transfer) => transfer.from), now);
}

/** SQL predicate: the object (by id expression) has at least one hold. */
export function attachmentObjectHasHoldSql(objectId: SQL | string): SQL {
  const id = typeof objectId === "string" ? sql`${objectId}::uuid` : objectId;
  return sql`EXISTS (SELECT 1 FROM attachment_object_holds hold WHERE hold.object_id = ${id})`;
}

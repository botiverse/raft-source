/**
 * Retention of `object_events` (technical design §7): events are kept 90
 * days, then deleted by the hourly maintenance (server.ts,
 * `prune_object_events`). Core only; apps write through objectEvents.ts.
 * People's Activity rows (`object_inbox_states`) go with their newest event:
 * a row whose newest event is past retention is deleted in the same run, so
 * an object nothing has happened to for 90 days leaves Activity. The run is
 * bounded (batches), so rows past retention can outlast it: Activity's list
 * and badge leave out every row past the same cutoff (objectActivity.ts
 * inWindow), so they agree whatever the prune has reached.
 */
import { lt, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { objectEvents, objectInboxStates } from "../db/schema";

export const OBJECT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 1000;
const PRUNE_MAX_BATCHES = 20;

/** Hourly maintenance: events older than 90 days, in bounded batches. */
export async function pruneObjectEvents(opts: { now?: Date; batchSize?: number; maxBatches?: number; executor?: DatabaseExecutor } = {}): Promise<number> {
  const db = opts.executor ?? getDb();
  const cutoff = new Date((opts.now ?? currentDate()).getTime() - OBJECT_EVENT_RETENTION_MS);
  const batchSize = opts.batchSize ?? PRUNE_BATCH_SIZE;
  let total = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? PRUNE_MAX_BATCHES); batch += 1) {
    const old = db.select({ id: objectEvents.id }).from(objectEvents).where(lt(objectEvents.createdAt, cutoff)).orderBy(objectEvents.createdAt).limit(batchSize);
    const deleted = await db.delete(objectEvents).where(sql`${objectEvents.id} IN (${old})`).returning({ id: objectEvents.id });
    total += deleted.length;
    if (deleted.length < batchSize) break;
  }
  for (let batch = 0; batch < (opts.maxBatches ?? PRUNE_MAX_BATCHES); batch += 1) {
    const old = db.select({ userId: objectInboxStates.userId, objectKind: objectInboxStates.objectKind, objectId: objectInboxStates.objectId })
      .from(objectInboxStates).where(lt(objectInboxStates.lastEventAt, cutoff)).orderBy(objectInboxStates.lastEventAt).limit(batchSize);
    const deleted = await db.delete(objectInboxStates)
      .where(sql`(${objectInboxStates.userId}, ${objectInboxStates.objectKind}, ${objectInboxStates.objectId}) IN (${old})`)
      .returning({ userId: objectInboxStates.userId });
    if (deleted.length < batchSize) break;
  }
  return total;
}

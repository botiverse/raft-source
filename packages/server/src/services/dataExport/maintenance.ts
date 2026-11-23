// Hourly data export maintenance (server.ts runMaintenance; #triage:#512,
// docs/development/data-export.md), whatever the flag says (it only cleans up):
//   1. expire: a ready archive past its 7 days becomes `expired` (the row
//      stays, for the requester's list and as the export's record);
//   2. stuck: a queued or running job whose task is no longer open (its
//      attempts spent: needs_attention), or a running one that has not written
//      for a day, fails `stuck`, its recorded upload aborted, the requester
//      told. A queued job whose task is open is only waiting for a slot
//      (deferrals spend no attempt): never stuck;
//   3. objects: every expired, failed or deleted job's objects still stored
//      (a delete that failed earlier) are deleted, then `volumes` cleared;
//   4. orphan uploads (Tenny 542c7777): every unfinished multipart upload
//      under data-exports/ older than a day that no running job records is
//      aborted: a run that died between creating an upload and recording it
//      leaves one no row names.
// Bounded per run; the rest waits for the next hour.
import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { dataExports, durableTasks } from "../../db/schema";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import { DATA_EXPORT_STORAGE_KEY_PREFIX, getStorage, type MultipartStorage } from "../storageService";
import { removeExportObjects } from "./jobs";
import { failDataExport } from "./runner";

/** A job that has not written for this long is stuck (its lease is 2 minutes, extended every batch). */
export const DATA_EXPORT_STUCK_MS = 24 * 60 * 60 * 1000;
/** An unfinished upload no running job records is abandoned after this long. */
export const DATA_EXPORT_ORPHAN_UPLOAD_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export interface DataExportMaintenanceResult {
  expired: number;
  stuck: number;
  objectsRemoved: number;
  orphanUploadsAborted: number;
}

export async function runDataExportMaintenance(options: { now?: Date; multipart?: MultipartStorage | null } = {}): Promise<DataExportMaintenanceResult> {
  const now = options.now ?? currentDate();
  const db = getDb();

  const expiredIds = db.select({ id: dataExports.id }).from(dataExports)
    .where(and(eq(dataExports.status, "ready"), lte(dataExports.expiresAt, now)))
    .limit(BATCH);
  const expired = await db.update(dataExports).set({ status: "expired", updatedAt: now })
    .where(and(inArray(dataExports.id, expiredIds), eq(dataExports.status, "ready")))
    .returning({ id: dataExports.id });

  const stuckRows = await db.select({ id: dataExports.id }).from(dataExports)
    .leftJoin(durableTasks, eq(durableTasks.id, dataExports.durableTaskId))
    .where(and(
      sql`${dataExports.status} IN ('queued', 'running')`,
      or(
        sql`${durableTasks.id} IS NULL`,
        ne(durableTasks.state, "open"),
        and(eq(dataExports.status, "running"), lte(dataExports.updatedAt, new Date(now.getTime() - DATA_EXPORT_STUCK_MS))),
      ),
    ))
    .limit(BATCH);
  let stuck = 0;
  for (const row of stuckRows) {
    // failDataExport aborts the recorded upload and deletes finished volumes (removeExportObjects).
    if (await failDataExport(row.id, "stuck", now)) stuck += 1;
  }

  const leftovers = await db.select({ id: dataExports.id, volumes: dataExports.volumes, progress: dataExports.progress }).from(dataExports)
    .where(and(
      sql`${dataExports.status} IN ('expired', 'failed', 'deleted')`,
      or(sql`jsonb_array_length(${dataExports.volumes}) > 0`, sql`${dataExports.progress}->>'uploadId' IS NOT NULL`),
    ))
    .limit(BATCH);
  let objectsRemoved = 0;
  for (const row of leftovers) {
    try {
      objectsRemoved += await removeExportObjects([row]);
    } catch (err) {
      console.error(`[data-export] removing the objects of ${row.id} failed:`, serializeErrorForLog(err));
    }
  }

  const orphanUploadsAborted = await abortOrphanUploads(now, options.multipart === undefined ? getStorage()?.multipart ?? null : options.multipart);
  return { expired: expired.length, stuck, objectsRemoved, orphanUploadsAborted };
}

async function abortOrphanUploads(now: Date, multipart: MultipartStorage | null): Promise<number> {
  if (!multipart) return 0;
  const uploads = await multipart.listMultipartUploads(DATA_EXPORT_STORAGE_KEY_PREFIX);
  const old = uploads.filter((upload) => upload.initiatedAt.getTime() <= now.getTime() - DATA_EXPORT_ORPHAN_UPLOAD_MS);
  if (old.length === 0) return 0;
  // Read after listing: an upload recorded meanwhile is owned, never aborted.
  const owned = new Set((await getDb().select({ uploadId: sql<string | null>`${dataExports.progress}->>'uploadId'` }).from(dataExports)
    .where(sql`${dataExports.status} IN ('queued', 'running') AND ${dataExports.progress}->>'uploadId' IS NOT NULL`))
    .map((row) => row.uploadId));
  let aborted = 0;
  for (const upload of old.slice(0, BATCH * 5)) {
    if (owned.has(upload.uploadId)) continue;
    try {
      await multipart.abortMultipartUpload(upload.key, upload.uploadId);
      aborted += 1;
    } catch (err) {
      console.error(`[data-export] aborting orphan upload of ${upload.key} failed:`, serializeErrorForLog(err));
    }
  }
  return aborted;
}

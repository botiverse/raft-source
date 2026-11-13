import { and, eq, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  attachmentTransferIntents,
  attachmentUploadReservations,
  attachmentUploadSessions,
  channelConversionJobs,
} from "../db/schema";
import { withChannelConversionResourceLock } from "./channelConversionFenceService";
import { RESERVATION_IN_FLIGHT, SESSION_IN_FLIGHT, TRANSFER_INTENT_IN_FLIGHT } from "./channelConversionUploadActivity";

type ConversionProgress = Record<string, unknown>;

function progressObject(value: unknown): ConversionProgress {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ConversionProgress
    : {};
}

function withoutUploadBlocker(progress: ConversionProgress): ConversionProgress {
  const next = { ...progress };
  delete next.errorCode;
  delete next.uploadCount;
  delete next.uploadScope;
  return next;
}

/**
 * Recompute the durable prepare blocker after an upload leaves the active
 * state. Settings and the composer are only projections; this write is what
 * makes a failed receipt converge after Cancel and prevents a reopen from
 * resurrecting the old upload Alert.
 */
export async function reconcileConversionUploadBlocker(channelId: string): Promise<void> {
  const db = getDb();
  const jobs = await db
    .select({ id: channelConversionJobs.id, serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(and(
      eq(channelConversionJobs.sourceChannelId, channelId),
      eq(channelConversionJobs.status, "failed"),
      sql`${channelConversionJobs.progress}->>'errorCode' = 'channel_conversion_uploads_in_flight'`,
    ));

  for (const job of jobs) {
    await withChannelConversionResourceLock(job.serverId, job.sourceChannelId, async (tx) => {
      const [current] = await tx
        .select()
        .from(channelConversionJobs)
        .where(and(
          eq(channelConversionJobs.id, job.id),
          eq(channelConversionJobs.status, "failed"),
        ))
        .limit(1);
      if (!current) return;

      const active = await tx.execute(sql`
        WITH active_rows AS (
          SELECT 'session'::text AS kind, upload.id::text AS id, upload.attachment_id::text AS logical_id
            FROM ${attachmentUploadSessions} upload
           WHERE upload.channel_id = ${current.sourceChannelId}
             AND ${SESSION_IN_FLIGHT}
          UNION ALL
          SELECT 'transfer_intent'::text AS kind, intent.id::text AS id, intent.reservation_id::text AS logical_id
            FROM ${attachmentTransferIntents} intent
           WHERE intent.channel_id = ${current.sourceChannelId}
             AND ${TRANSFER_INTENT_IN_FLIGHT}
          UNION ALL
          SELECT 'reservation'::text AS kind, reservation.id::text AS id, reservation.id::text AS logical_id
            FROM ${attachmentUploadReservations} reservation
           WHERE reservation.channel_id = ${current.sourceChannelId}
             AND ${RESERVATION_IN_FLIGHT}
        )
        SELECT kind, id, logical_id FROM active_rows ORDER BY kind, id
      `);
      const existing = progressObject(current.progress);
      const persistedScope = existing.uploadScope && typeof existing.uploadScope === "object" && !Array.isArray(existing.uploadScope)
        ? existing.uploadScope as Record<string, unknown>
        : null;
      const scopedSessionIds = Array.isArray(persistedScope?.sessionIds)
        ? persistedScope.sessionIds.map(String)
        : [];
      const scopedIntentIds = Array.isArray(persistedScope?.transferIntentIds)
        ? persistedScope.transferIntentIds.map(String)
        : [];
      const scopedReservationIds = Array.isArray(persistedScope?.reservationIds)
        ? persistedScope.reservationIds.map(String)
        : [];
      const scopedRows = scopedSessionIds.length + scopedIntentIds.length + scopedReservationIds.length > 0
        ? await tx.execute(sql`
            WITH active_rows AS (
              SELECT 'session'::text AS kind, upload.id::text AS id, upload.attachment_id::text AS logical_id
                FROM ${attachmentUploadSessions} upload
               WHERE ${scopedSessionIds.length > 0 ? sql`upload.id IN (${sql.join(scopedSessionIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`}
                 AND ${SESSION_IN_FLIGHT}
              UNION ALL
              SELECT 'transfer_intent'::text AS kind, intent.id::text AS id, intent.reservation_id::text AS logical_id
                FROM ${attachmentTransferIntents} intent
               WHERE ${scopedIntentIds.length > 0 ? sql`intent.id IN (${sql.join(scopedIntentIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`}
                 AND ${TRANSFER_INTENT_IN_FLIGHT}
              UNION ALL
              SELECT 'reservation'::text AS kind, reservation.id::text AS id, reservation.id::text AS logical_id
                FROM ${attachmentUploadReservations} reservation
               WHERE ${scopedReservationIds.length > 0 ? sql`reservation.id IN (${sql.join(scopedReservationIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`}
                 AND ${RESERVATION_IN_FLIGHT}
            )
            SELECT kind, id, logical_id FROM active_rows ORDER BY kind, id
          `)
        : active;
      const scopedActiveRows = scopedRows.rows as Array<{ kind?: unknown; id?: unknown; logical_id?: unknown }>;
      const scopedUploadCount = new Set(scopedActiveRows.map((row) => String(row.logical_id ?? row.id))).size;
      const nextScope = {
        sessionIds: scopedActiveRows.filter((row) => row.kind === "session").map((row) => String(row.id)),
        transferIntentIds: scopedActiveRows.filter((row) => row.kind === "transfer_intent").map((row) => String(row.id)),
        reservationIds: scopedActiveRows.filter((row) => row.kind === "reservation").map((row) => String(row.id)),
      };
      const nextProgress = scopedUploadCount === 0
        ? withoutUploadBlocker(existing)
        : { ...existing, uploadScope: nextScope, uploadCount: scopedUploadCount };
      await tx
        .update(channelConversionJobs)
        .set({
          error: scopedUploadCount === 0 ? null : current.error,
          progress: nextProgress,
          updatedAt: currentDate(),
        })
        .where(eq(channelConversionJobs.id, current.id));
    });
  }
}

import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  attachmentUploadReservations,
  channels,
} from "../db/schema.js";
import {
  ATTACHMENT_RESERVATION_TTL_MS,
  resolveAttachmentLifecycleDatabaseNow,
} from "./attachmentLifecycleService.js";

export type AttachmentObjectBackfillHooks = {
  afterObjectInsert?: (projectionId: string, tx: DatabaseTransaction) => Promise<void>;
  afterProjectionClaim?: (projectionId: string, tx: DatabaseTransaction) => Promise<void>;
};

export type AttachmentObjectBackfillResult = {
  claimed: number;
  completed: number;
};

function deterministicObjectId(projectionId: string): string {
  const hex = createHash("sha256")
    .update(`attachment-object-backfill:${projectionId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/**
 * Phase C restart-safe foundation backfill. Each worker locks projections that
 * still need an object or a pending reservation. A legacy objectless pending
 * row gets its deterministic object and same-id reservation in ONE transaction;
 * an object-backed pending row from an earlier rollout gets the missing
 * reservation without minting another object. Backfill intentionally writes no
 * charge row and never groups rows by storage key.
 */
export async function backfillLegacyAttachmentObjectsBatch(
  db: Database,
  limit = 100,
  hooks: AttachmentObjectBackfillHooks = {},
  /**
   * Restrict the claim to one server. `undefined` keeps the full-database
   * default. The predicate is applied to the CLAIM and to the write-back guard
   * together: scoping only the claim would let a concurrent writer move a row
   * out of scope between select and update, and there is no reviewed rollback
   * path for that write (task #103).
   */
  serverId?: string,
): Promise<AttachmentObjectBackfillResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Attachment object backfill limit must be an integer between 1 and 1000");
  }

  return db.transaction(async (tx) => {
    const missingReservation = sql`NOT EXISTS (
      SELECT 1
        FROM attachment_upload_reservations candidate_reservation
       WHERE candidate_reservation.id = ${attachments.id}
          OR candidate_reservation.object_id = ${attachments.objectId}
    )`;
    const claimed = await tx
      .select({
        projection: attachments,
        originServerId: channels.serverId,
        object: attachmentObjects,
      })
      .from(attachments)
      .innerJoin(channels, eq(channels.id, attachments.channelId))
      .leftJoin(attachmentObjects, eq(attachmentObjects.id, attachments.objectId))
      .where(and(
        or(
          isNull(attachments.objectId),
          and(
            isNotNull(attachments.objectId),
            isNull(attachments.messageId),
            isNull(attachments.revokedAt),
            eq(attachmentObjects.lifecycleState, "active"),
            missingReservation,
          ),
        ),
        serverId ? eq(channels.serverId, serverId) : undefined,
      ))
      .orderBy(attachments.createdAt, attachments.id)
      .limit(limit)
      .for("update", { of: attachments, skipLocked: true });

    const now = await resolveAttachmentLifecycleDatabaseNow(tx);
    for (const { projection, originServerId, object } of claimed) {
      await hooks.afterProjectionClaim?.(projection.id, tx);
      const objectId = projection.objectId ?? deterministicObjectId(projection.id);
      if (projection.objectId === null) {
        await tx.insert(attachmentObjects).values({
          id: objectId,
          originServerId,
          uploaderId: projection.uploaderId,
          uploaderType: projection.uploaderType,
          storageKey: projection.storageKey,
          thumbnailKey: projection.thumbnailKey,
          contentHash: projection.contentHash,
          mimeType: projection.mimeType,
          sizeBytes: projection.sizeBytes,
          width: projection.width,
          height: projection.height,
          createdAt: projection.createdAt,
        });
        await hooks.afterObjectInsert?.(projection.id, tx);
      } else if (!object) {
        throw new Error(`Attachment projection ${projection.id} references a missing object ${projection.objectId}`);
      }
      const writeBackScopeGuard = serverId
        ? sql`EXISTS (
            SELECT 1
              FROM channels write_back_channel
             WHERE write_back_channel.id = ${attachments.channelId}
               AND write_back_channel.server_id = ${serverId}
          )`
        : undefined;
      if (projection.objectId === null) {
        const messageStateGuard = projection.messageId === null
          ? isNull(attachments.messageId)
          : eq(attachments.messageId, projection.messageId);
        const [updated] = await tx.update(attachments).set({
          objectId,
          pendingChannelId: projection.messageId === null ? projection.channelId : null,
          createdById: projection.createdById ?? projection.uploaderId,
          createdByType: projection.createdByType ?? projection.uploaderType,
        }).where(and(
          eq(attachments.id, projection.id),
          isNull(attachments.objectId),
          messageStateGuard,
          writeBackScopeGuard,
        )).returning({ id: attachments.id });
        if (!updated) {
          if (serverId) {
            throw new Error(
              `Attachment projection ${projection.id} left target server ${serverId} before write-back; `
              + "the write-back scope guard rejected the batch and the transaction will roll back",
            );
          }
          throw new Error(`Attachment projection ${projection.id} changed while backfill lock was held`);
        }
      } else if (serverId) {
        const [stillInScope] = await tx.select({ id: channels.id }).from(channels).where(and(
          eq(channels.id, projection.channelId),
          eq(channels.serverId, serverId),
        )).limit(1);
        if (!stillInScope) {
          throw new Error(
            `Attachment projection ${projection.id} left target server ${serverId} before reservation write-back; `
            + "the write-back scope guard rejected the batch and the transaction will roll back",
          );
        }
      }

      if (projection.messageId === null && projection.revokedAt === null) {
        const [stillPending] = await tx.select({ id: attachments.id }).from(attachments).where(and(
          eq(attachments.id, projection.id),
          eq(attachments.objectId, objectId),
          isNull(attachments.messageId),
          isNull(attachments.revokedAt),
          eq(attachments.channelId, projection.channelId),
        )).limit(1);
        if (!stillPending) {
          throw new Error(`Attachment projection ${projection.id} changed while backfill lock was held`);
        }
        await tx.insert(attachmentUploadReservations).values({
          id: projection.id,
          objectId,
          originServerId: object?.originServerId ?? originServerId,
          channelId: projection.channelId,
          creatorId: projection.createdById ?? projection.uploaderId,
          creatorType: projection.createdByType ?? projection.uploaderType,
          filename: projection.filename,
          state: "pending",
          expiresAt: new Date(projection.createdAt.getTime() + ATTACHMENT_RESERVATION_TTL_MS),
          createdAt: projection.createdAt,
          updatedAt: now,
        });
      }
    }

    return { claimed: claimed.length, completed: claimed.length };
  });
}

export type AttachmentObjectParityReport = {
  totalProjections: number;
  nullObjectIds: number;
  /** Null projections whose channel does not resolve; the backfill cannot claim these. */
  orphanNullObjectIds: number;
  objectRows: number;
  danglingObjectIds: number;
  metadataMismatches: number;
  detachedObjects: number;
  duplicateStorageKeyGroups: number;
  objectBackedPendingWithoutReservation: number;
  pendingFoundationMismatches: number;
  orphanPendingReservations: number;
};

export async function getAttachmentObjectParityReport(
  db: Database,
  /**
   * Scope for the WORK counters only. `orphan_null_object_ids` below stays
   * global on purpose: an orphaned projection is evidence that the database's
   * FK/NOT NULL guarantees have failed, and those guarantees are database-wide
   * — constraints do not break per server. Scoping that check would make it
   * meaningless in exactly the world it exists for (task #103, @kingwl).
   */
  serverId?: string,
): Promise<AttachmentObjectParityReport> {
  // One predicate reused by every WORK counter below. Joining through the
  // projection's channel is the only authority for which server a row belongs
  // to — the same join the claim uses, so counters and claim agree by
  // construction rather than by coincidence.
  const inScope = (alias: string) =>
    serverId
      ? sql` AND EXISTS (SELECT 1 FROM channels sc WHERE sc.id = ${sql.raw(alias)}.channel_id AND sc.server_id = ${serverId})`
      : sql``;
  // Object-side counters scope by the object's own origin server, which the
  // backfill stamps at creation. Projection-side counters scope through the
  // channel. Two different authorities for the same question, because the two
  // row kinds carry server identity differently.
  const objectInScope = (alias: string) =>
    serverId ? sql` AND ${sql.raw(alias)}.origin_server_id = ${serverId}` : sql``;
  const scopedNullCount = serverId
    ? sql`(SELECT count(*)::int FROM attachments a JOIN channels c ON c.id = a.channel_id
             WHERE a.object_id IS NULL AND c.server_id = ${serverId})`
    : sql`(SELECT count(*)::int FROM attachments WHERE object_id IS NULL)`;
  const result = await db.execute<{
    total_projections: number;
    null_object_ids: number;
    orphan_null_object_ids: number;
    object_rows: number;
    dangling_object_ids: number;
    metadata_mismatches: number;
    detached_objects: number;
    duplicate_storage_key_groups: number;
    object_backed_pending_without_reservation: number;
    pending_foundation_mismatches: number;
    orphan_pending_reservations: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM attachments) AS total_projections,
      ${scopedNullCount} AS null_object_ids,
      -- Null projections the backfill can never claim: it selects through an
      -- inner join on channels, while null_object_ids above counts without a
      -- join. Without this figure a completed run looks identical to an
      -- incomplete one: claimed reaches 0 while null_object_ids stays above it,
      -- so the completion criterion is unreachable for a reason nobody can see.
      -- A channel is also the only authority for an object origin server, so
      -- these rows cannot be safely constructed at all (task #79).
      (SELECT count(*)::int
         FROM attachments a
         LEFT JOIN channels c ON c.id = a.channel_id
        WHERE a.object_id IS NULL AND c.id IS NULL) AS orphan_null_object_ids,
      (SELECT count(*)::int FROM attachment_objects) AS object_rows,
      (SELECT count(*)::int
         FROM attachments p
         LEFT JOIN attachment_objects o ON o.id = p.object_id
        WHERE p.object_id IS NOT NULL AND o.id IS NULL${inScope("p")}) AS dangling_object_ids,
      (SELECT count(*)::int
         FROM attachments p
         JOIN attachment_objects o ON o.id = p.object_id
        -- The seven mismatch branches are parenthesised as a unit before the
        -- scope predicate. Without the parentheses AND binds tighter than OR,
        -- so the scope would attach to the LAST branch only and the other six
        -- would leak across servers — a bystander's storage_key mismatch would
        -- count against the target's parity (task #103 review RED, @kingwl).
        WHERE (p.storage_key IS DISTINCT FROM o.storage_key
           OR p.thumbnail_key IS DISTINCT FROM o.thumbnail_key
           OR p.content_hash IS DISTINCT FROM o.content_hash
           OR p.mime_type IS DISTINCT FROM o.mime_type
           OR p.size_bytes IS DISTINCT FROM o.size_bytes
           OR p.width IS DISTINCT FROM o.width
           OR p.height IS DISTINCT FROM o.height)${inScope("p")}) AS metadata_mismatches,
      (SELECT count(*)::int
         FROM attachment_objects o
         LEFT JOIN attachments p ON p.object_id = o.id
        WHERE p.id IS NULL
          AND o.lifecycle_state = 'active'${objectInScope("o")}) AS detached_objects,
      (SELECT count(*)::int FROM (
         SELECT storage_key FROM attachment_objects
          WHERE TRUE${objectInScope("attachment_objects")}
          GROUP BY storage_key HAVING count(*) > 1
       ) duplicate_keys) AS duplicate_storage_key_groups,
      (SELECT count(*)::int
         FROM attachments p
         JOIN channels c ON c.id = p.channel_id
         JOIN attachment_objects o ON o.id = p.object_id
         LEFT JOIN attachment_upload_reservations r ON r.id = p.id
        WHERE p.message_id IS NULL
          AND p.revoked_at IS NULL
          AND p.object_id IS NOT NULL
          AND o.lifecycle_state = 'active'
          AND r.id IS NULL
          ${serverId ? sql`AND c.server_id = ${serverId}` : sql``}) AS object_backed_pending_without_reservation,
      (SELECT count(*)::int
         FROM attachments p
         JOIN channels c ON c.id = p.channel_id
         LEFT JOIN attachment_objects o ON o.id = p.object_id
         LEFT JOIN attachment_upload_reservations r ON r.id = p.id
        WHERE p.message_id IS NULL
          AND p.revoked_at IS NULL
          AND p.object_id IS NOT NULL
          AND (
            o.id IS NULL
            OR o.lifecycle_state <> 'active'
            OR (r.id IS NOT NULL AND (
              r.object_id IS DISTINCT FROM p.object_id
              OR r.state <> 'pending'
              OR r.origin_server_id IS DISTINCT FROM o.origin_server_id
              OR r.channel_id IS DISTINCT FROM p.channel_id
              OR r.creator_id IS DISTINCT FROM COALESCE(p.created_by_id, p.uploader_id)
              OR r.creator_type IS DISTINCT FROM COALESCE(p.created_by_type, p.uploader_type)
              OR r.filename IS DISTINCT FROM p.filename
            ))
          )
          ${serverId ? sql`AND c.server_id = ${serverId}` : sql``}) AS pending_foundation_mismatches,
      (SELECT count(*)::int
         FROM attachment_upload_reservations r
         LEFT JOIN attachments p
           ON p.id = r.id
          AND p.object_id = r.object_id
          AND p.message_id IS NULL
          AND p.revoked_at IS NULL
         LEFT JOIN channels c ON c.id = r.channel_id
        WHERE r.state = 'pending'
          AND p.id IS NULL
          ) AS orphan_pending_reservations
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Attachment object parity query returned no row");
  return {
    totalProjections: row.total_projections,
    nullObjectIds: row.null_object_ids,
    orphanNullObjectIds: row.orphan_null_object_ids,
    objectRows: row.object_rows,
    danglingObjectIds: row.dangling_object_ids,
    metadataMismatches: row.metadata_mismatches,
    detachedObjects: row.detached_objects,
    duplicateStorageKeyGroups: row.duplicate_storage_key_groups,
    objectBackedPendingWithoutReservation: row.object_backed_pending_without_reservation,
    pendingFoundationMismatches: row.pending_foundation_mismatches,
    orphanPendingReservations: row.orphan_pending_reservations,
  };
}

/**
 * Completion gate over a parity report. Pure, so both directions are testable
 * without a database (task #79).
 *
 * `duplicateStorageKeyGroups` is deliberately NOT a gate input. The contract is
 * one deterministic object per legacy projection, keyed on the projection id
 * and unrelated to storage key, so two projections sharing a physical key
 * correctly produce two objects and a non-zero group count. Gating on zero
 * would judge the specified behaviour a failure: a field being computed is not
 * a field required to be zero.
 */
export function evaluateAttachmentObjectCompletionGate(
  report: AttachmentObjectParityReport,
): { complete: boolean; failures: string[] } {
  const failures: string[] = [];
  if (report.nullObjectIds !== 0) failures.push(`nullObjectIds=${report.nullObjectIds}`);
  if (report.danglingObjectIds !== 0) failures.push(`danglingObjectIds=${report.danglingObjectIds}`);
  if (report.metadataMismatches !== 0) failures.push(`metadataMismatches=${report.metadataMismatches}`);
  // Detached historical object/charge residue is owned by the separately
  // authorized remediation set and durable GC workflow. It is deliberately
  // not a projection-backfill completion counter: mixing it here used to let a
  // clean 415k projection migration commit and then fail on unrelated residue.
  if (report.objectBackedPendingWithoutReservation !== 0) {
    failures.push(`objectBackedPendingWithoutReservation=${report.objectBackedPendingWithoutReservation}`);
  }
  if (report.pendingFoundationMismatches !== 0) {
    failures.push(`pendingFoundationMismatches=${report.pendingFoundationMismatches}`);
  }
  if (report.orphanPendingReservations !== 0) {
    failures.push(`orphanPendingReservations=${report.orphanPendingReservations}`);
  }
  return { complete: failures.length === 0, failures };
}

/**
 * Preflight over a parity report, evaluated BEFORE any write.
 *
 * A null projection whose channel does not resolve cannot be claimed (the batch
 * selects through an inner join on channels) and cannot be safely constructed
 * either, because the channel is the only authority for the object's origin
 * server. Auto-repairing invents an origin; excluding it from the completion
 * criterion reports "done" over rows nobody examined. Both are refused here.
 */
export function evaluateAttachmentObjectPreflight(
  report: AttachmentObjectParityReport,
): { safeToApply: boolean; reason: string | null } {
  if (report.orphanNullObjectIds > 0) {
    return {
      safeToApply: false,
      reason:
        `${report.orphanNullObjectIds} attachment projection(s) have object_id IS NULL and no `
        + "resolvable channel; they can be neither claimed nor safely constructed",
    };
  }
  const immutableBlockers = [
    ["danglingObjectIds", report.danglingObjectIds],
    ["metadataMismatches", report.metadataMismatches],
    ["pendingFoundationMismatches", report.pendingFoundationMismatches],
    ["orphanPendingReservations", report.orphanPendingReservations],
  ] as const;
  const failures = immutableBlockers.filter(([, value]) => value !== 0);
  if (failures.length > 0) {
    return {
      safeToApply: false,
      reason: `existing attachment foundation anomalies must be remediated before backfill: ${failures
        .map(([name, value]) => `${name}=${value}`)
        .join(" ")}`,
    };
  }
  return { safeToApply: true, reason: null };
}

/**
 * What a finished run may claim, decided BEFORE the completion gate runs.
 *
 * A segmented run (`--max-rows`) is never a completion receipt, whatever the
 * parity numbers say. Evaluating the completion gate first would throw on the
 * backlog it was explicitly told to leave behind, so the run would fail on the
 * generic gate and never emit its segmented label — making the labelled outcome
 * unreachable and the contract unverifiable (task #79 review RED, @kingwl).
 */
export function classifyBackfillRunOutcome(input: {
  maxRows: number | null;
  processed: number;
}): { kind: "segmented" | "full"; completionEligible: boolean; note: string | null } {
  if (input.maxRows !== null) {
    return {
      kind: "segmented",
      completionEligible: false,
      note:
        `Segmented run: --max-rows=${input.maxRows} processed ${input.processed} row(s). `
        + "This is NOT a completion receipt and must not be cited as evidence that a "
        + "feature flag may be enabled. Re-run without --max-rows for a full migration.",
    };
  }
  return { kind: "full", completionEligible: true, note: null };
}

export interface BackfillRunOptions {
  apply: boolean;
  batchSize: number;
  maxRows: number | null;
  /** Canonical server UUID, freshly resolved. Never a display name (task #103). */
  serverId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The whole run sequence, with its I/O injected.
 *
 * This lives here rather than in the script because the ORDER of these steps is
 * the contract, and an order that only exists in an entry point cannot be
 * tested: an earlier revision extracted the classification into a pure function
 * and tested that, which stayed green when the entry point put the completion
 * gate back in front of it — the defect was reachable again while the teeth
 * still passed (task #79 review RED, @kingwl). Testing the decision without the
 * sequence tests the wrong thing.
 */
export async function runAttachmentObjectBackfill(input: {
  options: BackfillRunOptions;
  /**
   * Raw value of ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY. The RAW value, not a
   * boolean: the comparison is the gate, so it belongs in tested code. Passing
   * a pre-computed boolean would move the decision back into the entry point
   * where nothing can exercise it.
   */
  fleetReadyEnv: string | undefined;
  /**
   * Fresh existence check for the target server. Required whenever a scope is
   * given, because a well-formed UUID that names nothing selects zero rows —
   * and zero remaining is indistinguishable from a completed canary. A typo
   * would otherwise report success for a server that was never touched
   * (task #103 review RED, @kingwl).
   */
  serverExists?: (serverId: string) => Promise<boolean>;
  readParity: () => Promise<AttachmentObjectParityReport>;
  runBatch: (limit: number) => Promise<{ claimed: number; completed: number }>;
  log: (record: Record<string, unknown>) => void;
}): Promise<{ completed: number; outcome: "dry_run" | "segmented" | "complete" }> {
  const { options, fleetReadyEnv, serverExists, readParity, runBatch, log } = input;

  if (options.serverId !== undefined && !UUID_RE.test(options.serverId)) {
    throw new Error(
      `--server-id must be a canonical UUID, got ${JSON.stringify(options.serverId)}. `
      + "A human-facing server name is not an identity and is never resolved by matching.",
    );
  }

  if (options.serverId !== undefined) {
    if (!serverExists) {
      throw new Error("A scoped run requires a server existence check; refusing to scope on an unverified id.");
    }
    if (!(await serverExists(options.serverId))) {
      throw new Error(
        `Target server ${options.serverId} does not exist. No rows were written. `
        + "A canonical UUID that names nothing selects zero rows, and zero remaining would "
        + "otherwise read as a completed canary.",
      );
    }
  }

  const before = await readParity();
  log({ phase: "before", ...before });
  if (!options.apply) return { completed: 0, outcome: "dry_run" };

  // Apply-only fleet gate, before any batch. Writing while some replica still
  // single-writes would produce new NULL projections behind the migration, so
  // this must fail closed on unset or anything other than "true". Deliberately
  // after the dry-run return: reading parity needs no fleet guarantee, and
  // blocking dry runs would remove the only safe way to inspect the backlog.
  if (fleetReadyEnv !== "true") {
    throw new Error(
      "ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY=true is required with --apply "
      + `(got ${fleetReadyEnv === undefined ? "unset" : JSON.stringify(fleetReadyEnv)}). No rows were written.`,
    );
  }

  // Preflight, before any write: an orphaned null projection can be neither
  // claimed nor safely constructed, so the run stops rather than inventing an
  // origin server or quietly dropping the row from the completion criterion.
  const preflight = evaluateAttachmentObjectPreflight(before);
  if (!preflight.safeToApply) {
    throw new Error(
      `Preflight failed: ${preflight.reason}. No rows were written. `
      + "Resolve the orphaned projections before running --apply.",
    );
  }

  let completed = 0;
  while (options.maxRows === null || completed < options.maxRows) {
    const remaining = options.maxRows === null
      ? options.batchSize
      : Math.min(options.batchSize, options.maxRows - completed);
    const result = await runBatch(remaining);
    completed += result.completed;
    log({ phase: "batch", ...result, completed });
    if (result.claimed === 0) break;
  }

  const after = await readParity();
  log({ phase: "after", completed, ...after });

  // Classify BEFORE the completion gate. A segmented run is told to leave a
  // backlog, so the gate would throw on exactly what was requested and the
  // segmented label would never be emitted.
  const outcome = classifyBackfillRunOutcome({ maxRows: options.maxRows, processed: completed });
  if (!outcome.completionEligible) {
    log({ phase: "segmented", kind: outcome.kind, note: outcome.note });
    throw new Error(outcome.note ?? "Segmented run is not a completion receipt");
  }

  const gate = evaluateAttachmentObjectCompletionGate(after);
  if (!gate.complete) {
    throw new Error(
      `Attachment object parity gate failed: ${gate.failures.join(" ")} `
      + `(duplicateStorageKeyGroups=${after.duplicateStorageKeyGroups} is diagnostic, not gated)`,
    );
  }
  return { completed, outcome: "complete" };
}

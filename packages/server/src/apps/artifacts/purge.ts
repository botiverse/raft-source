// Clearing a closed server's Artifacts (core's closed-server purge,
// FirstPartyApp.purgeServer; docs/development/first-party-apps.md): core
// calls it batch by batch, before it clears the server's conversations, each
// call in its own transaction, until nothing is left.
//
// - `count` deletes nothing: how many Artifacts, versions and comments the
//   server has, and its blobs and their bytes (the purge's count report).
// - Both leave an Artifact homed in one of `keepChannelIds` (a joint channel
//   or projection, a migration receipt channel, what is under them): other
//   servers still see it through the joint (platform/visibility
//   seenThroughJoint), so it is neither counted nor deleted (the blob
//   count stays the server's: a kept Artifact's blobs stay with it).
// - `delete` deletes at most `limit` of the server's Artifacts (live or
//   already deleted). Everything of an Artifact goes with its item row by
//   cascade: versions, their files and texts and publish checks, comments,
//   drafts, reviews, audit rows, saves, read positions, subscriptions,
//   notices, search rows. The bytes stay for the jobs that already collect
//   them: a blob no version uses goes in prune_artifact_blobs (blobs.ts), a
//   check's screenshots in core's object-file sweep (a soft-deleted server's).
//
// A server that isn't closed (or doesn't exist) is refused, whatever the
// caller says: that it is closed is read again in the batch's transaction.
//
// Purging one Artifact for good (purgeArtifact): a Raft operator's step,
// through the operator's script (scripts/artifacts-takedown.ts `purge`: it
// only plans unless `--apply` with the approval, the run id and the
// accountable human, on the primary; runbook
// docs/operations/artifact-takedown.md), for what must not be kept even
// taken down (illegal content, leaked secrets or personal data). No route
// reaches it, and no takedown has to come first: it is one transaction.
// planArtifactPurge counts what would go and deletes nothing.
// purgeArtifact, in one transaction under the item's row lock:
// - lets every core object file of the Artifact go (publish-check
//   screenshots, comment images: deleteObjectFiles; their bytes after the
//   commit, and core's sweep retries a failed one), forgets its people's
//   Activity rows and its object events (platform/activity, platform/objects);
// - deletes the item row, and with it by cascade everything of it: versions,
//   their files, texts and checks, comments, drafts, reviews, audit rows,
//   saves, read positions, subscriptions, notices, its search row;
// - deletes the rows of its versions' blobs that no remaining version uses
//   (blobs.ts deleteUnusedBlobsOf: bytes another of the server's Artifacts
//   still has stay, as does one a publish holds right now);
// - writes the purge record (`purges`, no foreign key, so it outlives the
//   Artifact and its server): only how many of each went and the reason
//   (Tenny on #13578: not who ran or approved it, which the script's receipt
//   and the approval thread keep; never its title or content), with the
//   deleted blobs' storage keys, so a crash before their objects go doesn't
//   lose them.
// After the commit it deletes those keys' objects, and the record keeps
// only the keys whose delete failed (`pending_object_keys`): a key is in it
// only until its delete succeeds. Run again for a purged Artifact, it writes
// nothing new and deletes those keys again, clearing each that goes:
// `changed: false`. Never an Artifact of no record (the one not_found).
import { and, count, eq, inArray, isNotNull, not, sql, sum, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ServerId } from "@botiverse/raft-shared";
import type { AppPurgeServerOptions, AppPurgeServerResult } from "../../platform/apps";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { isClosedServer } from "../../platform/flags";
import { deleteObjectFileBytes, deleteObjectFiles } from "../../platform/objectFiles";
import { forgetObjectEvents } from "../../platform/objects";
import { forgetArtifactActivity } from "./activity";
import { deleteUnusedBlobsOf } from "./blobs";
import type { ArtifactR2Store } from "./blobStore";
import { artifactFileObject } from "./checks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import {
  artifactAttachmentSaves,
  artifactAudit,
  artifactBlobs,
  artifactCommentDrafts,
  artifactComments,
  artifactItems,
  artifactPendingNotices,
  artifactPurges,
  artifactReadPositions,
  artifactReviews,
  artifactSearch,
  artifactSubscriptions,
  artifactVersionChecks,
  artifactVersionFiles,
  artifactVersions,
  artifactVersionTexts,
} from "./schema";

export class ArtifactPurgeRefusedError extends Error {
  constructor(serverId: ServerId) {
    super(`server ${serverId} is not closed: its Artifacts are never purged`);
    this.name = "ArtifactPurgeRefusedError";
  }
}

export async function purgeArtifactsOfServer(serverId: ServerId, options: AppPurgeServerOptions): Promise<AppPurgeServerResult> {
  const { executor } = options;
  if (!(await isClosedServer(serverId, executor))) throw new ArtifactPurgeRefusedError(serverId);
  const keep = options.keepChannelIds ?? [];
  // The server's Artifacts the purge is for: not one homed in a kept channel.
  const purgeable: SQL = keep.length === 0
    ? eq(artifactItems.serverId, serverId)
    : and(
      eq(artifactItems.serverId, serverId),
      // IS NOT NULL first: a conversation home whose channel is gone (set null) is purgeable, not NULL.
      not(and(eq(artifactItems.homeKind, "conversation"), isNotNull(artifactItems.homeChannelId), inArray(artifactItems.homeChannelId, [...keep]))!),
    )!;

  if (options.mode === "count") {
    const [items] = await executor.select({ n: count() }).from(artifactItems).where(purgeable);
    const [versions] = await executor.select({ n: count() }).from(artifactVersions)
      .innerJoin(artifactItems, eq(artifactItems.id, artifactVersions.itemId))
      .where(purgeable);
    const [comments] = await executor.select({ n: count() }).from(artifactComments)
      .innerJoin(artifactItems, eq(artifactItems.id, artifactComments.itemId))
      .where(purgeable);
    const [blobs] = await executor.select({ n: count(), bytes: sum(artifactBlobs.sizeBytes).mapWith(Number) })
      .from(artifactBlobs).where(eq(artifactBlobs.serverId, serverId));
    return {
      remaining: items!.n > 0,
      counts: { artifacts: items!.n, versions: versions!.n, comments: comments!.n, blobs: blobs!.n, blobBytes: blobs!.bytes ?? 0 },
    };
  }

  const limit = Math.max(0, Math.floor(options.limit));
  const batch = limit === 0 ? [] : await executor.select({ id: artifactItems.id }).from(artifactItems)
    .where(purgeable)
    .orderBy(artifactItems.id)
    .limit(limit)
    .for("update", { skipLocked: true });
  const ids = batch.map((row) => row.id);
  const deleted = ids.length === 0 ? [] : await executor.delete(artifactItems)
    .where(and(purgeable, inArray(artifactItems.id, ids)))
    .returning({ id: artifactItems.id });
  const left = await executor.select({ id: artifactItems.id }).from(artifactItems).where(purgeable).limit(1);
  return { remaining: left.length > 0, counts: { artifacts: deleted.length } };
}

/** What a purge removes of one Artifact, counted before it does (planArtifactPurge, and the record's `removed`). */
export interface ArtifactPurgeCounts {
  versions: number;
  files: number;
  versionTexts: number;
  checks: number;
  comments: number;
  commentDrafts: number;
  reviews: number;
  auditRows: number;
  subscriptions: number;
  readPositions: number;
  attachmentSaves: number;
  pendingNotices: number;
  searchRows: number;
  /** Its versions' blobs no other Artifact's version uses: deleted, rows and objects. */
  blobsUnshared: number;
  blobBytesUnshared: number;
  /** Its versions' blobs another of the server's Artifacts also uses: kept. */
  blobsShared: number;
}

/** The purge record (`purges`) as the script prints it. */
export interface ArtifactPurgeRecord {
  itemId: string;
  serverId: ServerId;
  reason: string;
  /** ArtifactPurgeCounts, then what the transaction removed: `blobsDeleted`, `blobBytesDeleted`, `blobsKept`, `objectFiles`, `events`, `activityRows`. */
  removed: Record<string, number>;
  /** Storage keys of deleted blobs whose object is still to delete (a failed delete; run the purge again). */
  pendingObjectKeys: string[];
  at: string;
}

export type ArtifactPurgeOutcome =
  | { kind: "purged"; changed: boolean; record: ArtifactPurgeRecord }
  | { kind: "not_found" };

/** ArtifactPurgeCounts of the item, in `executor`: two queries. */
async function purgeCounts(executor: DatabaseExecutor, itemId: string): Promise<ArtifactPurgeCounts> {
  const ofItem = (table: PgTable) => sql`(SELECT count(*) FROM ${table} t WHERE t.item_id = ${itemId})::int`;
  const ofVersions = (table: PgTable) => sql`(SELECT count(*) FROM ${table} t JOIN ${artifactVersions} v ON v.id = t.version_id WHERE v.item_id = ${itemId})::int`;
  const [rows, blobs] = await Promise.all([
    executor.execute(sql`SELECT
      (SELECT count(*) FROM ${artifactVersions} v WHERE v.item_id = ${itemId})::int AS versions,
      ${ofVersions(artifactVersionFiles)} AS files,
      ${ofVersions(artifactVersionTexts)} AS version_texts,
      ${ofVersions(artifactVersionChecks)} AS checks,
      ${ofItem(artifactComments)} AS comments,
      ${ofItem(artifactCommentDrafts)} AS comment_drafts,
      ${ofItem(artifactReviews)} AS reviews,
      ${ofItem(artifactAudit)} AS audit_rows,
      ${ofItem(artifactSubscriptions)} AS subscriptions,
      ${ofItem(artifactReadPositions)} AS read_positions,
      ${ofItem(artifactAttachmentSaves)} AS attachment_saves,
      ${ofItem(artifactPendingNotices)} AS pending_notices,
      ${ofItem(artifactSearch)} AS search_rows`),
    // Its versions' blobs, each shared or not: whether a version of another Artifact uses it too.
    executor.execute(sql`
      SELECT b.size_bytes AS size, EXISTS (
        SELECT 1 FROM ${artifactVersionFiles} f2 JOIN ${artifactVersions} v2 ON v2.id = f2.version_id
        WHERE f2.blob_id = b.id AND v2.item_id <> ${itemId}
      ) AS shared
      FROM ${artifactBlobs} b
      WHERE b.id IN (SELECT f.blob_id FROM ${artifactVersionFiles} f JOIN ${artifactVersions} v ON v.id = f.version_id WHERE v.item_id = ${itemId})`),
  ]);
  const row = (rows.rows[0] ?? {}) as Record<string, unknown>;
  const n = (key: string) => Number(row[key] ?? 0);
  const all = blobs.rows as Array<{ size: unknown; shared: unknown }>;
  const unshared = all.filter((blob) => blob.shared !== true);
  return {
    versions: n("versions"),
    files: n("files"),
    versionTexts: n("version_texts"),
    checks: n("checks"),
    comments: n("comments"),
    commentDrafts: n("comment_drafts"),
    reviews: n("reviews"),
    auditRows: n("audit_rows"),
    subscriptions: n("subscriptions"),
    readPositions: n("read_positions"),
    attachmentSaves: n("attachment_saves"),
    pendingNotices: n("pending_notices"),
    searchRows: n("search_rows"),
    blobsUnshared: unshared.length,
    blobBytesUnshared: unshared.reduce((total, blob) => total + Number(blob.size), 0),
    blobsShared: all.length - unshared.length,
  };
}

/** What purging the Artifact would remove (nothing is written), with its server and title for the operator to check; null for no such Artifact. */
export async function planArtifactPurge(itemId: string): Promise<{ serverId: ServerId; title: string; home: string; deleted: boolean; takenDown: boolean; counts: ArtifactPurgeCounts } | null> {
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
  if (!item) return null;
  return { serverId: item.serverId, title: item.title, home: item.homeKind, deleted: item.deletedAt !== null, takenDown: item.revokedAt !== null, counts: await purgeCounts(getDb(), itemId) };
}

const recordOf = (row: typeof artifactPurges.$inferSelect): ArtifactPurgeRecord => ({
  itemId: row.itemId,
  serverId: row.serverId,
  reason: row.reason,
  removed: row.removed,
  pendingObjectKeys: row.pendingObjectKeys,
  at: row.createdAt.toISOString(),
});

/** Delete these keys' objects; the record keeps those whose delete failed (all of them without a store). */
async function deletePendingObjects(itemId: string, keys: readonly string[], store: ArtifactR2Store | null): Promise<typeof artifactPurges.$inferSelect | undefined> {
  const failed: string[] = [];
  for (const key of keys) {
    if (!store) {
      failed.push(key);
      continue;
    }
    try {
      await store.delete(key);
    } catch (error) {
      failed.push(key);
      console.warn("[Artifacts] purge: could not delete a blob's object", { itemId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const [row] = await getDb().update(artifactPurges).set({ pendingObjectKeys: failed }).where(eq(artifactPurges.itemId, itemId)).returning();
  return row;
}

/**
 * Purge the Artifact for good (the header's steps): `reason` 1 to
 * ARTIFACT_TAKEDOWN_REASON_MAX_CHARS characters (takedownReason's), in the
 * record (never the content itself). `store`: Artifacts' blob store (null:
 * no object is deleted, every key stays pending).
 */
export async function purgeArtifact(itemId: string, reason: string, store: ArtifactR2Store | null): Promise<ArtifactPurgeOutcome> {
  const done = await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
    if (!locked) return null;
    const counts = await purgeCounts(tx, locked.id);
    const blobIds = (await tx.selectDistinct({ id: artifactVersionFiles.blobId }).from(artifactVersionFiles)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionFiles.versionId))
      .where(eq(artifactVersions.itemId, locked.id))).map((row) => row.id);
    const files = await deleteObjectFiles({ object: artifactFileObject(locked.id), executor: tx });
    const activityRows = (await forgetArtifactActivity(tx, locked.id)).length;
    const events = await forgetObjectEvents(tx, { kind: ARTIFACT_OBJECT_KIND, objectId: locked.id });
    // Everything else of it goes with the row (cascade).
    await tx.delete(artifactItems).where(eq(artifactItems.id, locked.id));
    const blobs = await deleteUnusedBlobsOf(tx, locked.serverId, blobIds);
    const [row] = await tx.insert(artifactPurges).values({
      itemId: locked.id,
      serverId: locked.serverId,
      reason,
      removed: {
        ...counts,
        blobsDeleted: blobs.length,
        blobBytesDeleted: blobs.reduce((total, blob) => total + blob.sizeBytes, 0),
        blobsKept: blobIds.length - blobs.length,
        objectFiles: files.fileIds.length,
        events,
        activityRows,
      },
      pendingObjectKeys: blobs.map((blob) => blob.r2Key),
    }).returning();
    return { row: row!, files };
  });
  if (done) {
    await deleteObjectFileBytes(done.files);
    const row = await deletePendingObjects(itemId, done.row.pendingObjectKeys, store);
    return { kind: "purged", changed: true, record: recordOf(row ?? done.row) };
  }
  // Purged before (or never there): the record says which; a purged one's objects still pending are deleted again.
  const [record] = await getDb().select().from(artifactPurges).where(eq(artifactPurges.itemId, itemId)).limit(1);
  if (!record) return { kind: "not_found" };
  const row = record.pendingObjectKeys.length > 0 ? await deletePendingObjects(itemId, record.pendingObjectKeys, store) : record;
  return { kind: "purged", changed: false, record: recordOf(row ?? record) };
}

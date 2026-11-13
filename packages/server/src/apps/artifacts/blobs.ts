// The r2 blobs a publish uses: which ones a server already has, storing new
// bytes (counted against the server's monthly file upload quota, as
// attachments are), the cap on bytes no version uses yet, and deleting those
// after a day (or at once, for the rows a failed import made:
// deleteClaimedBlobs).
//
// Everything is per server (Tenny): a blob row and its R2 key carry the
// server, presence is only ever asked within the publishing server, so
// "missing" never says whether another server has the same bytes.
//
// No transaction is held across an R2 request. Storing is two-phase: a short
// transaction inserts the row `pending` (or refreshes an existing one), the
// PUT runs outside it, and a second short transaction marks the row `ready`.
// Only `ready` rows are present to a publish. Every row has its own key
// (r2KeyOf), so an object is only ever written and deleted for that row.
//
// A pending row carries its upload's reservation of the monthly file upload
// quota (quota_month, quota_reserved_bytes), as an attachment's upload session
// does: reserved in the transaction that inserts the row, committed in the
// one that makes it ready, released in the one that deletes it (a failed PUT,
// or the sweep taking a row whose upload never finished, a crash included).
// So no reservation outlives its row, and none waits for the month to end.
//
// The sweep deletes rows first, in transactions that lock them and check
// "no version uses it" afresh; it deletes their objects only after commit. A
// publish holds FOR KEY SHARE on the rows it references (and inserting a
// version_files row takes it too), which the sweep's FOR UPDATE SKIP LOCKED
// skips, so a row gaining a reference is never deleted. An object whose
// delete fails is only a leaked object, never a row without bytes.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES, type ServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import {
  commitFileUploadInTransaction,
  FileUploadQuotaExceededError,
  releaseFileUploadInTransaction,
  reserveFileUpload,
  withFileUploadQuotaLock,
  type DatabaseTransaction,
  type FileUploadReservation,
} from "../../platform/fileUploadQuota";
import { artifactR2Store, r2KeyOf, type ArtifactR2Store } from "./blobStore";
import { artifactBlobs, artifactVersionFiles } from "./schema";

/** How long an upload no version uses (or one that never finished) is kept. */
export const UNREFERENCED_BLOB_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 100;

/** No version_files row uses the blob. */
const noVersionUses = () => sql`NOT EXISTS (SELECT 1 FROM ${artifactVersionFiles} WHERE ${artifactVersionFiles.blobId} = ${artifactBlobs.id})`;
const r2BlobOf = (serverId: ServerId, sha256: string) => and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha256))!;

export interface PresentBlob {
  id: string;
  sizeBytes: number;
}

/** This server's ready r2 blobs among `sha256s`, by sha256. `lock`: hold them FOR KEY SHARE (inside the publish transaction). */
export async function presentBlobs(
  serverId: ServerId,
  sha256s: readonly string[],
  opts: { executor?: DatabaseExecutor; lock?: boolean } = {},
): Promise<Map<string, PresentBlob>> {
  if (sha256s.length === 0) return new Map();
  const query = (opts.executor ?? getDb()).select({ id: artifactBlobs.id, sha256: artifactBlobs.sha256, sizeBytes: artifactBlobs.sizeBytes })
    .from(artifactBlobs)
    .where(and(
      eq(artifactBlobs.serverId, serverId),
      eq(artifactBlobs.state, "ready"),
      inArray(artifactBlobs.sha256, [...new Set(sha256s)]),
    ));
  const rows = opts.lock ? await query.for("key share") : await query;
  return new Map(rows.map((row) => [row.sha256, { id: row.id, sizeBytes: row.sizeBytes }]));
}

/** Bytes of this server's r2 blobs that no version uses (uploads not yet published, unfinished, or left over). */
export async function unreferencedBytes(serverId: ServerId, executor: DatabaseExecutor = getDb()): Promise<number> {
  const [row] = await executor.select({ total: sql<string | null>`sum(${artifactBlobs.sizeBytes})` })
    .from(artifactBlobs)
    .where(and(eq(artifactBlobs.serverId, serverId), noVersionUses()));
  return Number(row?.total ?? 0);
}

export type StoreBlobOutcome =
  | { kind: "stored" }
  | { kind: "quota_exceeded"; used: number; limit: number }
  /** The server's monthly file upload quota (the attachments' one) has no room for these new bytes. */
  | { kind: "file_upload_quota_exceeded"; error: FileUploadQuotaExceededError };

/** Whether storeBlob counts new bytes against the monthly file upload quota (`count`, the default) or not (`exempt`: ops only). */
export type StoreBlobQuota = "count" | "exempt";

/** An exempt store's "reservation": unlimited and empty, so there is nothing to record, commit or release. */
const uncounted = (serverId: ServerId): FileUploadReservation => ({ serverId, month: "", bytes: 0, limited: false });

/** This server's ready blob of these bytes exists. */
async function isReady(serverId: ServerId, sha256: string): Promise<boolean> {
  return (await presentBlobs(serverId, [sha256])).has(sha256);
}

/** The quota a pending row holds, as recorded on it (none: nothing reserved). */
interface HeldQuota {
  serverId: ServerId;
  quotaMonth: string | null;
  quotaReservedBytes: number | null;
}

function heldReservation(row: HeldQuota): FileUploadReservation | null {
  if (row.quotaMonth === null || row.quotaReservedBytes === null) return null;
  return { serverId: row.serverId, month: row.quotaMonth, bytes: row.quotaReservedBytes, limited: true };
}

/** A transaction holding the quota lock of `month` (the month a row's reservation is in), where it is settled; none reserved: a plain one. */
function settling<T>(serverId: ServerId, month: string | null, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return month === null ? getDb().transaction(work) : withFileUploadQuotaLock(serverId, month, work);
}

/** A blob row storeBlob made (not one it found): its id, and its `created_at` exactly, as Postgres text. */
export interface BlobClaim {
  id: string;
  createdAt: string;
}

/** `created`: the row's `created_at` (as Postgres text) when this store inserted it, else null. */
type Claim =
  | Extract<StoreBlobOutcome, { kind: "quota_exceeded" }>
  | { kind: "write"; id: string; key: string; inserted: boolean; created: string | null; quotaMonth: string | null }
  | { kind: "ready" };

/**
 * Keep `bytes` (whose sha256 the caller has computed) as this server's blob.
 * The one place Artifacts stores new bytes: publish's inline files, the raw
 * upload route, and (on their branches) import and save-attachment all come
 * here.
 *
 * Bytes it already has are not written again; their row's age is reset, so
 * the sweep doesn't take them before the publish that is about to use them.
 * New bytes count against the cap on bytes no version uses yet; the check and
 * the insert hold the server's quota lock, so concurrent uploads can't both
 * pass it.
 *
 * New bytes also count against the server's monthly file upload quota, the
 * one attachments count against (platform/fileUploadQuota): reserved in the
 * transaction that inserts the pending row and recorded on it (no room:
 * `file_upload_quota_exceeded`, nothing stored), committed by the transaction
 * that makes the row ready, released by the one that deletes it (a failed
 * PUT here; an upload that never finished, by the sweep). A store that finds
 * the row already there (ready, or pending: another store's upload, which
 * holds the reservation for these bytes) gives back what it reserved in the
 * same transaction, so the bytes count once; one that finds it pending writes
 * the bytes too, and whichever store makes the row ready commits the row's
 * reservation. Bytes the server already has cost nothing.
 *
 * A second try only when the pending row the first wrote to was deleted
 * meanwhile (a concurrent store of the same bytes whose PUT failed removes
 * the row it made), so this store's good bytes go to a new row rather than
 * failing.
 *
 * `onClaim` hears of each row this store inserts, as soon as it is committed
 * (before the bytes are written, so also when writing them fails and storeBlob
 * deletes it again). The row's reservation is settled by whoever changes the
 * row: made ready, its bytes count as used this month (deleting the row later
 * gives nothing back, as deleting an attachment doesn't); deleted while
 * pending, its reservation is released in that transaction.
 *
 * `quota: "exempt"` (only the per-server move from the standalone app,
 * legacyBulkImport.ts through import.ts, an operator's migration and not a
 * person's upload): the new bytes are not counted against the monthly file
 * upload quota at all, as on a plan without one (nothing reserved, recorded
 * or committed; never `file_upload_quota_exceeded`). The cap on bytes no
 * version uses still applies.
 */
export async function storeBlob(
  store: ArtifactR2Store,
  serverId: ServerId,
  sha256: string,
  bytes: Buffer,
  opts: { onClaim?: (claim: BlobClaim) => void; quota?: StoreBlobQuota } = {},
): Promise<StoreBlobOutcome> {
  const quota = opts.quota ?? "count";
  const first = await storeBlobOnce(store, serverId, sha256, bytes, opts.onClaim, quota);
  if (first !== "row_gone") return first;
  const second = await storeBlobOnce(store, serverId, sha256, bytes, opts.onClaim, quota);
  if (second !== "row_gone") return second;
  throw new Error(`artifact blob of ${sha256} disappeared twice while its bytes were written`);
}

/** One try of storeBlob; "row_gone": the pending row it wrote to was deleted meanwhile. */
async function storeBlobOnce(
  store: ArtifactR2Store,
  serverId: ServerId,
  sha256: string,
  bytes: Buffer,
  onClaim: ((claim: BlobClaim) => void) | undefined,
  quota: StoreBlobQuota,
): Promise<StoreBlobOutcome | "row_gone"> {
  // Phase 1: claim the row. `reservation` null: none taken (the bytes looked
  // ready), so a missing row asks for one (null back).
  const claimIn = async (tx: DatabaseTransaction, reservation: FileUploadReservation | null): Promise<Claim | null> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact-upload-quota:${serverId}`}))`);
    const [existing] = await tx.select({ id: artifactBlobs.id, state: artifactBlobs.state, r2Key: artifactBlobs.r2Key, quotaMonth: artifactBlobs.quotaMonth })
      .from(artifactBlobs).where(r2BlobOf(serverId, sha256)).limit(1).for("update");
    if (existing) {
      await tx.update(artifactBlobs).set({ createdAt: sql`now()` }).where(eq(artifactBlobs.id, existing.id));
      // Ready: nothing new. Pending: the row's own reservation covers these bytes.
      if (reservation) await releaseFileUploadInTransaction(tx, reservation);
      // A pending row is an upload that may never finish: write the bytes again (to its key).
      return existing.state === "ready"
        ? { kind: "ready" }
        : { kind: "write", id: existing.id, key: existing.r2Key, inserted: false, created: null, quotaMonth: existing.quotaMonth };
    }
    if (!reservation) return null;
    const used = await unreferencedBytes(serverId, tx);
    if (used + bytes.length > AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES) {
      await releaseFileUploadInTransaction(tx, reservation);
      return { kind: "quota_exceeded", used, limit: AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES };
    }
    const id = `b_${randomUUID()}`;
    const key = r2KeyOf(serverId, sha256, id);
    const held = reservation.limited && reservation.bytes > 0;
    const quotaMonth = held ? reservation.month : null;
    const [row] = await tx.insert(artifactBlobs).values({
      id, serverId, sha256, sizeBytes: bytes.length, state: "pending", r2Key: key,
      quotaMonth, quotaReservedBytes: held ? reservation.bytes : null,
    }).returning({ createdAt: sql<string>`${artifactBlobs.createdAt}::text` });
    return { kind: "write", id, key, inserted: true, created: row!.createdAt, quotaMonth };
  };

  // Bytes the server has don't reserve (and aren't refused, however full the month is).
  let claim = (await isReady(serverId, sha256)) ? await getDb().transaction((tx) => claimIn(tx, null)) : null;
  // Exempt: the claim as on a plan without a quota, nothing held.
  if (!claim && quota === "exempt") claim = (await getDb().transaction((tx) => claimIn(tx, uncounted(serverId))))!;
  if (!claim) {
    // No row (or the ready row seen above was swept before the claim): these bytes are new.
    try {
      claim = (await reserveFileUpload(serverId, bytes.length, (tx, reservation) => claimIn(tx, reservation)))!;
    } catch (error) {
      if (error instanceof FileUploadQuotaExceededError) return { kind: "file_upload_quota_exceeded", error };
      throw error;
    }
  }
  if (claim.kind === "quota_exceeded") return claim;
  if (claim.kind === "ready") return { kind: "stored" };
  const { id, key, quotaMonth } = claim;
  if (claim.created !== null) onClaim?.({ id, createdAt: claim.created });

  // Phase 2: the bytes, outside any transaction.
  try {
    await store.put(key, bytes);
  } catch (error) {
    // The row this store made goes, and its reservation with it, together.
    // A row it found pending is another upload's, left to it or the sweep.
    if (claim.inserted) {
      const removed = await settling(serverId, quotaMonth, async (tx) => {
        const [row] = await tx.delete(artifactBlobs).where(and(eq(artifactBlobs.id, id), eq(artifactBlobs.state, "pending")))
          .returning({ serverId: artifactBlobs.serverId, quotaMonth: artifactBlobs.quotaMonth, quotaReservedBytes: artifactBlobs.quotaReservedBytes });
        const held = row ? heldReservation(row) : null;
        if (held) await releaseFileUploadInTransaction(tx, held);
        return row !== undefined;
      });
      // A concurrent store of the same bytes may have written them to this
      // key; with the row gone nothing reads it (that store retries on a new
      // row). Best effort: a failed delete is only a leaked object.
      if (removed) await store.delete(key).catch(() => {});
    }
    throw error;
  }

  // Phase 3: ready, and the row's reservation committed, in one transaction.
  // A concurrent store of the same bytes that got there first leaves it
  // ready (and committed): stored. No row: deleted meanwhile, by a concurrent
  // store of these bytes whose PUT failed (or, practically never, by the
  // sweep: phase 1 just reset created_at, and R2 requests time out, 30 s, far
  // under its one-day age); storeBlob tries once more, with a new row.
  const outcome = await settling(serverId, quotaMonth, async (tx) => {
    const [row] = await tx.select({ serverId: artifactBlobs.serverId, state: artifactBlobs.state, quotaMonth: artifactBlobs.quotaMonth, quotaReservedBytes: artifactBlobs.quotaReservedBytes })
      .from(artifactBlobs).where(eq(artifactBlobs.id, id)).for("update");
    if (!row) return "row_gone" as const;
    if (row.state === "pending") {
      await tx.update(artifactBlobs).set({ state: "ready", quotaMonth: null, quotaReservedBytes: null }).where(eq(artifactBlobs.id, id));
      const held = heldReservation(row);
      if (held) await commitFileUploadInTransaction(tx, held);
    }
    return "stored" as const;
  });
  return outcome === "row_gone" ? outcome : { kind: "stored" };
}

/**
 * Delete at once the rows `claims` names (storeBlob made them) that no version
 * uses, and their objects: a failed import's bytes, so they don't hold the
 * server's upload cap for a day. A row whose `created_at` moved since (another
 * upload of the same bytes refreshed it: it is theirs too now) or that a
 * publish holds (FOR KEY SHARE, as the sweep skips it) is left to the sweep.
 *
 * The monthly file upload quota, as the sweep settles it: a row still pending
 * gives its recorded reservation back in the transaction that deletes it,
 * holding that month's quota lock; a ready row's bytes were committed (used
 * this month) and stay counted, as a deleted attachment's do. Rows first,
 * then objects after commit (a failed object delete is a leaked object, never
 * a row without bytes). Returns how many rows were deleted.
 */
export async function deleteClaimedBlobs(store: ArtifactR2Store, serverId: ServerId, claims: readonly BlobClaim[]): Promise<number> {
  if (claims.length === 0) return 0;
  const createdAtOf = new Map(claims.map((claim) => [claim.id, claim.createdAt]));
  const candidates = await getDb().select({ id: artifactBlobs.id, quotaMonth: artifactBlobs.quotaMonth }).from(artifactBlobs)
    .where(and(eq(artifactBlobs.serverId, serverId), inArray(artifactBlobs.id, [...createdAtOf.keys()])));
  // One transaction per month a pending row's reservation is in, one for the rest (ready rows, or none held).
  const groups = new Map<string | null, string[]>();
  for (const row of candidates) groups.set(row.quotaMonth, [...(groups.get(row.quotaMonth) ?? []), row.id]);
  const deleted: { id: string; r2Key: string }[] = [];
  for (const [month, ids] of groups) {
    deleted.push(...await settling(serverId, month, async (tx) => {
      const rows = await tx.select({ id: artifactBlobs.id, createdAt: sql<string>`${artifactBlobs.createdAt}::text` }).from(artifactBlobs)
        .where(and(eq(artifactBlobs.serverId, serverId), inArray(artifactBlobs.id, ids), noVersionUses()))
        .for("update", { skipLocked: true });
      const ours = rows.filter((row) => createdAtOf.get(row.id) === row.createdAt).map((row) => row.id);
      if (ours.length === 0) return [];
      // The reservation checked again on the locked rows: one settled meanwhile (made ready) is not this group's.
      const gone = await tx.delete(artifactBlobs)
        .where(and(
          inArray(artifactBlobs.id, ours),
          noVersionUses(),
          month === null ? isNull(artifactBlobs.quotaMonth) : eq(artifactBlobs.quotaMonth, month),
        ))
        .returning({ id: artifactBlobs.id, r2Key: artifactBlobs.r2Key, quotaReservedBytes: artifactBlobs.quotaReservedBytes });
      const reservedBytes = gone.reduce((sum, row) => sum + (row.quotaReservedBytes ?? 0), 0);
      if (month !== null && reservedBytes > 0) await releaseFileUploadInTransaction(tx, { serverId, month, bytes: reservedBytes, limited: true });
      return gone;
    }));
  }
  await deleteObjects(store, deleted);
  return deleted.length;
}

/**
 * In a purge's transaction (purge.ts purgeArtifact), after the purged
 * Artifact's versions went: delete the rows of `blobIds` (its versions'
 * blobs, of `serverId`) that no version uses now, so bytes another of the
 * server's Artifacts still has (blobs are per server and sha256) stay. A row
 * a publish holds (FOR KEY SHARE: it is about to be used) is skipped and
 * stays, as the sweep skips it; so is a pending one (never a version's).
 * Checked again on the locked rows, as the sweep does. Answers the rows that
 * went; their objects are the caller's to delete after the commit.
 */
export async function deleteUnusedBlobsOf(tx: DatabaseExecutor, serverId: ServerId, blobIds: readonly string[]): Promise<Array<{ id: string; r2Key: string; sizeBytes: number }>> {
  if (blobIds.length === 0) return [];
  const unused = () => and(eq(artifactBlobs.serverId, serverId), inArray(artifactBlobs.id, [...blobIds]), eq(artifactBlobs.state, "ready"), noVersionUses())!;
  const locked = await tx.select({ id: artifactBlobs.id }).from(artifactBlobs).where(unused()).for("update", { skipLocked: true });
  if (locked.length === 0) return [];
  return tx.delete(artifactBlobs)
    .where(and(unused(), inArray(artifactBlobs.id, locked.map((row) => row.id))))
    .returning({ id: artifactBlobs.id, r2Key: artifactBlobs.r2Key, sizeBytes: artifactBlobs.sizeBytes });
}

async function deleteObjects(store: ArtifactR2Store, blobs: readonly { id: string; r2Key: string }[]): Promise<void> {
  for (const blob of blobs) {
    try {
      await store.delete(blob.r2Key);
    } catch (error) {
      // The row is gone, so nothing reads this object again: a leak, not a loss.
      console.warn("[Artifacts] could not delete an unreferenced blob's object", { blobId: blob.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Delete r2 blobs no version uses (and unfinished uploads) older than the TTL,
 * a bounded batch per call: rows first, then their objects. A pending row's
 * reservation of the monthly file upload quota is given back in the
 * transaction that deletes it, holding that month's quota lock: one
 * transaction per (server, month) with such rows, one for the rest.
 * Returns how many rows were deleted. A no-op when R2 isn't configured.
 */
export async function pruneUnreferencedArtifactBlobs(opts: {
  now?: Date;
  batch?: number;
  store?: ArtifactR2Store | null;
} = {}): Promise<number> {
  const store = opts.store === undefined ? artifactR2Store() : opts.store;
  if (!store) return 0;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - UNREFERENCED_BLOB_TTL_MS);
  const stale = () => and(lt(artifactBlobs.createdAt, cutoff), or(eq(artifactBlobs.state, "pending"), noVersionUses()))!;
  const candidates = await getDb().select({ id: artifactBlobs.id, serverId: artifactBlobs.serverId, quotaMonth: artifactBlobs.quotaMonth })
    .from(artifactBlobs)
    .where(stale())
    .orderBy(asc(artifactBlobs.createdAt))
    .limit(opts.batch ?? PRUNE_BATCH);
  const groups = new Map<string, { serverId: ServerId; month: string | null; ids: string[] }>();
  for (const row of candidates) {
    const groupKey = row.quotaMonth === null ? "" : `${row.serverId}/${row.quotaMonth}`;
    const group = groups.get(groupKey) ?? { serverId: row.serverId, month: row.quotaMonth, ids: [] };
    group.ids.push(row.id);
    groups.set(groupKey, group);
  }
  const deleted: { id: string; r2Key: string }[] = [];
  for (const group of groups.values()) {
    deleted.push(...await settling(group.serverId, group.month, async (tx) => {
      const locked = await tx.select({ id: artifactBlobs.id }).from(artifactBlobs)
        .where(and(inArray(artifactBlobs.id, group.ids), stale()))
        .for("update", { skipLocked: true });
      if (locked.length === 0) return [];
      // Checked again on the locked rows: a publish may commit a version_files
      // row using a candidate after the candidate query's snapshot but before
      // this lock was granted; this statement's fresh snapshot sees it, and no
      // reference can be added while the lock is held. That window isn't
      // deterministically testable (no hook between the two statements);
      // publish.realPg.test.ts covers the locked case (SKIP LOCKED). The
      // reservation is checked again too: one committed meanwhile (the row
      // made ready, its columns cleared) is skipped, not given back.
      const rows = await tx.delete(artifactBlobs)
        .where(and(
          inArray(artifactBlobs.id, locked.map((row) => row.id)),
          stale(),
          group.month === null
            ? isNull(artifactBlobs.quotaMonth)
            : and(eq(artifactBlobs.serverId, group.serverId), eq(artifactBlobs.quotaMonth, group.month)),
        ))
        .returning({ id: artifactBlobs.id, r2Key: artifactBlobs.r2Key, quotaReservedBytes: artifactBlobs.quotaReservedBytes });
      const reservedBytes = rows.reduce((sum, row) => sum + (row.quotaReservedBytes ?? 0), 0);
      if (group.month !== null && reservedBytes > 0) {
        await releaseFileUploadInTransaction(tx, { serverId: group.serverId, month: group.month, bytes: reservedBytes, limited: true });
      }
      return rows;
    }));
  }
  await deleteObjects(store, deleted);
  return deleted.length;
}

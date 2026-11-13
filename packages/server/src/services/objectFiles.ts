// Core's object files (docs/development/first-party-apps.md, "Object files"):
// the files of first-party objects, read by whoever may fully see the object
// and deleted with what they hang on. An object of a registered kind (an
// Artifact) is what people are allowed to see; its parts (an Artifact's versions, its comments) are the app's and
// have no permissions of their own. A file is bytes and the type core
// detected in them, kept for one object and hung on one of its app's parts
// (`parent`, the app's opaque `<part>:<id>`, such as `version:<id>`). Core
// stores it, serves it to whoever can see the object now
// (routes/objects.ts), and deletes it with whatever it hangs on. Apps reach
// this through platform/objectFiles; the bytes, keys and storage stay core's.
//
// - putObjectFile: the type from the bytes alone (PNG, JPEG, WebP or GIF;
//   never SVG, HTML or anything a browser would run), at most
//   OBJECT_FILE_MAX_BYTES, its pixel size from its header (at most
//   OBJECT_FILE_MAX_PIXELS, refused before anything is decoded) and its
//   metadata removed (objectFileImages.ts). What people and agents upload
//   (`quota: "monthly"`) is billed to the server the caller names (the
//   uploader's own: a joint channel's member of another server pays on their
//   own server, never the object's), fixed on the row (`billed_server_id`):
//   counted against that server's total (OBJECT_FILES_MAX_BYTES_PER_SERVER),
//   the uploader's share of it (OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER of
//   drafts at once, OBJECT_FILES_MAX_BYTES_PER_UPLOADER in all) and its
//   monthly file upload quota (attachments' one). What the platform makes
//   (`exempt`: a publish check's screenshots, bounded by the checks) is the
//   object's server's, under none of these, and reported apart
//   (objectFilesUsage). The bytes are written first, then the row: a row
//   never names bytes that aren't there.
//   A file put without a parent is an unclaimed draft (an image pasted into
//   a comment not yet posted), readable only by its uploader until
//   claimObjectFile hangs it on a part.
// - A file hung on a `draft:<id>` part (an app's draft of a part, such as a
//   review draft's comment) is a draft too: read only by its uploader, like
//   an unclaimed one, until moveObjectFiles hangs it on the posted part.
// - deleteObjectFiles runs in the app's transaction, beside the delete of
//   the part or object: the rows become `deleted` there (no read finds them
//   from then on) and go back with a rollback. deleteObjectFileBytes, once
//   that transaction committed, deletes their bytes, then the rows. A byte
//   delete that fails is counted (slock_object_file_byte_deletes_total) and
//   its row stays `deleted` for the hourly sweep, so no bytes outlive every
//   record of them.
// - sweepObjectFiles (the hourly maintenance): lets go of drafts unclaimed
//   for OBJECT_FILE_UNCLAIMED_TTL_MS (giving their bytes back to the month of
//   the monthly quota that counted them, once, in the same transaction) and
//   of a soft-deleted server's files (servers are only ever soft-deleted,
//   without asking anyone), then deletes the bytes of `deleted` rows: batches
//   until none are left or SWEEP_BUDGET_MS passed, each batch's rows taken
//   so that two instances sweeping at once never take the same ones.
//
// Not covered: bytes whose row was never written (putObjectFile's insert
// failed and so did the delete after it, or the app's transaction that held
// the insert rolled back) are a leaked object; nothing lists the bucket.
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { asObjectFileId, type ObjectFileId, type ServerId } from "@botiverse/raft-shared";
import { registeredObjectKind } from "../apps/firstPartyApps";
import { isInTransaction } from "../db/ambientTransaction";
import { getDb, type DatabaseExecutor } from "../db/index";
import { objectFiles, servers, type ObjectFileContentType } from "../db/schema";
import { objectFileByteDeletesTotal } from "../metrics";
import type { AppActor } from "../platform/apps";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { AppObjectStorageUnavailableError, objectFilesStorage, type AppObjectStorage } from "./appObjectStorage";
import {
  billingUsageMonth,
  finalizeFileUploadQuotaReservationWith,
  refundFileUploadQuotaWith,
  releaseFileUploadQuotaReservation,
  reserveFileUploadQuota,
  type FileUploadQuotaReservation,
} from "./fileUploadQuotaService";
import { ImageRefusedError, keptImage, OBJECT_FILE_MAX_PIXELS } from "./objectFileImages";
import { fullyVisibleObjectsOf } from "./objectSummaries";
import type { ServerViewActor } from "./visibilityService";

/** The largest file core stores. */
export const OBJECT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * All the uploads billed to a server together (the rows not yet purged,
 * `deleted` ones included; the platform's own files are not counted).
 */
export const OBJECT_FILES_MAX_BYTES_PER_SERVER = 5 * 1024 * 1024 * 1024;
/**
 * One uploader's drafts at once on the server billed for them: unclaimed
 * uploads and files on a `draft:` part. Posting or deleting a draft frees room.
 */
export const OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER = 100 * 1024 * 1024;
/** All of one uploader's uploads on the server billed for them (not `deleted`). */
export const OBJECT_FILES_MAX_BYTES_PER_UPLOADER = 1024 * 1024 * 1024;
/** How long a file may stay unclaimed before the sweep lets go of it. */
export const OBJECT_FILE_UNCLAIMED_TTL_MS = 60 * 60 * 1000;
export { OBJECT_FILE_MAX_PIXELS };
/**
 * The part name of a draft (`draft:<id>`): a file hung on one is read only by
 * its uploader, as an unclaimed one is, whoever else sees the object.
 */
export const OBJECT_FILE_DRAFT_PART = "draft";
const SWEEP_BATCH = 500;
/** How long one sweep keeps taking batches. */
const SWEEP_BUDGET_MS = 30_000;
/**
 * How far a purge's claim moves a `deleted` row's deleted_at ahead: a lease,
 * so another instance's sweep skips the rows whose bytes this one is
 * deleting; a row whose bytes failed to go comes back once it passes.
 */
const PURGE_LEASE_MS = 10 * 60 * 1000;

/** A part reference: the app's part name, a colon, its id (`version:v_…`, `comment:c_…`). */
const PARENT = /^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9._~-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The object a file belongs to: a registered kind and the app's id of one of its objects. */
export interface ObjectFileObject {
  kind: string;
  id: string;
}

export type ObjectFileRefusalReason =
  | "object_not_found"
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "too_many_pixels"
  | "server_quota_exceeded"
  | "uploader_quota_exceeded";

/** Which of an uploader's limits an `uploader_quota_exceeded` refusal hit. */
export type ObjectFileUploaderLimit = "drafts" | "total";

/**
 * A file core won't store: no such live object (the kind's homes leave it
 * out), empty, over OBJECT_FILE_MAX_BYTES (`details.limit`; as sent, or as
 * kept once its metadata is removed), not one of the image types core keeps
 * (by its first bytes, or a header or pixels that don't parse), more pixels
 * than OBJECT_FILE_MAX_PIXELS by its header (`details.limit`), over the
 * billed server's total (`server_quota_exceeded`: `details.used`,
 * `details.limit`), or over the uploader's share of it
 * (`uploader_quota_exceeded`: `details.scope` `drafts` or `total`, with
 * `used` and `limit`). Nothing is stored.
 */
export class ObjectFileRefusedError extends Error {
  constructor(readonly reason: ObjectFileRefusalReason, message: string, readonly details: { limit?: number; used?: number; scope?: ObjectFileUploaderLimit } = {}) {
    super(message);
    this.name = "ObjectFileRefusedError";
  }
}

/** A stored file, as the app keeps it: its id and what core found in what it kept. */
export interface StoredObjectFile {
  id: ObjectFileId;
  contentType: ObjectFileContentType;
  sizeBytes: number;
  /** Its pixel size, from its header; null only for a file stored before core read it. */
  width: number | null;
  height: number | null;
}

/** A file putObjectFile just stored: its pixel size is always known. */
export type PutObjectFile = StoredObjectFile & { width: number; height: number };

/** What deleteObjectFiles let go, for deleteObjectFileBytes after the commit. Ids only: keys never leave core. */
export interface DeletedObjectFiles {
  readonly fileIds: readonly ObjectFileId[];
}

// ---- storage -----------------------------------------------------------------------

const coreStorage = objectFilesStorage();
let storageOverride: AppObjectStorage | null = null;
const storage = (): AppObjectStorage => storageOverride ?? coreStorage;

/** Tests: keep object files in `next` (an unconfigured one: storage missing); undefined goes back to the bucket. */
export function __setObjectFilesStorageForTests(next: AppObjectStorage | undefined): void {
  storageOverride = next ?? null;
}

/** A file's key, relative to core's `objects/` prefix: per server and per row. */
const keyOf = (serverId: ServerId, fileId: string): string => `servers/${serverId}/files/${fileId}`;

// ---- checks ------------------------------------------------------------------------

/** The type of these bytes by their first bytes, if core keeps that type; null for anything else (SVG and HTML included). */
export function sniffObjectFileType(bytes: Buffer): ObjectFileContentType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** An app's part reference, or a thrown error: a malformed one is the app's bug, not a request's. */
function checkedParent(parent: string): string {
  if (!PARENT.test(parent)) throw new Error(`object files: ${JSON.stringify(parent)} is not a part reference (<part>:<id>)`);
  return parent;
}

function registeredKindOf(kind: string) {
  const registered = registeredObjectKind(kind);
  if (!registered) throw new Error(`object files: ${JSON.stringify(kind)} is not a registered object kind`);
  return registered;
}

/**
 * The rows billed to `serverId`: coalesce(billed_server_id, server_id) =
 * serverId, written as two arms so each can use a plain index. Keep the
 * fallback: a row from before billed_server_id, or one an older build writes
 * during a rolling deploy, has none and is its object's server's.
 */
const billedTo = (serverId: ServerId): SQL =>
  or(eq(objectFiles.billedServerId, serverId), and(isNull(objectFiles.billedServerId), eq(objectFiles.serverId, serverId)))!;
/** An upload (not the platform's own file); a row from before `quota` counts as one. */
const isUpload = sql`${objectFiles.quota} IS DISTINCT FROM 'exempt'`;
/** A draft only its uploader reads: unclaimed, or on a `draft:` part (isDraft, below). */
const isDraftRow = sql`(${objectFiles.state} = 'unclaimed' OR (${objectFiles.state} = 'claimed' AND ${objectFiles.parent} LIKE ${`${OBJECT_FILE_DRAFT_PART}:%`}))`;
const bytesWhere = (condition: SQL) => sql<string>`coalesce(sum(${objectFiles.sizeBytes}) FILTER (WHERE ${condition}), 0)`;

/** What the caps read, of the uploads billed to a server. */
interface BilledUsage {
  /** Every upload billed to the server (every state: a deleted row's bytes are there until purged). */
  server: number;
  /** The uploader's own there, not `deleted`. */
  uploaderTotal: number;
  /** The uploader's drafts there (unclaimed, or on a `draft:` part). */
  uploaderDrafts: number;
}

/** One read of the uploads billed to `serverId`: the server's total and `uploader`'s share. */
async function billedUsage(executor: DatabaseExecutor, serverId: ServerId, uploader: AppActor): Promise<BilledUsage> {
  const theirs = and(eq(objectFiles.uploadedByType, uploader.type), eq(objectFiles.uploadedById, uploader.id))!;
  const [row] = await executor.select({
    server: bytesWhere(isUpload),
    uploaderTotal: bytesWhere(and(isUpload, theirs, ne(objectFiles.state, "deleted"))!),
    uploaderDrafts: bytesWhere(and(isUpload, theirs, isDraftRow)!),
  }).from(objectFiles).where(billedTo(serverId));
  return { server: Number(row?.server ?? 0), uploaderTotal: Number(row?.uploaderTotal ?? 0), uploaderDrafts: Number(row?.uploaderDrafts ?? 0) };
}

const overQuota = (used: number) =>
  new ObjectFileRefusedError("server_quota_exceeded", "the server's object files are full", { used, limit: OBJECT_FILES_MAX_BYTES_PER_SERVER });
const MIB = 1024 * 1024;
const overUploaderLimit = (scope: ObjectFileUploaderLimit, used: number) => scope === "drafts"
  ? new ObjectFileRefusedError(
    "uploader_quota_exceeded",
    `You already have ${Math.floor(used / MIB)} MB of images waiting in drafts or unposted on this server, and the limit is ${OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER / MIB} MB. Posting or deleting drafts frees room (an image no comment takes goes after an hour).`,
    { scope, used, limit: OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER },
  )
  : new ObjectFileRefusedError(
    "uploader_quota_exceeded",
    `Your images on this server have reached the limit of ${OBJECT_FILES_MAX_BYTES_PER_UPLOADER / MIB / 1024} GB per person. Deleting drafts or comments with images frees room.`,
    { scope, used, limit: OBJECT_FILES_MAX_BYTES_PER_UPLOADER },
  );

/** The first cap `size` more bytes would pass (the server's total, the uploader's total, their drafts when it is one), or null. */
function capRefusal(usage: BilledUsage, size: number, draft: boolean): ObjectFileRefusedError | null {
  if (usage.server + size > OBJECT_FILES_MAX_BYTES_PER_SERVER) return overQuota(usage.server);
  if (usage.uploaderTotal + size > OBJECT_FILES_MAX_BYTES_PER_UPLOADER) return overUploaderLimit("total", usage.uploaderTotal);
  if (draft && usage.uploaderDrafts + size > OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER) return overUploaderLimit("drafts", usage.uploaderDrafts);
  return null;
}
const tooLarge = () => new ObjectFileRefusedError("too_large", `the file is larger than ${OBJECT_FILE_MAX_BYTES} bytes`, { limit: OBJECT_FILE_MAX_BYTES });

/** What a file's row answers to the app (StoredObjectFile). */
const storedColumns = {
  id: objectFiles.id,
  contentType: objectFiles.contentType,
  sizeBytes: objectFiles.sizeBytes,
  width: objectFiles.width,
  height: objectFiles.height,
};
const storedOf = (row: { id: string; contentType: ObjectFileContentType; sizeBytes: number; width: number | null; height: number | null }): StoredObjectFile =>
  ({ id: asObjectFileId(row.id), contentType: row.contentType, sizeBytes: row.sizeBytes, width: row.width, height: row.height });

// ---- writes ------------------------------------------------------------------------

/**
 * Who pays for a file: what a person or an agent uploads (`monthly`) is
 * billed to `billedTo`, the uploader's own server (the one the request
 * stands in: a joint channel's member of another server is billed there,
 * never the object's server); what the platform makes itself (`exempt`: a
 * publish check's screenshots) is the object's own server's.
 */
export type ObjectFileBilling =
  | { quota: "monthly"; billedTo: ServerId }
  | { quota: "exempt" };

/**
 * Store `bytes` as a file of `object`: claimed by `parent` at once, or
 * unclaimed (null: a draft only `uploadedBy` reads, until claimObjectFile).
 * In this order, nothing stored on a refusal (ObjectFileRefusedError): the
 * size as sent, the type from the first bytes, the object (its kind's homes),
 * AppObjectStorageUnavailableError without the platform's bucket; then the
 * image (objectFileImages.ts keptImage): its pixel size from the header,
 * refused over OBJECT_FILE_MAX_PIXELS before any pixel is decoded, then its
 * metadata removed (what is stored, measured and answered is the image as
 * kept, at most OBJECT_FILE_MAX_BYTES too).
 *
 * `quota: "monthly"` (whatever a person or an agent uploads) then bills the
 * kept bytes to `billedTo` (ObjectFileBilling; a server that isn't live is
 * the caller's bug, never charged to the object's server instead): its
 * total (OBJECT_FILES_MAX_BYTES_PER_SERVER, `server_quota_exceeded`), the
 * uploader's share there (OBJECT_FILES_MAX_BYTES_PER_UPLOADER, and
 * OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER for a draft:
 * `uploader_quota_exceeded`), each checked before the bytes are written and
 * again under the billed server's lock beside the insert; and its monthly
 * file upload quota, the attachments' one, reserved before the bytes are
 * written and counted in the insert's transaction (FileUploadQuotaExceededError
 * when they don't fit, nothing stored; given back on any failure). The row
 * records the month that counted them (`quota_month`) for the sweep's refund.
 * `exempt` is under none of these.
 *
 * The row goes in `executor` when given (a savepoint there), else in a
 * transaction of its own; the bytes are written before, outside it, so don't
 * hold a transaction across this unless the row must commit with yours. A
 * row that can't be written takes its bytes back.
 */
export async function putObjectFile(input: {
  object: ObjectFileObject;
  parent: string | null;
  bytes: Buffer;
  uploadedBy: AppActor;
  executor?: DatabaseExecutor;
} & ObjectFileBilling): Promise<PutObjectFile> {
  const { object, uploadedBy } = input;
  const registered = registeredKindOf(object.kind);
  const parent = input.parent === null ? null : checkedParent(input.parent);
  if (input.bytes.length === 0) throw new ObjectFileRefusedError("empty", "the file is empty");
  if (input.bytes.length > OBJECT_FILE_MAX_BYTES) throw tooLarge();
  const contentType = sniffObjectFileType(input.bytes);
  if (contentType === null) throw new ObjectFileRefusedError("unsupported_type", "the file is not a PNG, JPEG, WebP or GIF image");
  // The object's own server, as its kind reports it: the file is kept there (its key, its deletion with the server).
  const home = (await registered.objectKind.homes([object.id])).get(object.id);
  if (!home) throw new ObjectFileRefusedError("object_not_found", "no such object");
  const handle = storage();
  if (!handle.configured) throw new AppObjectStorageUnavailableError();
  // The header first (a refusal here decodes nothing), then the image without its metadata.
  let kept: Awaited<ReturnType<typeof keptImage>>;
  try {
    kept = await keptImage(input.bytes, contentType);
  } catch (error) {
    if (!(error instanceof ImageRefusedError)) throw error;
    throw error.reason === "too_many_pixels"
      ? new ObjectFileRefusedError("too_many_pixels", `the image has more than ${OBJECT_FILE_MAX_PIXELS} pixels`, { limit: OBJECT_FILE_MAX_PIXELS })
      : new ObjectFileRefusedError("unsupported_type", "the file is not a PNG, JPEG, WebP or GIF image that can be read");
  }
  const { bytes, width, height } = kept;
  if (bytes.length > OBJECT_FILE_MAX_BYTES) throw tooLarge();
  const executor = input.executor ?? getDb();
  const serverId = home.serverId;
  const counted = input.quota === "monthly";
  const billedServerId = input.quota === "monthly" ? input.billedTo : serverId;
  if (billedServerId !== serverId) await requireLiveServer(executor, billedServerId);
  const draft = parent === null || parent.startsWith(`${OBJECT_FILE_DRAFT_PART}:`);
  // A first look without the lock, so bytes over a cap are never written.
  if (counted) {
    const refusal = capRefusal(await billedUsage(executor, billedServerId, uploadedBy), bytes.length, draft);
    if (refusal) throw refusal;
  }

  // Reserved before the bytes are written, counted with the row, given back on any failure (as attachments').
  const reservation: FileUploadQuotaReservation | null = counted ? await reserveFileUploadQuota(billedServerId, bytes.length) : null;
  const id = randomUUID();
  const storageKey = keyOf(serverId, id);
  let written = false;
  try {
    await handle.put(storageKey, bytes, contentType);
    written = true;
    await executor.transaction(async (tx) => {
      if (counted) {
        // The billed server's lock: its total and each uploader's share are re-read under it.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`object-files-quota:${billedServerId}`}))`);
        const refusal = capRefusal(await billedUsage(tx, billedServerId, uploadedBy), bytes.length, draft);
        if (refusal) throw refusal;
      }
      await tx.insert(objectFiles).values({
        id,
        serverId,
        billedServerId,
        quota: input.quota,
        quotaMonth: reservation?.limited ? reservation.month : null,
        objectKind: object.kind,
        objectId: object.id,
        parent,
        state: parent === null ? "unclaimed" : "claimed",
        uploadedByType: uploadedBy.type,
        uploadedById: uploadedBy.id,
        contentType,
        sizeBytes: bytes.length,
        width,
        height,
        storageKey,
      });
      if (reservation) await finalizeFileUploadQuotaReservationWith(tx, reservation);
    });
  } catch (error) {
    // No row names these bytes. Best effort: a failed delete is a leaked object.
    if (written) {
      await handle.delete(storageKey).catch((deleteError: unknown) => {
        console.warn("[object-files] could not delete the bytes of a file whose row was not written", { error: serializeErrorForLog(deleteError) });
      });
    }
    if (reservation) await releaseFileUploadQuotaReservation(reservation);
    throw error;
  }
  return { id: asObjectFileId(id), contentType, sizeBytes: bytes.length, width, height };
}

/** A billed server must be one that is there (servers are only ever soft-deleted); anything else is the caller's bug, never billed to the object's server instead. */
async function requireLiveServer(executor: DatabaseExecutor, serverId: ServerId): Promise<void> {
  const [row] = await executor.select({ id: servers.id }).from(servers).where(and(eq(servers.id, serverId), isNull(servers.deletedAt))).limit(1);
  if (!row) throw new Error(`object files: the billed server ${serverId} is not a live server`);
}

/**
 * A server's object files by what they are, for a usage report: the uploads
 * billed to it (what OBJECT_FILES_MAX_BYTES_PER_SERVER counts, `limitBytes`)
 * and the platform's own files of its objects (a publish check's
 * screenshots: under no cap, reported apart). Every state: a deleted row's
 * bytes are there until purged.
 */
export async function objectFilesUsage(serverId: ServerId, executor: DatabaseExecutor = getDb()): Promise<{ uploadedBytes: number; platformBytes: number; limitBytes: number }> {
  const [row] = await executor.select({
    uploaded: bytesWhere(isUpload),
    platform: bytesWhere(sql`${objectFiles.quota} = 'exempt'`),
  }).from(objectFiles).where(billedTo(serverId));
  return { uploadedBytes: Number(row?.uploaded ?? 0), platformBytes: Number(row?.platform ?? 0), limitBytes: OBJECT_FILES_MAX_BYTES_PER_SERVER };
}

/**
 * Hang the unclaimed file `fileId` on `parent`: only a file of `object`,
 * still unclaimed, that `by` uploaded. Its stored metadata (what core found
 * in what it kept, never the uploader's word); null, and nothing changed, for
 * anything else (no such file, another object's, another uploader's, already
 * claimed or let go). Pass the app's transaction so the claim commits with
 * the part it hangs the file on.
 */
export async function claimObjectFile(input: {
  object: ObjectFileObject;
  fileId: string;
  parent: string;
  by: AppActor;
  executor?: DatabaseExecutor;
}): Promise<StoredObjectFile | null> {
  const parent = checkedParent(input.parent);
  if (!UUID.test(input.fileId) || !UUID.test(input.by.id)) return null;
  const [claimed] = await (input.executor ?? getDb()).update(objectFiles)
    .set({ parent, state: "claimed" })
    .where(and(
      eq(objectFiles.id, input.fileId),
      eq(objectFiles.objectKind, input.object.kind),
      eq(objectFiles.objectId, input.object.id),
      eq(objectFiles.state, "unclaimed"),
      eq(objectFiles.uploadedByType, input.by.type),
      eq(objectFiles.uploadedById, input.by.id),
    ))
    .returning(storedColumns);
  return claimed ? storedOf(claimed) : null;
}

/**
 * Hang every file of `object` on the part `from` on the part `to` instead
 * (a draft's files on the part it was posted as: `draft:<id>` to
 * `comment:<id>`), in the app's transaction (`executor`), beside the write
 * of `to`: only claimed files whose parent is exactly `from`, of this object
 * only; who uploaded them and everything else stays. Answers what moved
 * (none: an empty list).
 */
export async function moveObjectFiles(input: {
  object: ObjectFileObject;
  from: string;
  to: string;
  executor: DatabaseExecutor;
}): Promise<StoredObjectFile[]> {
  const from = checkedParent(input.from);
  const to = checkedParent(input.to);
  const moved = await input.executor.update(objectFiles)
    .set({ parent: to })
    .where(and(
      eq(objectFiles.objectKind, input.object.kind),
      eq(objectFiles.objectId, input.object.id),
      eq(objectFiles.state, "claimed"),
      eq(objectFiles.parent, from),
    ))
    .returning(storedColumns);
  return moved.map(storedOf);
}

/**
 * Let go of `object`'s files, in the app's transaction (`executor`), beside
 * the delete of what they hang on: those of `parent` (one part or several),
 * or every file of the object (the object itself is going). From then on no
 * read finds them; a rollback keeps them. Once the transaction committed,
 * hand the answer to deleteObjectFileBytes.
 */
export async function deleteObjectFiles(input: {
  object: ObjectFileObject;
  parent?: string | readonly string[];
  executor: DatabaseExecutor;
}): Promise<DeletedObjectFiles> {
  const parents = input.parent === undefined ? null : (typeof input.parent === "string" ? [input.parent] : [...input.parent]).map(checkedParent);
  if (parents !== null && parents.length === 0) return { fileIds: [] };
  const rows = await input.executor.update(objectFiles)
    .set({ state: "deleted", deletedAt: sql`now()` })
    .where(and(
      eq(objectFiles.objectKind, input.object.kind),
      eq(objectFiles.objectId, input.object.id),
      ne(objectFiles.state, "deleted"),
      parents === null ? undefined : inArray(objectFiles.parent, parents),
    ))
    .returning({ id: objectFiles.id });
  return { fileIds: rows.map((row) => asObjectFileId(row.id)) };
}

/**
 * The bytes of files deleteObjectFiles let go, after the transaction that
 * did committed (outside any transaction: inside one it throws, as the
 * bytes would go before the rows' fate is known), then their rows. Only rows
 * still `deleted` are touched, so a call after a rollback deletes nothing.
 * Each on its own: one that fails is counted and left to the sweep. Returns
 * how many files went.
 */
export async function deleteObjectFileBytes(deleted: DeletedObjectFiles): Promise<number> {
  if (deleted.fileIds.length === 0) return 0;
  if (isInTransaction()) throw new Error("deleteObjectFileBytes runs after the transaction that let the files go has committed");
  return purgeDeleted(deleted.fileIds, "after_commit");
}

/** Delete the bytes of these `deleted` rows, then the rows whose bytes went. Without the bucket nothing goes (the sweep tries later). */
async function purgeDeleted(ids: readonly string[], caller: "after_commit" | "sweep"): Promise<number> {
  const handle = storage();
  if (!handle.configured || ids.length === 0) return 0;
  const rows = await getDb().select({ id: objectFiles.id, storageKey: objectFiles.storageKey })
    .from(objectFiles)
    .where(and(inArray(objectFiles.id, [...ids]), eq(objectFiles.state, "deleted")));
  return purgeRows(handle, rows, caller);
}

/** Delete these rows' bytes, each on its own (a failure counted, its row left), then the rows whose bytes went. */
async function purgeRows(handle: AppObjectStorage, rows: readonly { id: string; storageKey: string }[], caller: "after_commit" | "sweep"): Promise<number> {
  const gone: string[] = [];
  for (const row of rows) {
    try {
      await handle.delete(row.storageKey);
      gone.push(row.id);
      objectFileByteDeletesTotal.inc({ outcome: "deleted", caller });
    } catch (error) {
      objectFileByteDeletesTotal.inc({ outcome: "failed", caller });
      console.warn("[object-files] could not delete a file's bytes; the hourly sweep tries again", { caller, error: serializeErrorForLog(error) });
    }
  }
  if (gone.length > 0) await getDb().delete(objectFiles).where(and(inArray(objectFiles.id, gone), eq(objectFiles.state, "deleted")));
  return gone.length;
}

/**
 * Let go of up to `batch` rows `which` names (re-checked in the update), in
 * one transaction: the rows are taken FOR UPDATE SKIP LOCKED, so a second
 * instance's sweep takes others, and a claim racing this one either waits
 * for it or wins first (then the row no longer matches and stays). `refundIn`:
 * each upload let go here whose bytes the monthly quota counted in that
 * month gives them back to its billed server, in this same transaction, so
 * exactly once: only the update that moved the row out of `which` returns it.
 */
async function releaseBatch(which: () => SQL, now: Date, batch: number, refundIn: string | null): Promise<number> {
  return getDb().transaction(async (tx) => {
    const picked = await tx.select({ id: objectFiles.id }).from(objectFiles)
      .where(which())
      .orderBy(asc(objectFiles.createdAt))
      .limit(batch)
      .for("update", { skipLocked: true });
    if (picked.length === 0) return 0;
    const released = await tx.update(objectFiles)
      .set({ state: "deleted", deletedAt: now })
      .where(and(inArray(objectFiles.id, picked.map((row) => row.id)), which()))
      .returning({ serverId: objectFiles.serverId, billedServerId: objectFiles.billedServerId, sizeBytes: objectFiles.sizeBytes, quotaMonth: objectFiles.quotaMonth });
    if (refundIn !== null) {
      const refunds = new Map<string, number>();
      for (const row of released) {
        if (row.quotaMonth !== refundIn) continue;
        const billed = row.billedServerId ?? row.serverId;
        refunds.set(billed, (refunds.get(billed) ?? 0) + row.sizeBytes);
      }
      // In server order: two sweeps' locks never cross.
      for (const [billed, bytes] of [...refunds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        await refundFileUploadQuotaWith(tx, billed, refundIn, bytes);
      }
    }
    return released.length;
  });
}

/**
 * Take up to `batch` `deleted` rows let go by `now`, oldest first, and delete
 * their bytes. The claim (FOR UPDATE SKIP LOCKED, then deleted_at moved
 * PURGE_LEASE_MS ahead, in one short transaction) keeps another instance's
 * sweep off them while the bytes go outside any transaction. Answers how
 * many were taken and how many went.
 */
async function purgeBatch(handle: AppObjectStorage, now: Date, batch: number): Promise<{ taken: number; purged: number }> {
  const rows = await getDb().transaction(async (tx) => {
    const due = and(eq(objectFiles.state, "deleted"), lte(objectFiles.deletedAt, now))!;
    const picked = await tx.select({ id: objectFiles.id }).from(objectFiles)
      .where(due)
      .orderBy(asc(objectFiles.deletedAt))
      .limit(batch)
      .for("update", { skipLocked: true });
    if (picked.length === 0) return [];
    return tx.update(objectFiles)
      .set({ deletedAt: new Date(now.getTime() + PURGE_LEASE_MS) })
      .where(and(inArray(objectFiles.id, picked.map((row) => row.id)), due))
      .returning({ id: objectFiles.id, storageKey: objectFiles.storageKey });
  });
  return { taken: rows.length, purged: await purgeRows(handle, rows, "sweep") };
}

/**
 * The hourly sweep (server.ts maintenance `sweep_object_files`). Batches of
 * `batch` (SWEEP_BATCH), each phase going on while a batch came back full
 * and `budgetMs` (SWEEP_BUDGET_MS) hasn't passed since the sweep started
 * (each phase takes at least one batch): drafts unclaimed for
 * OBJECT_FILE_UNCLAIMED_TTL_MS are let go, each upload's bytes given back
 * to the monthly quota that counted them when that is this month's
 * (releaseBatch); then a soft-deleted server's files are let go; then the
 * bytes of `deleted` rows are deleted, oldest first (those let go here, and
 * those whose delete after the commit failed or never ran; purgeBatch).
 * Each row is re-checked in the statement that changes it, so a draft
 * claimed meanwhile stays. Without the bucket nothing is purged.
 */
export async function sweepObjectFiles(opts: { now?: Date; batch?: number; budgetMs?: number } = {}): Promise<{ released: number; purged: number }> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? SWEEP_BATCH;
  const budgetMs = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const started = Date.now();
  const timeLeft = () => Date.now() - started < budgetMs;
  const db = getDb();
  const cutoff = new Date(now.getTime() - OBJECT_FILE_UNCLAIMED_TTL_MS);
  const unclaimedPast = () => and(eq(objectFiles.state, "unclaimed"), lt(objectFiles.createdAt, cutoff))!;
  const ofDeletedServer = () => and(
    ne(objectFiles.state, "deleted"),
    inArray(objectFiles.serverId, db.select({ id: servers.id }).from(servers).where(isNotNull(servers.deletedAt))),
  )!;
  let released = 0;
  for (;;) {
    const count = await releaseBatch(unclaimedPast, now, batch, billingUsageMonth(now));
    released += count;
    if (count < batch || !timeLeft()) break;
  }
  for (;;) {
    // A deleted server's own quota is not given anything back.
    const count = await releaseBatch(ofDeletedServer, now, batch, null);
    released += count;
    if (count < batch || !timeLeft()) break;
  }
  let purged = 0;
  const handle = storage();
  if (handle.configured) {
    for (;;) {
      const { taken, purged: gone } = await purgeBatch(handle, now, batch);
      purged += gone;
      if (taken < batch || !timeLeft()) break;
    }
  }
  return { released, purged };
}

// ---- reads -------------------------------------------------------------------------

export type ObjectFileRead =
  | { kind: "file"; stream: Readable; size: number; contentType: ObjectFileContentType }
  | { kind: "not_found" }
  | { kind: "unavailable" };

const NOT_FOUND: ObjectFileRead = { kind: "not_found" };

/** Whether a row is a draft only its uploader reads: unclaimed, or hung on a `draft:` part. */
const isDraft = (row: { state: string; parent: string | null }): boolean =>
  row.state === "unclaimed" || (row.parent?.startsWith(`${OBJECT_FILE_DRAFT_PART}:`) ?? false);

/**
 * File `fileId` of object `objectId` of kind `kind` for `viewer`
 * (routes/objects.ts): the row is matched by the three together, so another
 * object's file id finds nothing; a draft (unclaimed, or hung on a `draft:`
 * part) only for its uploader;
 * then the object must be one the viewer can see fully now, by the
 * platform's rule (objectSummaries fullyVisibleObjectsOf: the app's flag for
 * both servers, the kind's homes, core's visibility, and not another server's
 * public object, whose readers see only its public face, never its parts).
 * `parts`: of the claimed files, only one hung on a part one of these prefixes starts (`comment:`,
 * `draft:`), where a route serves one kind of part alone (an Artifact's comment images, not its
 * check shots); an unclaimed upload is its uploader's, as ever.
 * Last, the kind's own fileReadable for the file's part, when it has one (an
 * Artifact's check shots only while the deployment has a check Worker).
 * Anything else is `not_found`, one answer
 * for every reason. `unavailable`: the platform's bucket is not configured.
 */
export async function readObjectFile(
  viewer: ServerViewActor,
  input: { kind: string; objectId: string; fileId: string; parts?: readonly string[]; signal?: AbortSignal },
): Promise<ObjectFileRead> {
  const registered = registeredObjectKind(input.kind);
  if (!registered || !UUID.test(input.fileId)) return NOT_FOUND;
  const [row] = await getDb().select({
    state: objectFiles.state,
    parent: objectFiles.parent,
    uploadedByType: objectFiles.uploadedByType,
    uploadedById: objectFiles.uploadedById,
    contentType: objectFiles.contentType,
    sizeBytes: objectFiles.sizeBytes,
    storageKey: objectFiles.storageKey,
  }).from(objectFiles)
    .where(and(
      eq(objectFiles.id, input.fileId),
      eq(objectFiles.objectKind, input.kind),
      eq(objectFiles.objectId, input.objectId),
      ne(objectFiles.state, "deleted"),
    ))
    .limit(1);
  if (!row) return NOT_FOUND;
  if (input.parts && row.state === "claimed" && !input.parts.some((prefix) => row.parent?.startsWith(prefix) ?? false)) return NOT_FOUND;
  if (isDraft(row) && !(row.uploadedByType === viewer.type && row.uploadedById === viewer.id)) return NOT_FOUND;
  const visible = await fullyVisibleObjectsOf(viewer, registered, [input.objectId]);
  if (!visible.has(input.objectId)) return NOT_FOUND;
  if (row.parent !== null && registered.objectKind.fileReadable && !(await registered.objectKind.fileReadable(input.objectId, row.parent))) return NOT_FOUND;
  const handle = storage();
  if (!handle.configured) return { kind: "unavailable" };
  const stream = await handle.get(row.storageKey, input.signal);
  if (!stream) return NOT_FOUND;
  return { kind: "file", stream, size: row.sizeBytes, contentType: row.contentType };
}

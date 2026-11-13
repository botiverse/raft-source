// Saving an attachment as an Artifact (S5), one rule for a person and an
// agent: the web's `POST /api/artifacts/save-attachment` (webShare.ts) and the
// agent API's `POST /internal/agent-api/artifacts/save-attachment`
// (createSaveOperations below) check the flag and their body, then call
// saveAttachment with the saver (platform/visibility ServerViewActor: a
// person or an agent, never an assistant acting for its owner) and answer
// its outcome in their own codes.
//
// saveAttachment checks that the saver can see the attachment's message,
// within the plan's history window (platform/attachments; `not_found`, the
// routes' 404 ATTACHMENT_NOT_FOUND, also when the attachment is hard-deleted
// between reading it and writing the save: its foreign key fails, nothing saved), an earlier save as a live Artifact
// (`earlier`: the route answers that Artifact if the saver can see it, else
// 409 ALREADY_SAVED; one deleted or revoked since doesn't count, and saving
// again makes a new one), the size (`too_large`, 422 ATTACHMENT_NOT_SAVABLE),
// then copies the bytes into Artifacts' R2 (a blob of the saver's server, as
// a publish stores them: blobs.ts storeBlob, so new bytes count against the
// server's monthly file upload quota, the attachments' one; no room is
// `file_upload_quota_exceeded`, the attachments' 403
// FILE_UPLOAD_QUOTA_EXCEEDED, nothing saved; storage missing or full is
// `content_unavailable`, 503 CONTENT_UNAVAILABLE) and, in one transaction
// under a lock on the attachment, makes the Artifact: the saver's, homed in
// the attachment's top-level conversation, its first version with the one
// file, the save (`attachment_saves`, what the web's "Saved as Artifact"
// lines read), its original message (the attachment's), the search index, the event, the saver following it as
// following does (their read position at its last position, reported to
// core's Activity for a person). Attachment comments are not copied (E3,
// later).
//
// The agent API: the flag first (requireEnabled), then the above; an earlier
// save is answered while the agent sees that Artifact (canViewArtifacts, and
// its server's flag, as every agent read), as summarize names it.
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  replaceAgentLineBreaks,
  ARTIFACT_SAVE_MAX_BINARY_BYTES,
  ARTIFACT_SAVE_MAX_TEXT_BYTES,
  AGENT_API_ARTIFACT_MAX_TITLE_CHARS,
  artifactFileType,
  artifactTitleFromFileName,
  isGitPathSegment,
  type AgentApiArtifactSaveAttachmentBody,
  type AgentApiArtifactSaved,
} from "@botiverse/raft-shared";
import { AttachmentStorageUnavailableError, attachmentSource, readAttachmentForSave, type AttachmentSource } from "../../platform/attachments";
import { AGENT_LOUNGE_PLACEMENT_REFUSAL, agentMayPlaceInConversation } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import type { FileUploadQuotaExceededError } from "../../platform/fileUploadQuota";
import type { ServerViewActor } from "../../platform/visibility";
import {
  advanceReadPosition,
  answer,
  byteSize,
  fail,
  fileUploadQuotaRefusal,
  itemServerEnabled,
  json,
  requireEnabled,
  summarize,
  viewActor,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiResult,
} from "./apiCommon";
import { storeBlob } from "./blobs";
import { artifactR2Store } from "./blobStore";
import { recordArtifactEvent } from "./events";
import { entryExcerpt } from "./excerpt";
import { autoSubscribe } from "./notices";
import { artifactAttachmentSaves, artifactBlobs, artifactItems, artifactVersionFiles, artifactVersions, type ArtifactItemRow } from "./schema";
import { indexArtifactSearch } from "./search";
import { canViewArtifacts } from "./visibility";

/** An Artifact neither deleted nor revoked: only such a one counts as what an attachment was saved as. */
export const liveItem = and(isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt));

/** A path an attachment's file name can be a version's file at: anything the path rules refuse becomes `_`. */
export function savedFilePath(filename: string): string {
  const cleaned = filename.replace(/[\p{Cc}\p{Cf}\\%?#/]/gu, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
  // A file named `.git` (any case) is git's own; the shared path rule refuses it.
  return isGitPathSegment(cleaned) ? `_${cleaned}` : cleaned;
}

const hasPgCode = (error: unknown, code: string): boolean => {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === code) return true;
  }
  return false;
};
/** The save row's attachment is gone (hard-deleted after it was read): a foreign key violation. */
const isForeignKeyViolation = (error: unknown): boolean => hasPgCode(error, "23503");

/** The attachment a save is of, as its answer names it: its id and the file name it was posted with. */
export type SavedAttachment = { id: string; filename: string };

/** What saveAttachment did, or why it saved nothing (the header has each route's answer). */
export type AttachmentSaveOutcome =
  | { kind: "created"; item: ArtifactItemRow; attachment: SavedAttachment }
  /** Saved before as this live Artifact, which the saver may not see. */
  | { kind: "earlier"; item: ArtifactItemRow; attachment: SavedAttachment }
  | { kind: "not_found" }
  | { kind: "too_large"; limit: number }
  | { kind: "file_upload_quota_exceeded"; error: FileUploadQuotaExceededError }
  /** `error` says which storage (the web's label). */
  | { kind: "content_unavailable"; error: string };

const attachmentOf = (source: AttachmentSource): SavedAttachment => ({ id: source.attachmentId, filename: source.name });

/** The live Artifact `attachmentId` was saved as, if any (a deleted or revoked one is no save). */
async function savedItemOf(attachmentId: string): Promise<ArtifactItemRow | null> {
  const [row] = await getDb().select({ item: artifactItems }).from(artifactAttachmentSaves)
    .innerJoin(artifactItems, eq(artifactItems.id, artifactAttachmentSaves.itemId))
    .where(and(eq(artifactAttachmentSaves.attachmentId, attachmentId), liveItem)).limit(1);
  return row?.item ?? null;
}

/** Read the stream to its end, at most `size` bytes (more is a changed object: refused as gone). */
async function bytesOf(stream: Readable, size: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > size) {
      stream.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return received === size ? Buffer.concat(chunks, received) : null;
}

/** The Artifact, version 1 with the one file, and the save, in one transaction under a lock on the attachment. */
async function createSaved(saverView: ServerViewActor, source: AttachmentSource, conversationId: string, bytes: Buffer, sha256: string): Promise<{ kind: "created" | "exists"; item: ArtifactItemRow } | { kind: "gone" }> {
  const path = savedFilePath(source.name);
  // Named after the file, without a known extension (`notes.md` → `notes`; artifactTitleFromFileName).
  const title = [...replaceAgentLineBreaks(artifactTitleFromFileName(source.name.trim()), " ")].slice(0, AGENT_API_ARTIFACT_MAX_TITLE_CHARS).join("").trim() || path;
  const serverId = saverView.serverId;
  const saver: ArtifactActorRef = { type: saverView.type, id: saverView.id };
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact-attachment-save:${source.attachmentId}`}))`);
      const [earlier] = await tx.select({ item: artifactItems }).from(artifactAttachmentSaves)
        .innerJoin(artifactItems, eq(artifactItems.id, artifactAttachmentSaves.itemId))
        .where(and(eq(artifactAttachmentSaves.attachmentId, source.attachmentId), liveItem)).limit(1);
      if (earlier) return { kind: "exists" as const, item: earlier.item };
      const [blob] = await tx.select({ id: artifactBlobs.id }).from(artifactBlobs)
        .where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha256), eq(artifactBlobs.state, "ready")))
        .for("key share").limit(1);
      // Swept between storing and now (a day's age: practically never): a 500, and saving again stores it again.
      if (!blob) throw new Error(`artifact blob ${sha256} disappeared before the save`);
      const id = `pt_${randomUUID()}`;
      // No name: an Artifact is its id and its title (#proj-workspace:98241a2e).
      await tx.insert(artifactItems).values({
        id,
        serverId,
        urlKey: id,
        name: null,
        title,
        homeKind: "conversation",
        homeChannelId: conversationId,
        // Its original conversation (#75), never changed: the only one a narrowing returns it to.
        originalHomeChannelId: conversationId,
        createdByType: saver.type,
        createdById: saver.id,
        // It came in through the attachment's message: its original message, never moved.
        originMessageId: source.messageId,
        originVia: "attachment",
      });
      const position = 1;
      const [version] = await tx.insert(artifactVersions).values({
        id: `v_${randomUUID()}`,
        itemId: id,
        number: 1,
        entry: path,
        title,
        fileCount: 1,
        sizeBytes: bytes.length,
        // The bytes are here, so with the version (excerpt.ts): a save never reads storage for it.
        ...entryExcerpt(path, bytes, title),
        publishDigest: createHash("sha256").update(JSON.stringify(["attachment", source.attachmentId, sha256])).digest("hex"),
        provenance: { savedFromAttachment: source.attachmentId },
        status: "published",
        publisherType: saver.type,
        publisherId: saver.id,
        position,
      }).returning();
      await tx.insert(artifactVersionFiles).values({ versionId: version!.id, path, sha256, sizeBytes: bytes.length, blobId: blob.id });
      const [item] = await tx.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: position })
        .where(eq(artifactItems.id, id)).returning();
      // A save of an Artifact deleted or revoked since is replaced: the attachment is now saved as this one.
      await tx.insert(artifactAttachmentSaves).values({ attachmentId: source.attachmentId, itemId: id, versionId: version!.id })
        .onConflictDoUpdate({ target: artifactAttachmentSaves.attachmentId, set: { itemId: id, versionId: version!.id, createdAt: sql`now()` } });
      await indexArtifactSearch(tx, item!);
      // A new Artifact has no followers yet: the event is for no one but the record (Activity).
      await recordArtifactEvent(tx, { item: item!, eventKind: "version", actor: saver, data: { position, version: 1 }, recipients: [] });
      // The saver follows it as following does (comments.ts follow): read up to its
      // last position, reported to core's Activity, so only what comes after is unread.
      await autoSubscribe(tx, id, saver, "published");
      await advanceReadPosition(saver, id, item!.lastPosition, tx);
      return { kind: "created" as const, item: item! };
    });
  } catch (error) {
    // The attachment was deleted between reading it and saving it: nothing was saved (rolled back).
    if (isForeignKeyViolation(error)) return { kind: "gone" };
    throw error;
  }
}

/** Save the attachment as a new Artifact of `saver` (the checks in the header, in order); the caller has checked the flag. */
export async function saveAttachment(saver: ServerViewActor, attachmentId: string): Promise<AttachmentSaveOutcome> {
  const source = await attachmentSource(saver, attachmentId);
  if (!source || source.conversationId === null) return { kind: "not_found" };
  const earlier = await savedItemOf(source.attachmentId);
  if (earlier) return { kind: "earlier", item: earlier, attachment: attachmentOf(source) };
  const limit = artifactFileType(savedFilePath(source.name)).text ? ARTIFACT_SAVE_MAX_TEXT_BYTES : ARTIFACT_SAVE_MAX_BINARY_BYTES;
  if (source.size > limit) return { kind: "too_large", limit };
  const store = artifactR2Store();
  if (!store) return { kind: "content_unavailable", error: "Nothing was saved: this server's file storage for Artifacts isn't set up, so tell an admin of this server, since retrying won't help." };

  let read: Awaited<ReturnType<typeof readAttachmentForSave>>;
  try {
    read = await readAttachmentForSave(saver, source.attachmentId);
  } catch (error) {
    if (error instanceof AttachmentStorageUnavailableError) return { kind: "content_unavailable", error: "Nothing was saved: this server's attachment storage isn't set up, so the file can't be read; tell an admin of this server." };
    throw error;
  }
  if (!read) return { kind: "not_found" };
  const bytes = await bytesOf(read.stream, read.size);
  if (!bytes) return { kind: "not_found" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await storeBlob(store, saver.serverId, sha256, bytes);
  // The month's file upload quota (the attachments' one): nothing stored, nothing saved.
  if (stored.kind === "file_upload_quota_exceeded") return { kind: "file_upload_quota_exceeded", error: stored.error };
  // The cap is on bytes no version uses yet; these are about to be used, but the store can't take them now.
  if (stored.kind === "quota_exceeded") return { kind: "content_unavailable", error: "Nothing was saved: this server's artifact storage can't take more files right now, so try again later, and tell an admin of this server if it keeps failing." };

  const made = await createSaved(saver, read, source.conversationId, bytes, sha256);
  if (made.kind === "gone") return { kind: "not_found" };
  return { kind: made.kind === "created" ? "created" : "earlier", item: made.item, attachment: attachmentOf(read) };
}

/**
 * An attachment the saver can't see, that doesn't exist, or whose message is
 * behind the server's history limit: one sentence for every reason, agent and
 * web alike (Warden reviews it).
 */
export const ATTACHMENT_NOT_FOUND_ERROR = "No attachment you can see has that id, and a file from a message older than this server's history limit can't be saved either: check the id, the one after the file's name in the conversation.";

/** Saved before, as an Artifact the saver can't see: nothing new is made (the save's own rule). */
export const ALREADY_SAVED_ERROR = "That attachment was already saved as an artifact you can't see, so nothing new was made: push your own copy of the file as a new artifact instead.";

/** Larger than an Artifact file may be. */
export const attachmentTooLargeError = (limit: number): string =>
  `That attachment is larger than the ${byteSize(limit)} an artifact file of its kind may be, so it can't be saved as one: keep it as an attachment, or push a smaller version of the file.`;

/** The agent API's save (mount.ts; the checks in the header). */
export function createSaveOperations() {
  return {
    saveAttachment: (agent: ArtifactAgent, body: AgentApiArtifactSaveAttachmentBody): Promise<ArtifactApiResult<AgentApiArtifactSaved>> => answer(async () => {
      await requireEnabled(agent);
      const attachmentId = body.attachmentId;
      // Agent Lounge: the save is homed in the attachment's conversation, and
      // another agent's lounge is readable, not a place to put things.
      const source = await attachmentSource(viewActor(agent), attachmentId);
      if (source?.conversationId && !await agentMayPlaceInConversation(source.conversationId, agent.agentId)) {
        return fail(403, { code: "FORBIDDEN", error: AGENT_LOUNGE_PLACEMENT_REFUSAL, details: { attachmentId } });
      }
      const outcome = await saveAttachment(viewActor(agent), attachmentId);
      switch (outcome.kind) {
        case "not_found": return fail(404, { code: "ATTACHMENT_NOT_FOUND", error: ATTACHMENT_NOT_FOUND_ERROR, details: { attachmentId } });
        case "too_large": return fail(422, { code: "ATTACHMENT_NOT_SAVABLE", error: attachmentTooLargeError(outcome.limit), details: { attachmentId, reason: "too_large", limit: outcome.limit } });
        case "content_unavailable": return fail(503, { code: "CONTENT_UNAVAILABLE", error: outcome.error });
        // The attachments' body, as publish answers it; an upgrade card offered where the attachment was posted (a thread included).
        case "file_upload_quota_exceeded": return fileUploadQuotaRefusal(agent.serverId, outcome.error, "artifact_save_attachment", { agentId: agent.agentId, channelId: source?.channelId ?? null, subject: "saved_file" });
        case "earlier": {
          const [visible] = await canViewArtifacts(viewActor(agent), [outcome.item]);
          if (!visible || !(await itemServerEnabled(outcome.item))) return fail(409, { code: "ALREADY_SAVED", error: ALREADY_SAVED_ERROR, details: { attachmentId } });
          break;
        }
        case "created": break;
      }
      const [artifact] = await summarize(agent, [outcome.item]);
      return json<AgentApiArtifactSaved>({ artifact: artifact!, created: outcome.kind === "created", attachment: outcome.attachment }, outcome.kind === "created" ? 201 : 200);
    }),
  };
}

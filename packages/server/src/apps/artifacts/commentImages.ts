// Images in comments (#146, phase 1): uploading one, a comment or review
// draft taking it, reading it, and letting it go with what it hangs on. An
// image is a core object file of the Artifact (platform/objectFiles,
// docs/development/first-party-apps.md "Object files"); Artifacts keeps only
// the metadata core answered (`comments.images`, `comment_drafts.images`).
//
// - Upload (web `POST /api/artifacts/:id/comment-images`, agent
//   artifactCommentImageUpload): someone who takes part in the Artifact (its
//   server's, or its joint channel's; 403 FORBIDDEN otherwise), the raw body
//   at most ARTIFACT_COMMENT_IMAGE_MAX_BYTES (decided from Content-Length
//   before a byte is read), stored by core as an unclaimed file of the
//   Artifact (putObjectFile, parent null: the type from the bytes, the pixel
//   cap before decoding, metadata removed). Billed to the uploader's own
//   server (payingServer: the server the person's request stands in, the
//   agent's own; a joint channel's member of another server pays there,
//   never the Artifact's server): that server's caps (its total, the
//   uploader's drafts and total there: 413 IMAGE_REFUSED
//   `uploader_quota_exceeded`) and its monthly file upload quota, whose
//   refusal names that server's billing. Answered with what core kept
//   (ArtifactCommentImage).
//   Each surface has its own rate limit (30 a minute per person, per agent).
// - Taking images (a comment, a draft, an agent's review comment):
//   claimCommentImages in the transaction that writes the comment or draft,
//   hanging each on `comment:<id>` or `draft:<id>`. Only an unclaimed upload
//   of the writer's own to this Artifact (core's claim: the same object, the
//   same uploader, not claimed yet); the first that isn't refuses the whole
//   comment (400 IMAGE_NOT_FOUND) and the caller's refusal rolls back every
//   claim before it. The metadata kept is core's answer, never the client's.
// - A draft's images are read only by its author (core: a `draft:` part is a
//   draft); submitting the review moves them to the posted comment's part
//   (moveDraftImages, core's moveObjectFiles) in the review's transaction.
// - Letting go (releaseImages, core's deleteObjectFiles) in the transaction
//   that deletes the comment or the drafts; the bytes after the commit
//   (deleteObjectFileBytes). Deleting the Artifact lets every file go (manage.ts).
// - Reading: the web through core's `GET /api/objects/artifact/:id/files/:fileId`;
//   an agent through artifactCommentImage (below), core's readObjectFile for
//   the agent once the Artifact resolved as its comments do.
import type { Readable } from "node:stream";
import {
  ARTIFACT_COMMENT_IMAGE_MAX_BYTES,
  type AgentApiArtifactCommentImage,
  type AgentApiArtifactCommentImageParams,
  type AgentApiArtifactParams,
  type ArtifactCommentImage,
  type ArtifactWebErrorDetails,
  RAFT_HINTS,
  type ServerId,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../../platform/db";
import { FileUploadQuotaExceededError } from "../../platform/fileUploadQuota";
import {
  claimObjectFile,
  deleteObjectFileBytes,
  deleteObjectFiles,
  moveObjectFiles,
  OBJECT_FILE_DRAFT_PART,
  ObjectFileRefusedError,
  putObjectFile,
  readObjectFile,
  type DeletedObjectFiles,
  type StoredObjectFile,
} from "../../platform/objectFiles";
import { AppObjectStorageUnavailableError } from "../../platform/storage";
import {
  accessOf,
  agentActor,
  answer,
  byteSize,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiBytes,
  type ArtifactApiError,
  type ArtifactApiResult,
  fail,
  fileUploadQuotaRefusal,
  json,
  mayNotTakePart,
  notVisible,
  resolveVisibleItem,
  STORAGE_UNAVAILABLE_ERROR,
  storageUnavailable,
  takesPartIn,
  viewActor,
} from "./apiCommon";
import { artifactFileObject } from "./checks";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import type { ArtifactItemRow } from "./schema";
import { requireTakesPart } from "./webComments";
import {
  answerWeb,
  readerActor,
  visibleItemFor,
  webFail,
  webFileUploadQuotaRefusal,
  webNotVisible,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";

/** The part a posted comment's images hang on. */
export const commentImagesPart = (commentId: string): string => `comment:${commentId}`;
/** The part a review draft's images hang on: core's draft part, read only by their uploader. */
export const draftImagesPart = (draftId: string): string => `${OBJECT_FILE_DRAFT_PART}:${draftId}`;
/** The parts the comment image download serves: a comment's and a draft's (commentImagesPart, draftImagesPart). */
const COMMENT_IMAGE_PARTS = [commentImagesPart(""), draftImagesPart("")] as const;

/** An upload's body, as either surface hands it over. */
export interface ImageUploadInput {
  contentType: string | undefined;
  contentLength: string | undefined;
  body: Readable;
}

/** A file core stored, as a comment keeps it; null for one with no pixel size (stored before core read sizes: never an upload). */
function commentImageOf(file: StoredObjectFile): ArtifactCommentImage | null {
  if (file.width === null || file.height === null) return null;
  return { fileId: file.id, contentType: file.contentType, sizeBytes: file.sizeBytes, width: file.width, height: file.height };
}

/**
 * Hang `fileIds` (as sent, in order) on `part`, in the transaction that
 * writes the comment or draft: each must be an unclaimed upload of `by` to
 * this Artifact (core's claim; an id twice is claimed once, then refused).
 * The images as the comment keeps them, or the first id that isn't one: the
 * caller then refuses, which rolls back the claims before it.
 */
export async function claimCommentImages(
  tx: DatabaseExecutor,
  itemId: string,
  by: ArtifactActorRef,
  fileIds: readonly string[],
  part: string,
): Promise<{ kind: "claimed"; images: ArtifactCommentImage[] } | { kind: "not_found"; fileId: string }> {
  const images: ArtifactCommentImage[] = [];
  for (const fileId of fileIds) {
    const claimed = await claimObjectFile({ object: artifactFileObject(itemId), fileId, parent: part, by, executor: tx });
    const image = claimed && commentImageOf(claimed);
    if (!image) return { kind: "not_found", fileId };
    images.push(image);
  }
  return { kind: "claimed", images };
}

/** A posted review draft's images, from its part to its comment's, in the review's transaction. */
export async function moveDraftImages(tx: DatabaseExecutor, itemId: string, draftId: string, commentId: string): Promise<void> {
  await moveObjectFiles({ object: artifactFileObject(itemId), from: draftImagesPart(draftId), to: commentImagesPart(commentId), executor: tx });
}

/** Let go of the images of these parts (commentImagesPart, draftImagesPart), in the transaction that deletes them; hand the answer to releasedImagesGone after the commit. */
export function releaseImages(tx: DatabaseExecutor, itemId: string, parts: readonly string[]): Promise<DeletedObjectFiles> {
  return deleteObjectFiles({ object: artifactFileObject(itemId), parent: parts, executor: tx });
}

/** The bytes of images releaseImages let go, once its transaction committed. */
export async function releasedImagesGone(released: DeletedObjectFiles | null): Promise<void> {
  if (released) await deleteObjectFileBytes(released);
}

// ---- uploading -------------------------------------------------------------------

/** Why an upload stored nothing, before either surface words it. */
type UploadRefusal =
  | { kind: "length_required" }
  | { kind: "too_large"; size: number }
  | { kind: "size_mismatch"; size: number; actual: number }
  | { kind: "refused"; reason: ArtifactWebErrorDetails["IMAGE_REFUSED"]["reason"]; message: string; details: { limit?: number; used?: number; scope?: "drafts" | "total" } }
  | { kind: "file_upload_quota"; error: FileUploadQuotaExceededError }
  | { kind: "unavailable" }
  | { kind: "gone" };

/**
 * Read one image's body (its size decided from Content-Length before a byte
 * is read) and store it as an unclaimed upload of `by` to the item, billed
 * to `billedTo` (payingServer).
 */
async function storeUpload(item: ArtifactItemRow, by: ArtifactActorRef, billedTo: ServerId, input: ImageUploadInput): Promise<{ kind: "stored"; image: ArtifactCommentImage } | UploadRefusal> {
  if (input.contentLength === undefined || !/^\d{1,12}$/.test(input.contentLength)) return { kind: "length_required" };
  const size = Number(input.contentLength);
  if (size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) return { kind: "too_large", size };
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of input.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > size) {
      input.body.destroy();
      return { kind: "size_mismatch", size, actual: received };
    }
    chunks.push(buffer);
  }
  if (received !== size) return { kind: "size_mismatch", size, actual: received };
  try {
    const stored = await putObjectFile({ object: artifactFileObject(item.id), parent: null, bytes: Buffer.concat(chunks, received), uploadedBy: by, quota: "monthly", billedTo });
    return { kind: "stored", image: { fileId: stored.id, contentType: stored.contentType, sizeBytes: stored.sizeBytes, width: stored.width, height: stored.height } };
  } catch (error) {
    if (error instanceof AppObjectStorageUnavailableError) return { kind: "unavailable" };
    if (error instanceof FileUploadQuotaExceededError) return { kind: "file_upload_quota", error };
    if (!(error instanceof ObjectFileRefusedError)) throw error;
    // The Artifact went since it was looked up: as if it never was.
    if (error.reason === "object_not_found") return { kind: "gone" };
    return { kind: "refused", reason: error.reason, message: error.message, details: error.details };
  }
}

/** A refusal's status: too many bytes (the image's, the server's, the uploader's) 413, an image core can't take 422. */
const refusedStatus = (reason: ArtifactWebErrorDetails["IMAGE_REFUSED"]["reason"]): number =>
  (reason === "too_large" || reason === "server_quota_exceeded" || reason === "uploader_quota_exceeded" ? 413 : 422);

/**
 * What a refusal says: why the image wasn't kept and what to do, for every
 * reason (the uploader's own limit in core's words: which one, and that
 * posting or deleting drafts frees room).
 */
function refusedMessage(outcome: Extract<UploadRefusal, { kind: "refused" }>): string {
  const limit = outcome.details.limit;
  switch (outcome.reason) {
    case "too_large": return `The image is larger than ${byteSize(limit ?? ARTIFACT_COMMENT_IMAGE_MAX_BYTES)}, so it wasn't kept: send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.`;
    case "too_many_pixels": return `The image has more than ${limit ?? "the allowed number of"} pixels, so it wasn't kept: send a smaller image, or post the comment without it.`;
    case "server_quota_exceeded": return "This server's comment images are full, so the image wasn't kept: post the comment without it, and tell an admin of this server.";
    case "uploader_quota_exceeded": return `The image wasn't kept. ${outcome.message}`;
    case "empty": return "The image is empty, so it wasn't kept: send the image's bytes, or post the comment without it.";
    default: return "The image isn't a PNG, JPEG, WebP or GIF image that can be read, so it wasn't kept: send one of those, or post the comment without it.";
  }
}

/** An image over the size cap, by its Content-Length. */
const tooLargeError = (size?: number): string =>
  `The image is ${size === undefined ? "larger than" : `${byteSize(size)}, over`} the ${byteSize(ARTIFACT_COMMENT_IMAGE_MAX_BYTES)} an image may be: send a smaller PNG, JPEG, WebP or GIF image, or post the comment without it.`;

/** The bytes sent aren't Content-Length's: a client's bug, the same upload may go through again. */
const SIZE_MISMATCH_ERROR = "The image didn't arrive whole (its bytes don't match its Content-Length): upload it again, and if that keeps failing it is a client bug to report.";
/** No Content-Length: a client's bug. */
const LENGTH_REQUIRED_ERROR = "An image upload needs a Content-Length header, and this one had none: this is a client bug, so post the comment without the image meanwhile.";

/**
 * The server an image is billed to (its caps, its monthly quota; a refusal
 * names that server's billing): the uploader's own, never the Artifact's
 * when they differ. A person: the server the request stands in (core's
 * requireServer checked the membership; a joint channel's member of another
 * server stands in their own). An agent: its own server.
 */
const payingServer = (uploader: { serverId: ServerId }): ServerId => uploader.serverId;

export function createWebCommentImageOperations() {
  return {
    /** `POST /api/artifacts/:id/comment-images`: the flag and the Artifact (one 404), a person who takes part in it (403), then the upload. */
    uploadCommentImage: (reader: ArtifactWebReader, id: string, input: ImageUploadInput): Promise<{ kind: "json"; body: ArtifactCommentImage; status: number } | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      await requireTakesPart(reader, item);
      const type = input.contentType?.split(";")[0]!.trim().toLowerCase() ?? "";
      if (type !== "application/octet-stream" && !type.startsWith("image/")) {
        return webFail(400, { code: "INVALID_REQUEST", error: "An image upload's body is the image's bytes, sent as image/* or application/octet-stream: choose the image again." });
      }
      const outcome = await storeUpload(item, readerActor(reader), payingServer(reader), input);
      switch (outcome.kind) {
        case "stored": return { kind: "json" as const, body: outcome.image, status: 201 };
        case "length_required": return webFail(411, { code: "INVALID_REQUEST", error: LENGTH_REQUIRED_ERROR });
        case "too_large": return webFail(413, { code: "IMAGE_REFUSED", error: tooLargeError(), details: { reason: "too_large", limit: ARTIFACT_COMMENT_IMAGE_MAX_BYTES } });
        case "size_mismatch": return webFail(400, { code: "INVALID_REQUEST", error: SIZE_MISMATCH_ERROR });
        case "refused": return webFail(refusedStatus(outcome.reason), { code: "IMAGE_REFUSED", error: refusedMessage(outcome), details: { reason: outcome.reason, ...outcome.details } });
        case "file_upload_quota": return webFileUploadQuotaRefusal(payingServer(reader), outcome.error, "artifact_comment_image");
        case "unavailable": return webFail(503, { code: "ARTIFACTS_STORAGE_UNAVAILABLE", error: STORAGE_UNAVAILABLE_ERROR });
        case "gone": return webNotVisible();
      }
    }),
  };
}

export function createCommentImageOperations() {
  return {
    /** artifactCommentImageUpload: the flag and the Artifact (one 404), an agent who takes part in it (403), then the upload. */
    uploadCommentImage: (agent: ArtifactAgent, params: AgentApiArtifactParams, input: ImageUploadInput): Promise<ArtifactApiResult<AgentApiArtifactCommentImage>> => answer(async () => {
      const item = await resolveVisibleItem(agent, params.artifact);
      if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("comment on it");
      if (input.contentType?.split(";")[0]!.trim().toLowerCase() !== "application/octet-stream") {
        return fail(400, { code: "agent_api_contract_invalid", error: "An image upload's body is the image's bytes, sent as application/octet-stream: send it with that Content-Type." });
      }
      const outcome = await storeUpload(item, agentActor(agent), payingServer(agent), input);
      switch (outcome.kind) {
        case "stored": return json<AgentApiArtifactCommentImage>({ ...outcome.image }, 201);
        case "length_required": return fail(411, { code: "CONTENT_LENGTH_REQUIRED", error: LENGTH_REQUIRED_ERROR });
        case "too_large": return fail(413, { code: "FILE_TOO_LARGE", error: tooLargeError(outcome.size), details: { path: null, size: outcome.size, limit: ARTIFACT_COMMENT_IMAGE_MAX_BYTES } });
        case "size_mismatch": return fail(400, { code: "SIZE_MISMATCH", error: SIZE_MISMATCH_ERROR, details: { path: null, size: outcome.size, actual: outcome.actual } });
        case "refused": return fail(refusedStatus(outcome.reason), { code: "IMAGE_REFUSED", error: refusedMessage(outcome), details: { reason: outcome.reason, ...outcome.details } });
        // An upgrade card offered in the Artifact's home conversation (none for one homed in the whole server or public).
        case "file_upload_quota": return fileUploadQuotaRefusal(payingServer(agent), outcome.error, "artifact_comment_image", { agentId: agent.agentId, channelId: item.homeKind === "conversation" ? item.homeChannelId : null, subject: "image" });
        case "unavailable": return storageUnavailable();
        case "gone": return notVisible();
      }
    }),

    /**
     * artifactCommentImage: the Artifact as its comments resolve
     * (artifactComments: the flag, the one 404, an outsider of a public one
     * reads no comments), then core's readObjectFile for the agent (the
     * file by kind, Artifact and id together; a comment's or a draft's image
     * alone, never the Artifact's other files such as its check shots; a draft
     * only for its uploader; the Artifact seen fully now). Anything else is
     * one 404 IMAGE_NOT_FOUND.
     */
    commentImage: (agent: ArtifactAgent, params: AgentApiArtifactCommentImageParams): Promise<ArtifactApiBytes | ArtifactApiError> => answer(async () => {
      const item = await resolveVisibleItem(agent, params.artifact);
      // One answer for an id that names no image of a comment the agent can read, whatever the reason.
      const notFound = (): ArtifactApiError => fail(404, {
        code: "IMAGE_NOT_FOUND",
        error: "No image on a comment of this artifact that you can see has that id: take the id from the comment's images in its comments.",
        next: RAFT_HINTS.artifactComments({ artifact: item.id, all: true }),
        details: { fileId: params.fileId },
      });
      if (!accessOf(agent, item).comments) return notFound();
      const file = await readObjectFile(viewActor(agent), { kind: ARTIFACT_OBJECT_KIND, objectId: item.id, fileId: params.fileId, parts: COMMENT_IMAGE_PARTS });
      switch (file.kind) {
        case "not_found": return notFound();
        case "unavailable": return storageUnavailable();
        case "file": return {
          kind: "bytes" as const,
          stream: file.stream,
          size: file.size,
          contentType: file.contentType,
          contentDisposition: `attachment; filename="${params.fileId.replace(/[^A-Za-z0-9-]/g, "")}.${file.contentType.slice("image/".length)}"`,
        };
      }
    }),
  };
}

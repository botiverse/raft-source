// FAKE DATA: comment images (#proj-workspace:#146) as the Server and core keep them, for the fake
// data source (fakeArtifactSource.ts). An upload is the reader's own until a comment or draft takes
// it (claimed once, else 400 IMAGE_NOT_FOUND); its type comes from its bytes (PNG, JPEG, WebP, GIF),
// never the declared one; a read of anything not kept is core's one 404.
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_MAX_IMAGES, asArtifactId, asObjectFileId } from "@botiverse/raft-shared";
import type { ArtifactComment, ArtifactCommentImage, ArtifactCommentImageType, ArtifactId, ArtifactWebErrorDetails, ObjectFileId } from "@botiverse/raft-shared";

import type { ArtifactApiError, ArtifactSource } from "./artifactApi";
import { WIREFRAME_PNG_BASE64 } from "./fakeArtifactFiles";

interface Kept {
  artifact: ArtifactId;
  bytes: Blob;
  image: ArtifactCommentImage;
  /** Taken by a comment or a draft: no other may name it. */
  claimed: boolean;
}

const kept = new Map<string, Kept>();
let nextUpload = 1;

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const refused = (status: number, details: ArtifactWebErrorDetails["IMAGE_REFUSED"]): ArtifactApiError => ({ status, code: "IMAGE_REFUSED", details });
const notFound = (fileId: string): ArtifactApiError => ({ status: 400, code: "IMAGE_NOT_FOUND", details: { fileId } });

/** The type the bytes are, by their first bytes only (as core sniffs them); null for anything else. */
function sniff(head: Uint8Array): ArtifactCommentImageType | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => head[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** The pixel size from the header where it is plainly there (PNG, GIF); else 1 × 1 (the fake reads no further). */
function sizeOf(type: ArtifactCommentImageType, head: Uint8Array): { width: number; height: number } {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (type === "image/png" && head.byteLength >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (type === "image/gif" && head.byteLength >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  return { width: 1, height: 1 };
}

function keep(artifact: ArtifactId, fileId: ObjectFileId, bytes: Blob, image: Omit<ArtifactCommentImage, "fileId">, claimed: boolean): ArtifactCommentImage {
  const full = { fileId, ...image };
  kept.set(fileId, { artifact, bytes, image: full, claimed });
  return full;
}

/** The uploads and reads of the fake data source (spread into it). */
export const fakeCommentImageRoutes: Pick<ArtifactSource, "uploadCommentImage" | "readCommentImage"> = {
  async uploadCommentImage(id, image, options = {}) {
    if (image.size === 0) throw refused(422, { reason: "empty" });
    if (image.size > ARTIFACT_COMMENT_IMAGE_MAX_BYTES) throw refused(413, { reason: "too_large", limit: ARTIFACT_COMMENT_IMAGE_MAX_BYTES });
    const head = new Uint8Array(await image.slice(0, 32).arrayBuffer());
    const type = sniff(head);
    if (!type) throw refused(422, { reason: "unsupported_type" });
    // Cancelled (removed while it uploads): nothing kept, as an aborted request keeps nothing.
    if (options.signal?.aborted) throw new DOMException("The upload was cancelled.", "AbortError");
    options.onProgress?.(100);
    const fileId = asObjectFileId(`00000000-0000-4000-9000-${String(nextUpload++).padStart(12, "0")}`);
    return keep(id, fileId, new Blob([image], { type }), { contentType: type, sizeBytes: image.size, ...sizeOf(type, head) }, false);
  },
  async readCommentImage(id, fileId) {
    const entry = kept.get(fileId);
    if (!entry || entry.artifact !== id) throw { status: 404, code: "NOT_FOUND" } satisfies ArtifactApiError;
    return entry.bytes;
  },
};

/**
 * The images a comment or draft names, taken for it: `{}` for none (the field absent, as the Server
 * answers), else each the reader's own unused upload to this Artifact, in order. One that isn't (or
 * is named twice) refuses the whole write, 400 IMAGE_NOT_FOUND, nothing taken; more than
 * ARTIFACT_COMMENT_MAX_IMAGES 400 INVALID_REQUEST.
 */
export function claimFakeCommentImages(artifact: ArtifactId, ids: readonly ObjectFileId[] | undefined): { images?: ArtifactCommentImage[] } {
  if (!ids || ids.length === 0) return {};
  if (ids.length > ARTIFACT_COMMENT_MAX_IMAGES) throw { status: 400, code: "INVALID_REQUEST" } satisfies ArtifactApiError;
  const seen = new Set<string>();
  const entries = ids.map((fileId) => {
    const entry = kept.get(fileId);
    if (!entry || entry.artifact !== artifact || entry.claimed || seen.has(fileId)) throw notFound(fileId);
    seen.add(fileId);
    return entry;
  });
  for (const entry of entries) entry.claimed = true;
  return { images: entries.map((entry) => entry.image) };
}

/** Comments going (deleted): their images go with them, read as gone after. */
export function releaseFakeCommentImages(comments: ReadonlyArray<Pick<ArtifactComment, "images">>): void {
  for (const comment of comments) for (const image of comment.images ?? []) kept.delete(image.fileId);
}

/** A comment kept as a placeholder for its replies: no images (they go), as on the Server. */
export function withoutFakeImages(comment: ArtifactComment): ArtifactComment {
  releaseFakeCommentImages([comment]);
  const { images: _gone, ...rest } = comment;
  return rest;
}

/** The wireframe fixture's comment image (the fake's PNG), and one whose file is gone (it shows "Image unavailable"). */
export const FAKE_COMMENT_IMAGE_ID = asObjectFileId("00000000-0000-4000-9000-f00000000001");
export const FAKE_GONE_COMMENT_IMAGE_ID = asObjectFileId("00000000-0000-4000-9000-f00000000002");
const WIREFRAME_ARTIFACT = asArtifactId("pt_fake-wireframe");

/** The images a fixture comment carries, by its key (fakeArtifactComments.json), as a field. */
export function fakeFixtureCommentImages(key: string): { images?: ArtifactCommentImage[] } {
  if (key !== "wireframe-rail") return {};
  const png = new Blob([decodeBase64(WIREFRAME_PNG_BASE64)], { type: "image/png" });
  return {
    images: [
      keep(WIREFRAME_ARTIFACT, FAKE_COMMENT_IMAGE_ID, png, { contentType: "image/png", sizeBytes: png.size, width: 64, height: 40 }, true),
      // Named by the comment, its file gone: the one 404.
      { fileId: FAKE_GONE_COMMENT_IMAGE_ID, contentType: "image/png", sizeBytes: png.size, width: 64, height: 40 },
    ],
  };
}

/**
 * For tests: the hour without a comment passed. Every upload no comment or draft took is gone, as
 * the Server's sweep lets it go: a device's kept draft naming one then reads it as expired.
 */
export function expireFakeCommentUploadsForTests(): void {
  for (const [fileId, entry] of kept) if (!entry.claimed) kept.delete(fileId);
}

/** For tests: nothing kept (the fixtures' images come back with the fixtures). */
export function resetFakeCommentImages(): void {
  kept.clear();
  nextUpload = 1;
}

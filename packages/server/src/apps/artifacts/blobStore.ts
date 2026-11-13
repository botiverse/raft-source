// Where an Artifact file's bytes are kept: Artifacts' objects in the
// platform's app-content bucket (platform/storage), at the blob row's
// `r2_key`. That key is relative to Artifacts' own prefix: the handle core
// hands the app (register.ts receiveObjectStorage) adds `apps/artifacts/`,
// and the app never holds the bucket or its credentials. Nothing is read from
// core's attachment storage; saving an attachment copies its bytes in
// (platform/attachments). Callers reach bytes only through a blobs row they
// matched exactly; nothing here takes a path from a request. Publishing
// writes at a key made of the server, the sha256 and the row.
import type { Readable } from "node:stream";
import type { AppObjectStorage } from "../../platform/storage";
import type { ArtifactBlobRow } from "./schema";

export interface ArtifactBlobBytes {
  stream: Readable;
  /** Bytes in the stream. */
  size: number;
}

/** An object a blob row names: its relative key and the size the row holds. */
export type ArtifactStoredObject = Pick<ArtifactBlobRow, "r2Key" | "sizeBytes">;

export interface ArtifactBlobReader {
  /** The object's bytes, or null when the bucket has none for it. */
  read(blob: ArtifactStoredObject, signal?: AbortSignal): Promise<ArtifactBlobBytes | null>;
  /**
   * A presigned GET for the blob, served with these Content-Type and
   * Content-Disposition headers; null when it can't presign. A bearer
   * capability: never log it.
   */
  presign(blob: ArtifactBlobRow, options: { expiresInSeconds: number; contentType: string; contentDisposition: string }): Promise<string | null>;
}

/** Artifacts' objects: read, and written and deleted by the publish path. */
export interface ArtifactR2Store extends ArtifactBlobReader {
  /** Store `bytes` at `key` (overwriting the same content-addressed bytes is harmless). */
  put(key: string, bytes: Buffer): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * A blob's key (its row's `r2_key`), relative to Artifacts' prefix in the
 * app-content bucket: per server, so one server's uploads never stand in for
 * another's, and per row (`blobId`), so an object deleted with an old row can
 * never be one a newer row of the same bytes wrote. Stored relative (the
 * row and the content manifest): the platform adds `apps/artifacts/` for
 * every operation here, and the content Worker adds it itself for its reads,
 * so no stored or sent key names a path outside Artifacts' prefix.
 */
export const r2KeyOf = (serverId: string, sha256: string, blobId: string): string => `servers/${serverId}/blobs/${sha256}/${blobId}`;

/** What a blob is stored as; a read is always served with the version file's own type, presigned or streamed. */
const STORED_CONTENT_TYPE = "application/octet-stream";

/** `Content-Disposition: attachment` for a file's last path segment (RFC 6266 / 5987). */
export function attachmentDisposition(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Artifacts' blob store on its object storage: a read is the row's
 * `r2_key` (null when there is no object), with the row's verified size.
 */
export function artifactBlobStore(storage: AppObjectStorage): ArtifactR2Store {
  return {
    async read(blob, signal) {
      const stream = await storage.get(blob.r2Key, signal);
      // An object's bytes never change once its row names it, and the row holds their verified size.
      return stream ? { stream, size: blob.sizeBytes } : null;
    },
    presign(blob, options) {
      return storage.presignGet(blob.r2Key, {
        expiresInSeconds: options.expiresInSeconds,
        responseContentType: options.contentType,
        responseContentDisposition: options.contentDisposition,
      });
    },
    put(key, bytes) {
      return storage.put(key, bytes, STORED_CONTENT_TYPE);
    },
    delete(key) {
      return storage.delete(key);
    },
  };
}

/** What core handed the app (register.ts), and the blob store on it. */
let handed: { storage: AppObjectStorage; store: ArtifactR2Store } | null = null;
let override: { store: ArtifactR2Store | null } | null = null;

/** Core hands Artifacts its object storage once, when it reads the app registry (register.ts). */
export function receiveArtifactObjectStorage(storage: AppObjectStorage): void {
  handed = { storage, store: artifactBlobStore(storage) };
}

/** Artifacts' blob store; null while the platform's app-content bucket is not configured. */
export function artifactR2Store(): ArtifactR2Store | null {
  if (override) return override.store;
  return handed?.storage.configured ? handed.store : null;
}

/** Tests: use this store for blobs (null: storage unconfigured); undefined goes back to what core handed over. */
export function __setArtifactR2StoreForTests(store: ArtifactR2Store | null | undefined): void {
  override = store === undefined ? null : { store };
}

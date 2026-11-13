// Every file of one Artifact version in one zip, for the two routes that
// answer it: the signed-out `GET /api/public/artifacts/:id/download.zip`
// (publicRoutes.ts, the current version of a public Artifact) and the
// signed-in `GET /api/artifacts/:id/download.zip?version=` (webViewer.ts,
// the version shown, behind readableItemFor as a file is). The caller has
// already decided the reader may see that version; this reads only the
// version's own file rows and their ready blobs of the item's own server.
//
// - At most ARTIFACT_ZIP_MAX_BYTES of files (the rows' sizes, summed before
//   anything is read), else `too_large` (the routes' 413
//   DOWNLOAD_TOO_LARGE).
// - A file whose blob isn't a ready one of the item's server, or no object
//   storage configured: `unavailable` (503 CONTENT_UNAVAILABLE), nothing read.
// - Built as a stream (storedZip.ts: STORE only, a file read whole when the
//   archive reaches it, so at most one file's bytes in memory, never the
//   archive's), with its exact Content-Length known before the first byte.
// - At most so many archives at once per pool and process (zipSlots.ts),
//   else `busy` (429 BUSY, Retry-After); the slot is given back when the
//   stream closes (finished, failed or the client gone), or the archive is
//   ended once it has held it too long.
// - Counted in `slock_app_operations_total` (operation `public_zip` or
//   `web_zip`: started, busy, failed, timeout).
import { addAbortSignal, type Readable } from "node:stream";
import { and, asc, eq } from "drizzle-orm";
import type { AppBytes } from "../../platform/apps";
import { getDb } from "../../platform/db";
import { countAppOperation } from "../../platform/tracing";
import { artifactR2Store, attachmentDisposition, type ArtifactBlobBytes } from "./blobStore";
import { artifactBlobs, artifactVersionFiles, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";
import { storedZip, storedZipSize, type StoredZipEntry } from "./storedZip";
import { takeZipSlot, type ZipPool } from "./zipSlots";

/** The most bytes of files one archive holds (100 MiB: about seven of the largest files a version may have). */
export const ARTIFACT_ZIP_MAX_BYTES = 100 * 1024 * 1024;

/** How long a refused (BUSY) download is told to wait. */
export const ZIP_BUSY_RETRY_AFTER_SECONDS = 5;

export type VersionZip =
  | AppBytes
  | { kind: "too_large"; limit: number }
  | { kind: "busy"; retryAfterSeconds: number }
  | { kind: "unavailable" };

const OPERATION: Record<ZipPool, string> = { public: "public_zip", web: "web_zip" };

/**
 * The archive of `version`'s files, by path, named `fileName` (an
 * attachment), or why there is none. `pool`: whose cap and count.
 */
export async function versionZipOf(item: ArtifactItemRow, version: ArtifactVersionRow, input: { pool: ZipPool; fileName: string }): Promise<VersionZip> {
  const operation = OPERATION[input.pool];
  const rows = await getDb()
    .select({ path: artifactVersionFiles.path, sizeBytes: artifactVersionFiles.sizeBytes, blob: artifactBlobs })
    .from(artifactVersionFiles)
    .leftJoin(artifactBlobs, and(
      eq(artifactBlobs.id, artifactVersionFiles.blobId),
      eq(artifactBlobs.state, "ready"),
      eq(artifactBlobs.serverId, item.serverId),
    ))
    .where(eq(artifactVersionFiles.versionId, version.id))
    .orderBy(asc(artifactVersionFiles.path));
  const total = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  if (total > ARTIFACT_ZIP_MAX_BYTES) return { kind: "too_large", limit: ARTIFACT_ZIP_MAX_BYTES };
  const reader = artifactR2Store();
  if (!reader || rows.some((row) => !row.blob)) return { kind: "unavailable" };
  const entries: StoredZipEntry[] = rows.map((row) => ({
    name: row.path,
    size: row.sizeBytes,
    read: async (signal) => {
      const bytes = await reader.read(row.blob!, signal);
      if (!bytes) throw new Error("an artifact file's bytes are missing");
      // The GET may already have returned its body when the archive is
      // canceled: terminate that stream too, not only the pending GET.
      if (signal) addAbortSignal(signal, bytes.stream);
      return readWhole(bytes, row.sizeBytes);
    },
  }));
  let stream: Readable | undefined;
  const slot = takeZipSlot(input.pool, () => {
    // Ended, not errored: the client sees a cut answer (shorter than its Content-Length), counted once as a timeout.
    countAppOperation("artifacts", operation, "timeout");
    console.warn(`artifacts ${operation} held its slot too long; ended`);
    stream?.destroy();
  });
  if (!slot) {
    countAppOperation("artifacts", operation, "busy");
    return { kind: "busy", retryAfterSeconds: ZIP_BUSY_RETRY_AFTER_SECONDS };
  }
  try {
    stream = storedZip(entries, version.createdAt);
  } catch (err) {
    slot.release();
    countAppOperation("artifacts", operation, "failed");
    throw err;
  }
  countAppOperation("artifacts", operation, "started");
  // A failed file (missing bytes, a wrong size) errors the stream: counted once.
  stream.once("error", () => countAppOperation("artifacts", operation, "failed"));
  // Closed however it ends (finished, failed, or destroyed when the client goes away): the slot is free again.
  stream.once("close", () => slot.release());
  return {
    kind: "bytes",
    stream,
    size: storedZipSize(entries),
    contentType: "application/zip",
    contentDisposition: attachmentDisposition(input.fileName),
  };
}

/** A file name for an archive: the title's letters, digits, spaces, dots, dashes and underscores (at most 80), else the id. */
export function zipBaseName(item: ArtifactItemRow): string {
  const safe = item.title.normalize("NFKD").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return safe || item.id;
}

/** A blob's whole bytes (at most `maxBytes`: its row's size), closing the stream. */
async function readWhole(bytes: ArtifactBlobBytes, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) throw new Error("an artifact file is larger than its row says");
      chunks.push(buffer);
    }
  } finally {
    bytes.stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

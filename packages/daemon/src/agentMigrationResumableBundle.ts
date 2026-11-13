import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pack, type Headers, type Pack } from "tar-stream";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  MAX_AGENT_MIGRATION_TRANSFER_BYTES,
  agentMigrationTransferSummarySchema,
  currentDate,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
} from "@botiverse/raft-shared";
import {
  AgentMigrationChunkDigestMismatchError,
  AgentMigrationWholeBundleDigestMismatchError,
  normalizeAgentMigrationArchiveRelativePath,
  normalizeAgentMigrationSymlinkTarget,
  readAgentMigrationBundle,
  readVerifiedAgentMigrationChunks,
} from "@botiverse/raft-shared/src/agentMigrationBundleReader";
import {
  agentMigrationTopLevelPath,
  isNotesPath,
  listAgentMigrationWorkspace,
  summarizeAgentMigrationTransfer,
  type AgentMigrationExportProgress,
} from "./agentMigrationExport";
import {
  assertAgentMigrationObjectStoreEntryLimit,
  bundleTooLargeTopEntries,
} from "./agentMigrationObjectStoreBundle";

export {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
};

const ARCHIVE_WORKSPACE_PREFIX = "workspace/";
const CONTROL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type AgentMigrationTargetResidueClass =
  | "idle"
  | "complete-old-copy"
  | "failed-residue"
  | "user-owned";

export interface AgentMigrationTargetResidue {
  classification: AgentMigrationTargetResidueClass;
  finalWorkspacePath: string;
  generationRootPath: string;
  committed?: AgentMigrationCommitMarker;
}

export interface AgentMigrationCommitMarker {
  schemaVersion: "agent-migration-commit/v1";
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  agentId: string;
  sourceMachineId: string;
  targetMachineId: string;
  controlSha256: string;
  bundleSha256: string;
  committedAt: string;
}

export interface StageAgentMigrationResumableBundleInput {
  control: AgentMigrationControlManifest;
  controlSha256?: string;
  slockHome: string;
  chunksDirectory: string;
  finalWorkspacePath: string;
  now?: Date;
}

export interface StageAgentMigrationResumableBundleResult {
  outcome: "committed" | "already-committed";
  finalWorkspacePath: string;
  marker: AgentMigrationCommitMarker;
  extractedEntries: number;
  extractedBytes: number;
}

/** The target's local placement steps, in order. Each one is traced separately. */
export type AgentMigrationPlacementStep = "verify" | "unpack" | "commit";

export interface StageAgentMigrationResumableBundleDependencies {
  renameWorkspace?: (sourcePath: string, targetPath: string) => Promise<void>;
  traceStep?: <T>(step: AgentMigrationPlacementStep, work: () => Promise<T>) => Promise<T>;
}

export class AgentMigrationControlManifestError extends Error {
  readonly code = "MIGRATION_CONTROL_MANIFEST_INVALID";
}

export class AgentMigrationControlManifestTooLargeError extends Error {
  readonly code = "MIGRATION_CONTROL_MANIFEST_TOO_LARGE";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly chunkCount: number,
  ) {
    super(
      `MIGRATION_CONTROL_MANIFEST_TOO_LARGE:actualBytes=${actualBytes}`
      + `:maxBytes=${maxBytes}:chunkCount=${chunkCount}`,
    );
    this.name = "AgentMigrationControlManifestTooLargeError";
  }
}

export { AgentMigrationChunkDigestMismatchError, AgentMigrationWholeBundleDigestMismatchError };

export class AgentMigrationWorkspaceConflictError extends Error {
  readonly code: "MIGRATION_WORKSPACE_ALREADY_EXISTS" | "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY";

  constructor(code: AgentMigrationWorkspaceConflictError["code"]) {
    super(code);
    this.code = code;
    this.name = "AgentMigrationWorkspaceConflictError";
  }
}

export interface StreamAgentMigrationResumableBundleInput {
  agentId: string;
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  sourceMachineId: string;
  targetMachineId: string;
  workspacePath: string;
  maxBytes: number;
  /** Test seam; defaults to AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES. */
  maxEntries?: number;
  /** Test seam; defaults to MAX_AGENT_MIGRATION_TRANSFER_BYTES, the summary's uncompressed cap. */
  maxExpandedBytes?: number;
  chunkSizeBytes?: number;
  /** Chunks uploading at once; each one holds its bytes in memory. */
  uploadConcurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AgentMigrationExportProgress) => void;
  /**
   * The Server advertised SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1,
   * so the transfer summary may carry `excludedIgnoredBySource`. Read when the
   * summary is built, after the walk, so a reconnect meanwhile is followed.
   */
  reportIgnoredBySource?: () => boolean;
  /** Uploads one sealed chunk (retrying is up to the caller); a rejection fails the bundle. */
  uploadChunk(chunk: AgentMigrationControlChunk, bytes: Buffer): Promise<void>;
}

export interface StreamedAgentMigrationResumableBundle {
  control: AgentMigrationControlManifest;
  controlSha256: string;
  controlBytes: number;
  /** Files whose size changed while packing (first few); each was cut or zero-padded to its listed size. */
  resizedEntries: string[];
  resizedEntryCount: number;
}

const STREAMED_UPLOAD_CONCURRENCY = 3;
const READ_AHEAD_ENTRIES = 16;
// Read whole into memory ahead of the tar writer; larger files are streamed.
const READ_AHEAD_MAX_FILE_BYTES = 1024 * 1024;
const RESIZED_ENTRIES_REPORTED = 20;
const SCAN_PROGRESS_EVERY_ENTRIES = 1_000;

/**
 * Builds the bundle in one pass and uploads it as it goes: no temp file and no
 * per-file list in memory. The workspace is listed once to check the entry
 * limit (nothing is read), then listed again in the same order while each file
 * is read once into tar+gzip; every full chunk of output is hashed and handed
 * to `uploadChunk` right away. A failed upload fails the whole bundle; the
 * migration is retried from scratch.
 */
export async function streamAgentMigrationResumableBundle(
  input: StreamAgentMigrationResumableBundleInput,
): Promise<StreamedAgentMigrationResumableBundle> {
  assertPositiveSafeInteger(input.maxBytes, "MIGRATION_OBJECT_STORE_MAX_BYTES_INVALID");
  const maxEntries = input.maxEntries ?? AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES;
  assertPositiveSafeInteger(maxEntries, "MIGRATION_OBJECT_STORE_MAX_ENTRIES_INVALID");
  const chunkSizeBytes = input.chunkSizeBytes ?? AGENT_MIGRATION_DEFAULT_CHUNK_BYTES;
  assertChunkSize(chunkSizeBytes);
  assertIdentityFields(input);
  const workspacePath = path.resolve(input.workspacePath);

  let listedEntries = 0;
  let measuredIgnoredEntries = 0;
  const countByTopLevelPath = new Map<string, number>();
  const reportScan = () => input.onProgress?.({
    phase: "scanning",
    files: listedEntries + measuredIgnoredEntries,
    bytes: 0,
  });
  const listing = await listAgentMigrationWorkspace({
    workspacePath,
    onProgress(progress) {
      measuredIgnoredEntries = progress.files;
      reportScan();
    },
    onEntry(relativePath) {
      input.signal?.throwIfAborted();
      if (relativePath === AGENT_MIGRATION_COMMIT_MARKER_PATH) return;
      listedEntries += 1;
      const topLevelPath = agentMigrationTopLevelPath(relativePath);
      countByTopLevelPath.set(topLevelPath, (countByTopLevelPath.get(topLevelPath) ?? 0) + 1);
      if (listedEntries % SCAN_PROGRESS_EVERY_ENTRIES === 0) reportScan();
    },
  });
  assertAgentMigrationObjectStoreEntryLimit([], maxEntries, {
    entryCount: listedEntries,
    countByTopLevelPath,
  });

  const chunkWriter = new StreamedChunkWriter(
    chunkSizeBytes,
    input.uploadConcurrency ?? STREAMED_UPLOAD_CONCURRENCY,
    input.uploadChunk,
  );
  const tarPack = pack();
  const archiveWrite = pipeline(
    tarPack,
    createGzip({ level: 6 }),
    createByteLimit(input.maxBytes),
    chunkWriter,
  );
  const totals = { entries: 0, bytes: 0, maxEntryBytes: 0, memoryMdPresent: false, notesPresent: false };
  const resizedEntries: string[] = [];
  let resizedEntryCount = 0;
  let stopped = false;
  // Small files are read a few entries ahead of the tar writer; they are still
  // written in walk order, so the bundle bytes do not depend on read timing.
  const readAhead: Array<{ relativePath: string; prepared: Promise<PreparedWorkspaceEntry | null> }> = [];
  const writeNext = async () => {
    const next = readAhead.shift()!;
    const prepared = await next.prepared;
    if (!prepared) return;
    const packed = await writePreparedWorkspaceEntry(tarPack, prepared);
    if (!packed) return;
    const relativePath = next.relativePath;
    totals.entries += 1;
    // The workspace grew between the two walks.
    if (totals.entries > maxEntries) {
      assertAgentMigrationObjectStoreEntryLimit([], maxEntries, {
        entryCount: totals.entries,
        countByTopLevelPath,
      });
    }
    totals.bytes += packed.sizeBytes;
    totals.maxEntryBytes = Math.max(totals.maxEntryBytes, packed.sizeBytes);
    if (relativePath === "MEMORY.md") totals.memoryMdPresent = true;
    if (isNotesPath(relativePath)) totals.notesPresent = true;
    if (packed.resized) {
      resizedEntryCount += 1;
      if (resizedEntries.length < RESIZED_ENTRIES_REPORTED) resizedEntries.push(relativePath);
    }
    input.onProgress?.({ phase: "packing", files: totals.entries, bytes: totals.bytes });
  };
  const packing = (async () => {
    await listAgentMigrationWorkspace({
      workspacePath,
      measureIgnored: false,
      async onEntry(relativePath) {
        if (stopped) throw new Error("MIGRATION_OBJECT_STORE_BUNDLE_ABORTED");
        input.signal?.throwIfAborted();
        if (relativePath === AGENT_MIGRATION_COMMIT_MARKER_PATH) return;
        const prepared = prepareWorkspaceEntry(workspacePath, relativePath);
        // Awaited later, in order; this only keeps an early failure from going unhandled.
        prepared.catch(() => undefined);
        readAhead.push({ relativePath, prepared });
        if (readAhead.length >= READ_AHEAD_ENTRIES) await writeNext();
      },
    });
    while (readAhead.length > 0) await writeNext();
    tarPack.finalize();
  })();
  packing.catch((error: unknown) => {
    tarPack.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  try {
    await Promise.all([archiveWrite, packing]);
  } catch (error) {
    if (error instanceof AgentMigrationBundleTooLargeError) {
      // Packing stopped partway, so walk the whole tree again (stat only) to
      // name the largest paths, not just the ones packed before the limit.
      const bytesByTopLevelPath = await measureWorkspaceBytesByTopLevelPath(workspacePath).catch(() => null);
      if (!bytesByTopLevelPath) throw error;
      throw new Error(`${error.message}:topEntries=${bundleTooLargeTopEntries(bytesByTopLevelPath)}`);
    }
    throw error;
  } finally {
    stopped = true;
  }

  // The transfer summary caps the uncompressed total too. A workspace over it
  // that still compressed under the byte limit would otherwise fail the
  // summary's validation with raw validator output; report it as the same
  // too-large error, with the largest paths, so it can be explained.
  const maxExpandedBytes = input.maxExpandedBytes ?? MAX_AGENT_MIGRATION_TRANSFER_BYTES;
  if (totals.bytes > maxExpandedBytes) {
    const tooLarge = `MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=${totals.bytes}:maxBytes=${maxExpandedBytes}`;
    const bytesByTopLevelPath = await measureWorkspaceBytesByTopLevelPath(workspacePath).catch(() => null);
    throw new Error(bytesByTopLevelPath ? `${tooLarge}:topEntries=${bundleTooLargeTopEntries(bytesByTopLevelPath)}` : tooLarge);
  }

  const control = buildControlManifest(input, {
    bundle: {
      totalBytes: chunkWriter.totalBytes,
      sha256: chunkWriter.bundleSha256(),
      chunkSizeBytes,
      chunks: chunkWriter.chunks,
    },
    archive: { entryCount: totals.entries, expandedBytes: totals.bytes, maxEntryBytes: totals.maxEntryBytes },
    transferSummary: summarizeAgentMigrationTransfer({
      includedFileCount: totals.entries,
      includedBytes: totals.bytes,
      memoryMdPresent: totals.memoryMdPresent,
      notesPresent: totals.notesPresent,
      excludedRegenerable: listing.excludedRegenerable,
      excludedIgnored: listing.excludedIgnored,
      reportIgnoredBySource: input.reportIgnoredBySource?.() === true,
    }),
  });
  const { sha256: controlSha256, bytes: controlBytes } = validateAgentMigrationControlManifest(control);
  return { control, controlSha256, controlBytes, resizedEntries, resizedEntryCount };
}

type PreparedWorkspaceEntry =
  | { kind: "buffered"; header: Headers; bytes: Buffer; resized: boolean }
  | { kind: "streamed"; header: Headers; sourcePath: string; sizeBytes: number };

/**
 * Stats one listed workspace path and reads it if it is small. Returns null
 * for a path that vanished, is no longer a file or symlink, or links outside
 * the workspace; such paths are not moved, as with a full export.
 */
async function prepareWorkspaceEntry(
  workspacePath: string,
  relativePath: string,
): Promise<PreparedWorkspaceEntry | null> {
  const archiveRelativePath = normalizeAgentMigrationArchiveRelativePath(relativePath);
  const name = `${ARCHIVE_WORKSPACE_PREFIX}${archiveRelativePath}`;
  const sourcePath = path.join(workspacePath, ...archiveRelativePath.split("/"));
  let entryStat;
  try {
    entryStat = await lstat(sourcePath);
  } catch {
    return null;
  }
  const mode = archiveMode(entryStat.mode);
  const mtime = archiveMtime(entryStat.mtimeMs);
  if (entryStat.isSymbolicLink()) {
    let linkname: string;
    try {
      linkname = normalizeAgentMigrationSymlinkTarget(archiveRelativePath, await readlink(sourcePath));
    } catch {
      return null;
    }
    return { kind: "buffered", header: { name, type: "symlink", size: 0, mode, mtime, linkname }, bytes: Buffer.alloc(0), resized: false };
  }
  if (!entryStat.isFile()) return null;
  const sizeBytes = entryStat.size;
  const header: Headers = { name, type: "file", size: sizeBytes, mode, mtime };
  if (sizeBytes > READ_AHEAD_MAX_FILE_BYTES) return { kind: "streamed", header, sourcePath, sizeBytes };
  const read = await readFileExactly(sourcePath, sizeBytes);
  return read ? { kind: "buffered", header, ...read } : null;
}

async function writePreparedWorkspaceEntry(
  tarPack: Pack,
  prepared: PreparedWorkspaceEntry,
): Promise<{ sizeBytes: number; resized: boolean } | null> {
  if (prepared.kind === "buffered") {
    await writeBufferedEntry(tarPack, prepared.header, prepared.bytes);
    return { sizeBytes: prepared.bytes.byteLength, resized: prepared.resized };
  }
  // Open before the tar entry exists, so a file that vanished is skipped like a small one.
  const handle = await openIfPresent(prepared.sourcePath);
  if (!handle) return null;
  try {
    const { readBytes, sizeAfterRead } = await pipeFileExactly(
      handle,
      prepared.sizeBytes,
      tarPack.entry(prepared.header),
    );
    return {
      sizeBytes: prepared.sizeBytes,
      resized: readBytes !== prepared.sizeBytes || sizeAfterRead !== prepared.sizeBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Null if the file vanished after it was listed. */
async function openIfPresent(sourcePath: string): Promise<FileHandle | null> {
  try {
    return await open(sourcePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Reads exactly `sizeBytes` (zero-padded if the file shrank, cut if it grew).
 * Returns null if the file vanished after it was listed.
 */
export async function readFileExactly(
  sourcePath: string,
  sizeBytes: number,
): Promise<{ bytes: Buffer; resized: boolean } | null> {
  const handle = await openIfPresent(sourcePath);
  if (!handle) return null;
  try {
    const bytes = Buffer.alloc(sizeBytes);
    let readBytes = 0;
    while (readBytes < sizeBytes) {
      const { bytesRead } = await handle.read(bytes, readBytes, sizeBytes - readBytes, readBytes);
      if (bytesRead === 0) break;
      readBytes += bytesRead;
    }
    const sizeAfterRead = (await handle.stat()).size;
    return { bytes, resized: readBytes !== sizeBytes || sizeAfterRead !== sizeBytes };
  } finally {
    await handle.close();
  }
}

/**
 * The tar header already promised `sizeBytes`, so exactly that many bytes are
 * written: a file that grew is cut, one that shrank is padded with zeros.
 * Either way the archive stays valid.
 */
export async function pipeFileExactly(
  handle: FileHandle,
  sizeBytes: number,
  destination: Writable,
): Promise<{ readBytes: number; sizeAfterRead: number }> {
  let readBytes = 0;
  const exactBytes = async function* (): AsyncGenerator<Buffer> {
    if (sizeBytes > 0) {
      for await (const value of handle.createReadStream({ start: 0, end: sizeBytes - 1, autoClose: false })) {
        const chunk = value as Buffer;
        readBytes += chunk.byteLength;
        yield chunk;
      }
    }
    for (let missing = sizeBytes - readBytes; missing > 0;) {
      const padding = Math.min(missing, 64 * 1024);
      yield Buffer.alloc(padding);
      missing -= padding;
    }
  };
  await pipeline(Readable.from(exactBytes()), destination);
  return { readBytes, sizeAfterRead: (await handle.stat()).size };
}

/**
 * Cuts the compressed stream into fixed-size chunks, hashes each, and uploads
 * up to `concurrency` at a time; writing waits for a free slot, so packing
 * never runs more than that far ahead of the upload.
 */
class StreamedChunkWriter extends Writable {
  readonly chunks: AgentMigrationControlChunk[] = [];
  totalBytes = 0;
  private readonly wholeHash = createHash("sha256");
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private failure: unknown = null;

  constructor(
    private readonly chunkSizeBytes: number,
    private readonly concurrency: number,
    private readonly upload: (chunk: AgentMigrationControlChunk, bytes: Buffer) => Promise<void>,
  ) {
    super();
  }

  bundleSha256(): string {
    return this.wholeHash.digest("hex");
  }

  override _write(data: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.accept(data).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.finish().then(() => callback(), callback);
  }

  private async accept(data: Buffer): Promise<void> {
    this.wholeHash.update(data);
    let rest = data;
    while (rest.byteLength > 0) {
      const piece = rest.subarray(0, this.chunkSizeBytes - this.pendingBytes);
      this.pending.push(piece);
      this.pendingBytes += piece.byteLength;
      rest = rest.subarray(piece.byteLength);
      if (this.pendingBytes === this.chunkSizeBytes) await this.seal();
    }
  }

  private async finish(): Promise<void> {
    if (this.pendingBytes > 0) await this.seal();
    if (this.chunks.length === 0) throw new Error("MIGRATION_OBJECT_STORE_BUNDLE_EMPTY");
    await Promise.all(this.inFlight);
    this.throwIfFailed();
  }

  private async seal(): Promise<void> {
    const bytes = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    const chunk: AgentMigrationControlChunk = {
      index: this.chunks.length,
      offsetBytes: this.totalBytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    if (chunk.index >= AGENT_MIGRATION_MAX_CHUNKS) {
      throw new Error("MIGRATION_CONTROL_CHUNK_COUNT_LIMIT_EXCEEDED");
    }
    this.chunks.push(chunk);
    this.totalBytes += bytes.byteLength;
    while (this.inFlight.size >= this.concurrency) {
      await Promise.race(this.inFlight);
      this.throwIfFailed();
    }
    this.throwIfFailed();
    const uploading: Promise<void> = this.upload(chunk, bytes)
      .catch((error: unknown) => {
        this.failure ??= error;
      })
      .finally(() => {
        this.inFlight.delete(uploading);
      });
    this.inFlight.add(uploading);
  }

  private throwIfFailed(): void {
    if (this.failure !== null) {
      throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
    }
  }
}

function buildControlManifest(
  identity: {
    migrationId: string;
    migrationGeneration: string;
    leaseId: string;
    agentId: string;
    sourceMachineId: string;
    targetMachineId: string;
  },
  input: {
    bundle: { totalBytes: number; sha256: string; chunkSizeBytes: number; chunks: AgentMigrationControlChunk[] };
    archive: { entryCount: number; expandedBytes: number; maxEntryBytes: number };
    transferSummary: AgentMigrationControlManifest["transferSummary"];
  },
): AgentMigrationControlManifest {
  return {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: identity.migrationId,
      migrationGeneration: identity.migrationGeneration,
      leaseId: identity.leaseId,
      agentId: identity.agentId,
      sourceMachineId: identity.sourceMachineId,
      targetMachineId: identity.targetMachineId,
    },
    capability: { required: [AGENT_MIGRATION_CAPABILITY] },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      ...input.bundle,
    },
    archive: {
      format: "tar+gzip",
      ...input.archive,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: input.transferSummary,
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  };
}

export function validateAgentMigrationControlManifest(control: AgentMigrationControlManifest): {
  sha256: string;
  bytes: number;
} {
  if (
    !control
    || typeof control !== "object"
    || control.schemaVersion !== AGENT_MIGRATION_CONTROL_SCHEMA_VERSION
    || control.protocol !== AGENT_MIGRATION_RESUMABLE_PROTOCOL
    || !control.identity
    || !control.capability
    || !Array.isArray(control.capability.required)
    || !control.bundle
    || !Array.isArray(control.bundle.chunks)
    || !control.archive
    || !control.commit
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  assertIdentityFields(control.identity);
  if (
    control.capability.required.length !== 1
    || control.capability.required[0] !== AGENT_MIGRATION_CAPABILITY
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_CAPABILITY_UNSUPPORTED");
  }
  assertPositiveSafeInteger(control.bundle.totalBytes, "MIGRATION_CONTROL_TOTAL_BYTES_INVALID");
  assertChunkSize(control.bundle.chunkSizeBytes);
  if (
    control.bundle.contentType !== AGENT_MIGRATION_BUNDLE_CONTENT_TYPE
    || !CONTROL_DIGEST_PATTERN.test(control.bundle.sha256)
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_BUNDLE_DIGEST_INVALID");
  }
  if (
    control.bundle.chunks.length === 0
    || control.bundle.chunks.length > AGENT_MIGRATION_MAX_CHUNKS
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_CHUNK_COUNT_INVALID");
  }
  let expectedOffset = 0;
  for (let index = 0; index < control.bundle.chunks.length; index += 1) {
    const chunk = control.bundle.chunks[index];
    if (
      chunk.index !== index
      || chunk.offsetBytes !== expectedOffset
      || !Number.isSafeInteger(chunk.sizeBytes)
      || chunk.sizeBytes <= 0
      || chunk.sizeBytes > control.bundle.chunkSizeBytes
      || !CONTROL_DIGEST_PATTERN.test(chunk.sha256)
    ) {
      throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_CHUNK_INVALID");
    }
    expectedOffset += chunk.sizeBytes;
  }
  if (expectedOffset !== control.bundle.totalBytes) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_CHUNK_TOTAL_MISMATCH");
  }
  if (
    control.archive.format !== "tar+gzip"
    || control.archive.allowedEntryTypes.length !== 2
    || control.archive.allowedEntryTypes[0] !== "file"
    || control.archive.allowedEntryTypes[1] !== "symlink"
    || !Number.isSafeInteger(control.archive.entryCount)
    || control.archive.entryCount < 0
    || control.archive.entryCount > AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES
    || !Number.isSafeInteger(control.archive.expandedBytes)
    || control.archive.expandedBytes < 0
    || !Number.isSafeInteger(control.archive.maxEntryBytes)
    || control.archive.maxEntryBytes < 0
    || control.archive.maxEntryBytes > control.archive.expandedBytes
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_ARCHIVE_LIMIT_INVALID");
  }
  const transferSummary = agentMigrationTransferSummarySchema.safeParse(control.transferSummary);
  if (
    !transferSummary.success
    || transferSummary.data.includedFileCount !== control.archive.entryCount
    || transferSummary.data.includedBytes !== control.archive.expandedBytes
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_TRANSFER_SUMMARY_INVALID");
  }
  if (
    control.commit.mode !== "atomic-rename"
    || control.commit.markerPath !== AGENT_MIGRATION_COMMIT_MARKER_PATH
    || control.commit.requireWholeBundleDigest !== true
    || control.commit.requireAllChunkDigests !== true
    || control.commit.existingWorkspace !== "idle-or-same-commit"
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_COMMIT_CONDITION_INVALID");
  }

  const payload = Buffer.from(canonicalJson(control), "utf8");
  if (payload.byteLength > AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES) {
    throw new AgentMigrationControlManifestTooLargeError(
      payload.byteLength,
      AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
      control.bundle.chunks.length,
    );
  }
  return { sha256: sha256Buffer(payload), bytes: payload.byteLength };
}

export async function verifyAndStoreAgentMigrationChunk(input: {
  control: AgentMigrationControlManifest;
  chunkIndex: number;
  chunk: Readable;
  chunksDirectory: string;
}): Promise<{ outcome: "stored" | "reused"; chunkPath: string }> {
  validateAgentMigrationControlManifest(input.control);
  const expected = input.control.bundle.chunks[input.chunkIndex];
  if (!expected || expected.index !== input.chunkIndex) {
    throw new Error("MIGRATION_CHUNK_INDEX_INVALID");
  }
  const chunksDirectory = path.resolve(input.chunksDirectory);
  await mkdir(chunksDirectory, { recursive: true });
  const chunkPath = path.join(chunksDirectory, `${expected.index}.chunk`);
  if (await pathExists(chunkPath)) {
    const existing = await hashFile(chunkPath);
    if (existing.sizeBytes === expected.sizeBytes && existing.sha256 === expected.sha256) {
      return { outcome: "reused", chunkPath };
    }
    throw new AgentMigrationChunkDigestMismatchError(expected.index);
  }

  const partialPath = path.join(
    chunksDirectory,
    `${expected.index}.partial-${process.pid}-${randomUUID()}`,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  const digesting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > expected.sizeBytes) {
        callback(new AgentMigrationChunkDigestMismatchError(expected.index));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      input.chunk,
      digesting,
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
    );
    if (bytes !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) {
      throw new AgentMigrationChunkDigestMismatchError(expected.index);
    }
    await rename(partialPath, chunkPath);
    return { outcome: "stored", chunkPath };
  } catch (error) {
    // A digest mismatch keeps its partial as evidence of corrupt bytes. Any
    // other failure (connection dropped mid-body, stream error) deletes it: the
    // caller retries the chunk until the lease expires, and each attempt writes
    // its own partial, so keeping them would pile up on a flapping network.
    // Nothing reads partials; a successful migration deletes the directory.
    if (!(error instanceof AgentMigrationChunkDigestMismatchError)) {
      await unlink(partialPath).catch(() => undefined);
    }
    throw error;
  }
}

export async function missingAgentMigrationChunks(input: {
  control: AgentMigrationControlManifest;
  chunksDirectory: string;
}): Promise<number[]> {
  validateAgentMigrationControlManifest(input.control);
  const missing: number[] = [];
  for (const expected of input.control.bundle.chunks) {
    const chunkPath = path.join(path.resolve(input.chunksDirectory), `${expected.index}.chunk`);
    if (!await pathExists(chunkPath)) {
      missing.push(expected.index);
      continue;
    }
    const existing = await hashFile(chunkPath);
    if (existing.sizeBytes !== expected.sizeBytes || existing.sha256 !== expected.sha256) {
      throw new AgentMigrationChunkDigestMismatchError(expected.index);
    }
  }
  return missing;
}

export async function classifyAgentMigrationTargetResidue(input: {
  control: AgentMigrationControlManifest;
  controlSha256?: string;
  slockHome: string;
  finalWorkspacePath: string;
}): Promise<AgentMigrationTargetResidue> {
  const controlValidation = validateAgentMigrationControlManifest(input.control);
  const controlSha256 = input.controlSha256 ?? controlValidation.sha256;
  if (controlSha256 !== controlValidation.sha256) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_DIGEST_MISMATCH");
  }
  const finalWorkspacePath = path.resolve(input.finalWorkspacePath);
  const generationRootPath = generationRoot(input.slockHome, input.control);
  if (await pathExists(finalWorkspacePath)) {
    const committed = await readCommitMarker(finalWorkspacePath);
    return committed
      ? { classification: "complete-old-copy", finalWorkspacePath, generationRootPath, committed }
      : { classification: "user-owned", finalWorkspacePath, generationRootPath };
  }
  if (await pathExists(generationRootPath)) {
    return { classification: "failed-residue", finalWorkspacePath, generationRootPath };
  }
  return { classification: "idle", finalWorkspacePath, generationRootPath };
}

export async function stageAndCommitAgentMigrationResumableBundle(
  input: StageAgentMigrationResumableBundleInput,
  dependencies: StageAgentMigrationResumableBundleDependencies = {},
): Promise<StageAgentMigrationResumableBundleResult> {
  const validated = validateAgentMigrationControlManifest(input.control);
  const controlSha256 = input.controlSha256 ?? validated.sha256;
  if (controlSha256 !== validated.sha256) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_DIGEST_MISMATCH");
  }
  const residue = await classifyAgentMigrationTargetResidue({
    control: input.control,
    controlSha256,
    slockHome: input.slockHome,
    finalWorkspacePath: input.finalWorkspacePath,
  });
  if (residue.classification === "complete-old-copy" && residue.committed) {
    if (commitMarkerMatches(residue.committed, input.control, controlSha256)) {
      return {
        outcome: "already-committed",
        finalWorkspacePath: residue.finalWorkspacePath,
        marker: residue.committed,
        extractedEntries: input.control.archive.entryCount,
        extractedBytes: input.control.archive.expandedBytes,
      };
    }
    throw new AgentMigrationWorkspaceConflictError("MIGRATION_WORKSPACE_COMPLETE_OLD_COPY");
  }
  if (residue.classification === "user-owned") {
    throw new AgentMigrationWorkspaceConflictError("MIGRATION_WORKSPACE_ALREADY_EXISTS");
  }
  const traceStep: NonNullable<StageAgentMigrationResumableBundleDependencies["traceStep"]> =
    dependencies.traceStep ?? ((_step, work) => work());
  await traceStep("verify", async () => {
    const missing = await missingAgentMigrationChunks({
      control: input.control,
      chunksDirectory: input.chunksDirectory,
    });
    if (missing.length > 0) throw new Error(`MIGRATION_CHUNKS_MISSING:${missing.join(",")}`);
  });

  const { stagingWorkspacePath, extraction } = await traceStep("unpack", async () => {
    await mkdir(residue.generationRootPath, { recursive: true });
    const attemptRoot = await mkdtemp(path.join(residue.generationRootPath, "extracting-"));
    const stagingWorkspacePath = path.join(attemptRoot, "workspace");
    await mkdir(stagingWorkspacePath, { recursive: true });
    const extraction = await extractVerifiedArchive({
      control: input.control,
      chunksDirectory: input.chunksDirectory,
      stagingWorkspacePath,
    });
    return { stagingWorkspacePath, extraction };
  });
  return traceStep("commit", () => commitStagedWorkspace({
    control: input.control,
    controlSha256,
    now: input.now,
    stagingWorkspacePath,
    finalWorkspacePath: residue.finalWorkspacePath,
    extraction,
    renameWorkspace: dependencies.renameWorkspace ?? rename,
  }));
}

async function commitStagedWorkspace(input: {
  control: AgentMigrationControlManifest;
  controlSha256: string;
  now?: Date;
  stagingWorkspacePath: string;
  finalWorkspacePath: string;
  extraction: { entries: number; bytes: number };
  renameWorkspace: (sourcePath: string, targetPath: string) => Promise<void>;
}): Promise<StageAgentMigrationResumableBundleResult> {
  const { controlSha256, stagingWorkspacePath, finalWorkspacePath, extraction } = input;
  const marker: AgentMigrationCommitMarker = {
    schemaVersion: "agent-migration-commit/v1",
    ...input.control.identity,
    controlSha256,
    bundleSha256: input.control.bundle.sha256,
    committedAt: (input.now ?? currentDate()).toISOString(),
  };
  const markerPath = path.join(stagingWorkspacePath, ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/"));
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${canonicalJson(marker)}\n`, { flag: "wx", mode: 0o600 });
  await mkdir(path.dirname(finalWorkspacePath), { recursive: true });
  try {
    await input.renameWorkspace(stagingWorkspacePath, finalWorkspacePath);
  } catch (error) {
    if (await pathExists(finalWorkspacePath)) {
      const existing = await readCommitMarker(finalWorkspacePath);
      if (existing && commitMarkerMatches(existing, input.control, controlSha256)) {
        return {
          outcome: "already-committed",
          finalWorkspacePath,
          marker: existing,
          extractedEntries: extraction.entries,
          extractedBytes: extraction.bytes,
        };
      }
      throw new AgentMigrationWorkspaceConflictError(
        existing ? "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY" : "MIGRATION_WORKSPACE_ALREADY_EXISTS",
      );
    }
    throw error;
  }
  return {
    outcome: "committed",
    finalWorkspacePath,
    marker,
    extractedEntries: extraction.entries,
    extractedBytes: extraction.bytes,
  };
}

async function extractVerifiedArchive(input: {
  control: AgentMigrationControlManifest;
  chunksDirectory: string;
  stagingWorkspacePath: string;
}): Promise<{ entries: number; bytes: number }> {
  const chunksDirectory = path.resolve(input.chunksDirectory);
  return await readAgentMigrationBundle({
    control: input.control,
    chunks: readVerifiedAgentMigrationChunks(
      input.control,
      (chunk) => createReadStream(path.join(chunksDirectory, `${chunk.index}.chunk`)),
    ),
    onEntry: async (entry) => {
      const targetPath = path.join(input.stagingWorkspacePath, ...entry.relativePath.split("/"));
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (entry.type === "symlink") {
        await symlink(entry.linkTarget, targetPath);
        return;
      }
      await pipeline(entry.stream, createWriteStream(targetPath, { flags: "wx", mode: entry.mode }));
      await chmod(targetPath, entry.mode);
    },
  });
}

function assertIdentityFields(input: {
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  agentId: string;
  sourceMachineId: string;
  targetMachineId: string;
}): void {
  const fields = [
    input.migrationId,
    input.migrationGeneration,
    input.leaseId,
    input.agentId,
    input.sourceMachineId,
    input.targetMachineId,
  ];
  if (fields.some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_IDENTITY_INVALID");
  }
  if (input.sourceMachineId === input.targetMachineId) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_MACHINE_BINDING_INVALID");
  }
}

function assertChunkSize(value: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < AGENT_MIGRATION_MIN_CHUNK_BYTES
  ) {
    throw new AgentMigrationControlManifestError("MIGRATION_CONTROL_CHUNK_SIZE_INVALID");
  }
}

function assertPositiveSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

class AgentMigrationBundleTooLargeError extends Error {}

/** Uncompressed bytes of the files a migration would move, per top-level path. */
async function measureWorkspaceBytesByTopLevelPath(workspacePath: string): Promise<Map<string, number>> {
  const bytesByTopLevelPath = new Map<string, number>();
  await listAgentMigrationWorkspace({
    workspacePath,
    measureIgnored: false,
    async onEntry(relativePath) {
      if (relativePath === AGENT_MIGRATION_COMMIT_MARKER_PATH) return;
      const entryStat = await lstat(path.join(workspacePath, relativePath)).catch(() => null);
      if (!entryStat?.isFile()) return;
      const topLevelPath = agentMigrationTopLevelPath(relativePath);
      bytesByTopLevelPath.set(topLevelPath, (bytesByTopLevelPath.get(topLevelPath) ?? 0) + entryStat.size);
    },
  });
  return bytesByTopLevelPath;
}

/** Packing stops here, so `actualBytes` is where it stopped, not the full size. */
function createByteLimit(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        callback(new AgentMigrationBundleTooLargeError(`MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=${bytes}:maxBytes=${maxBytes}`));
        return;
      }
      callback(null, chunk);
    },
  });
}

function generationRoot(slockHome: string, control: AgentMigrationControlManifest): string {
  return path.join(
    path.resolve(slockHome),
    "migrations",
    migrationStatePathSegment(control.identity.migrationId),
    migrationStatePathSegment(control.identity.migrationGeneration),
  );
}

export function commitMarkerMatches(
  marker: AgentMigrationCommitMarker,
  control: AgentMigrationControlManifest,
  controlSha256: string,
): boolean {
  return marker.schemaVersion === "agent-migration-commit/v1"
    && marker.migrationId === control.identity.migrationId
    && marker.migrationGeneration === control.identity.migrationGeneration
    && marker.leaseId === control.identity.leaseId
    && marker.agentId === control.identity.agentId
    && marker.sourceMachineId === control.identity.sourceMachineId
    && marker.targetMachineId === control.identity.targetMachineId
    && marker.controlSha256 === controlSha256
    && marker.bundleSha256 === control.bundle.sha256;
}

export async function readCommitMarker(finalWorkspacePath: string): Promise<AgentMigrationCommitMarker | undefined> {
  const markerPath = path.join(
    finalWorkspacePath,
    ...AGENT_MIGRATION_COMMIT_MARKER_PATH.split("/"),
  );
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Partial<AgentMigrationCommitMarker>;
    if (
      parsed.schemaVersion !== "agent-migration-commit/v1"
      || typeof parsed.migrationId !== "string"
      || typeof parsed.migrationGeneration !== "string"
      || typeof parsed.leaseId !== "string"
      || typeof parsed.agentId !== "string"
      || typeof parsed.sourceMachineId !== "string"
      || typeof parsed.targetMachineId !== "string"
      || typeof parsed.controlSha256 !== "string"
      || typeof parsed.bundleSha256 !== "string"
      || typeof parsed.committedAt !== "string"
    ) {
      return undefined;
    }
    return parsed as AgentMigrationCommitMarker;
  } catch {
    return undefined;
  }
}

function archiveMode(mode: number | undefined): number {
  return typeof mode === "number" ? mode & 0o777 : 0o600;
}

function archiveMtime(mtimeMs: number | undefined): Date {
  return typeof mtimeMs === "number" && Number.isFinite(mtimeMs) ? new Date(mtimeMs) : new Date(0);
}

function writeBufferedEntry(tarPack: Pack, header: Headers, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    tarPack.entry(header, buffer, (error) => error ? reject(error) : resolve());
  });
}

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.from(value);
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

/** Directory name for a migration id or generation; existing on-disk state paths depend on it. */
export function migrationStatePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "migration";
}

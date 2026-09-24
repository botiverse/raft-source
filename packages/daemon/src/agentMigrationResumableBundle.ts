import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack, type Headers, type Pack } from "tar-stream";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  agentMigrationTransferSummarySchema,
  currentDate,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
} from "@botiverse/raft-shared";
import {
  buildAgentMigrationExportPlan,
  normalizeAgentMigrationSymlinkTarget,
  summarizeAgentMigrationExportManifest,
  type AgentMigrationSourceBundleFileEntry,
} from "./agentMigrationExport.js";
import { assertAgentMigrationObjectStoreEntryLimit } from "./agentMigrationObjectStoreBundle.js";

export {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_MAX_CHUNKS,
  AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES,
  AGENT_MIGRATION_MIN_CHUNK_BYTES,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  type AgentMigrationControlChunk,
  type AgentMigrationControlManifest,
};

const ARCHIVE_WORKSPACE_PREFIX = "workspace/";
const CONTROL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface BuildAgentMigrationResumableBundleInput {
  agentId: string;
  migrationId: string;
  migrationGeneration: string;
  leaseId: string;
  sourceMachineId: string;
  targetMachineId: string;
  slockHome: string;
  workspacePath: string;
  maxBytes: number;
  chunkSizeBytes?: number;
  spoolParentPath: string;
}

export interface BuiltAgentMigrationResumableBundle {
  spoolDirectory: string;
  bundlePath: string;
  control: AgentMigrationControlManifest;
  controlSha256: string;
  controlBytes: number;
  openChunk(chunkIndex: number): Readable;
}

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

export interface StageAgentMigrationResumableBundleDependencies {
  renameWorkspace?: (sourcePath: string, targetPath: string) => Promise<void>;
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

export class AgentMigrationChunkDigestMismatchError extends Error {
  readonly code = "MIGRATION_CHUNK_DIGEST_MISMATCH";

  constructor(readonly chunkIndex: number) {
    super(`MIGRATION_CHUNK_DIGEST_MISMATCH:${chunkIndex}`);
    this.name = "AgentMigrationChunkDigestMismatchError";
  }
}

export class AgentMigrationWholeBundleDigestMismatchError extends Error {
  readonly code = "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH";

  constructor() {
    super("MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH");
    this.name = "AgentMigrationWholeBundleDigestMismatchError";
  }
}

export class AgentMigrationWorkspaceConflictError extends Error {
  readonly code: "MIGRATION_WORKSPACE_ALREADY_EXISTS" | "MIGRATION_WORKSPACE_COMPLETE_OLD_COPY";

  constructor(code: AgentMigrationWorkspaceConflictError["code"]) {
    super(code);
    this.code = code;
    this.name = "AgentMigrationWorkspaceConflictError";
  }
}

export async function buildAgentMigrationResumableBundle(
  input: BuildAgentMigrationResumableBundleInput,
): Promise<BuiltAgentMigrationResumableBundle> {
  assertPositiveSafeInteger(input.maxBytes, "MIGRATION_OBJECT_STORE_MAX_BYTES_INVALID");
  const chunkSizeBytes = input.chunkSizeBytes ?? AGENT_MIGRATION_DEFAULT_CHUNK_BYTES;
  assertChunkSize(chunkSizeBytes);
  assertIdentityFields(input);

  const workspacePath = path.resolve(input.workspacePath);
  const buildPlan = await buildAgentMigrationExportPlan({
    agentId: input.agentId,
    slockHome: input.slockHome,
    workspacePath,
    mode: "forensic",
  });
  const sourceEntries = buildPlan.files.filter((entry) => {
    return entry.workspaceRelativePath !== AGENT_MIGRATION_COMMIT_MARKER_PATH;
  }).map((entry) => {
    if (entry.source !== "workspace" || !entry.workspaceRelativePath) {
      throw new Error("MIGRATION_OBJECT_STORE_UNSUPPORTED_ENTRY");
    }
    return entry;
  });
  assertAgentMigrationObjectStoreEntryLimit(sourceEntries, AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES);
  const expandedBytes = sourceEntries.reduce((total, entry) => {
    const next = total + (entry.kind === "file" ? checkedEntrySize(entry) : 0);
    if (!Number.isSafeInteger(next)) throw new Error("MIGRATION_OBJECT_STORE_FILE_SIZE_INVALID");
    return next;
  }, 0);
  const maxEntryBytes = sourceEntries.reduce(
    (largest, entry) => Math.max(largest, entry.kind === "file" ? checkedEntrySize(entry) : 0),
    0,
  );

  await mkdir(path.resolve(input.spoolParentPath), { recursive: true });
  const spoolDirectory = await mkdtemp(path.join(path.resolve(input.spoolParentPath), "bundle-"));
  const bundlePath = path.join(spoolDirectory, "bundle.tar.gz");
  const tarPack = pack();
  const gzip = createGzip({ level: 6 });
  const limit = createByteLimit(input.maxBytes);
  const archiveWrite = pipeline(
    tarPack,
    gzip,
    limit,
    createWriteStream(bundlePath, { flags: "wx", mode: 0o600 }),
  );
  void writeSourceArchive(tarPack, sourceEntries).catch((error: unknown) => {
    tarPack.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  await archiveWrite;

  const totalBytes = (await stat(bundlePath)).size;
  const { sha256, chunks } = await hashBundleChunks(bundlePath, totalBytes, chunkSizeBytes);
  const control: AgentMigrationControlManifest = {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: input.migrationId,
      migrationGeneration: input.migrationGeneration,
      leaseId: input.leaseId,
      agentId: input.agentId,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
    },
    capability: { required: AGENT_MIGRATION_RESUMABLE_CAPABILITIES },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      totalBytes,
      sha256,
      chunkSizeBytes,
      chunks,
    },
    archive: {
      format: "tar+gzip",
      entryCount: sourceEntries.length,
      expandedBytes,
      maxEntryBytes,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: summarizeAgentMigrationExportManifest({
      files: sourceEntries,
      excludedRegenerable: buildPlan.manifest.excludedRegenerable,
    }),
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  };
  const { sha256: controlSha256, bytes: controlBytes } = validateAgentMigrationControlManifest(control);
  return {
    spoolDirectory,
    bundlePath,
    control,
    controlSha256,
    controlBytes,
    openChunk(chunkIndex: number): Readable {
      const chunk = control.bundle.chunks[chunkIndex];
      if (!chunk || chunk.index !== chunkIndex) throw new Error("MIGRATION_CHUNK_INDEX_INVALID");
      return createReadStream(bundlePath, {
        start: chunk.offsetBytes,
        end: chunk.offsetBytes + chunk.sizeBytes - 1,
      });
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
    control.capability.required.length !== AGENT_MIGRATION_RESUMABLE_CAPABILITIES.length
    || !AGENT_MIGRATION_RESUMABLE_CAPABILITIES.every((capability) =>
      control.capability.required.includes(capability))
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
    // Partial chunks are intentionally left as classified failed residue. They
    // are never mistaken for a verified receipt and are never auto-deleted.
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
  const missing = await missingAgentMigrationChunks({
    control: input.control,
    chunksDirectory: input.chunksDirectory,
  });
  if (missing.length > 0) throw new Error(`MIGRATION_CHUNKS_MISSING:${missing.join(",")}`);

  await mkdir(residue.generationRootPath, { recursive: true });
  const attemptRoot = await mkdtemp(path.join(residue.generationRootPath, "extracting-"));
  const stagingWorkspacePath = path.join(attemptRoot, "workspace");
  await mkdir(stagingWorkspacePath, { recursive: true });
  const extraction = await extractVerifiedArchive({
    control: input.control,
    chunksDirectory: input.chunksDirectory,
    stagingWorkspacePath,
  });
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
  await mkdir(path.dirname(residue.finalWorkspacePath), { recursive: true });
  try {
    await (dependencies.renameWorkspace ?? rename)(stagingWorkspacePath, residue.finalWorkspacePath);
  } catch (error) {
    if (await pathExists(residue.finalWorkspacePath)) {
      const existing = await readCommitMarker(residue.finalWorkspacePath);
      if (existing && commitMarkerMatches(existing, input.control, controlSha256)) {
        return {
          outcome: "already-committed",
          finalWorkspacePath: residue.finalWorkspacePath,
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
    finalWorkspacePath: residue.finalWorkspacePath,
    marker,
    extractedEntries: extraction.entries,
    extractedBytes: extraction.bytes,
  };
}

async function writeSourceArchive(
  tarPack: Pack,
  sourceEntries: AgentMigrationSourceBundleFileEntry[],
): Promise<void> {
  for (const entry of sourceEntries) {
    const relativePath = normalizeArchiveRelativePath(entry.workspaceRelativePath ?? "");
    if (relativePath === AGENT_MIGRATION_COMMIT_MARKER_PATH) {
      throw new Error("MIGRATION_OBJECT_STORE_RESERVED_PATH");
    }
    const sourcePath = path.resolve(entry.sourcePath);
    const archivePath = `${ARCHIVE_WORKSPACE_PREFIX}${relativePath}`;
    if (entry.kind === "symlink") {
      const linkTarget = assertSafeSymlink(relativePath, entry.linkTarget);
      await writeBufferedEntry(tarPack, {
        name: archivePath,
        type: "symlink",
        size: 0,
        mode: archiveMode(entry.mode),
        mtime: archiveMtime(entry.mtimeMs),
        linkname: linkTarget,
      }, Buffer.alloc(0));
      continue;
    }
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size !== entry.sizeBytes) {
      throw new Error(`MIGRATION_OBJECT_STORE_FILE_CHANGED:${relativePath}`);
    }
    const tarEntry = tarPack.entry({
      name: archivePath,
      type: "file",
      size: sourceStat.size,
      mode: archiveMode(entry.mode),
      mtime: archiveMtime(entry.mtimeMs),
    });
    await pipeline(createReadStream(sourcePath), tarEntry);
  }
  tarPack.finalize();
}

async function extractVerifiedArchive(input: {
  control: AgentMigrationControlManifest;
  chunksDirectory: string;
  stagingWorkspacePath: string;
}): Promise<{ entries: number; bytes: number }> {
  const wholeHash = createHash("sha256");
  let bundleBytes = 0;
  const hashingBundle = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bundleBytes += chunk.byteLength;
      if (bundleBytes > input.control.bundle.totalBytes) {
        callback(new AgentMigrationWholeBundleDigestMismatchError());
        return;
      }
      wholeHash.update(chunk);
      callback(null, chunk);
    },
  });
  const tarExtract = extract();
  const seen = new Set<string>();
  const symlinkPaths = new Set<string>();
  let entries = 0;
  let bytes = 0;
  tarExtract.on("entry", (header, stream, next) => {
    void extractArchiveEntry({
      header,
      stream,
      control: input.control,
      stagingWorkspacePath: input.stagingWorkspacePath,
      seen,
      symlinkPaths,
      addFile(sizeBytes: number) {
        entries += 1;
        bytes += sizeBytes;
        if (
          entries > input.control.archive.entryCount
          || bytes > input.control.archive.expandedBytes
        ) {
          throw new Error("MIGRATION_ARCHIVE_LIMIT_EXCEEDED");
        }
      },
    }).then(() => next(), next);
  });
  await pipeline(
    Readable.from(readVerifiedChunkSequence(input.control, input.chunksDirectory)),
    hashingBundle,
    createGunzip(),
    tarExtract,
  );
  if (
    bundleBytes !== input.control.bundle.totalBytes
    || wholeHash.digest("hex") !== input.control.bundle.sha256
  ) {
    throw new AgentMigrationWholeBundleDigestMismatchError();
  }
  if (entries !== input.control.archive.entryCount || bytes !== input.control.archive.expandedBytes) {
    throw new Error("MIGRATION_ARCHIVE_COMMIT_CONDITION_MISMATCH");
  }
  return { entries, bytes };
}

async function extractArchiveEntry(input: {
  header: Headers;
  stream: NodeJS.ReadableStream;
  control: AgentMigrationControlManifest;
  stagingWorkspacePath: string;
  seen: Set<string>;
  symlinkPaths: Set<string>;
  addFile(sizeBytes: number): void;
}): Promise<void> {
  if (!input.header.name.startsWith(ARCHIVE_WORKSPACE_PREFIX)) {
    throw new Error("MIGRATION_ARCHIVE_ENTRY_UNEXPECTED");
  }
  const relativePath = normalizeArchiveRelativePath(
    input.header.name.slice(ARCHIVE_WORKSPACE_PREFIX.length),
  );
  if (relativePath === AGENT_MIGRATION_COMMIT_MARKER_PATH) {
    throw new Error("MIGRATION_OBJECT_STORE_RESERVED_PATH");
  }
  if (input.seen.has(relativePath)) throw new Error("MIGRATION_ARCHIVE_ENTRY_DUPLICATE");
  for (const symlinkPath of input.symlinkPaths) {
    if (relativePath.startsWith(`${symlinkPath}/`)) {
      throw new Error("MIGRATION_ARCHIVE_SYMLINK_ANCESTOR");
    }
  }
  input.seen.add(relativePath);
  const targetPath = path.join(input.stagingWorkspacePath, ...relativePath.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (input.header.type === "symlink") {
    const linkTarget = assertSafeSymlink(relativePath, input.header.linkname);
    await drainEntry(input.stream);
    await symlink(linkTarget, targetPath);
    input.symlinkPaths.add(relativePath);
    input.addFile(0);
    return;
  }
  if (input.header.type !== "file") throw new Error("MIGRATION_ARCHIVE_ENTRY_TYPE_UNSUPPORTED");
  const sizeBytes = input.header.size;
  if (
    typeof sizeBytes !== "number"
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 0
    || sizeBytes > input.control.archive.maxEntryBytes
  ) {
    throw new Error("MIGRATION_ARCHIVE_ENTRY_SIZE_INVALID");
  }
  input.addFile(sizeBytes);
  await pipeline(
    input.stream as Readable,
    createWriteStream(targetPath, { flags: "wx", mode: archiveMode(input.header.mode) }),
  );
  await chmod(targetPath, archiveMode(input.header.mode));
}

async function* readVerifiedChunkSequence(
  control: AgentMigrationControlManifest,
  chunksDirectory: string,
): AsyncGenerator<Buffer> {
  for (const expected of control.bundle.chunks) {
    const chunkPath = path.join(path.resolve(chunksDirectory), `${expected.index}.chunk`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const value of createReadStream(chunkPath)) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) {
      throw new AgentMigrationChunkDigestMismatchError(expected.index);
    }
  }
}

async function hashBundleChunks(
  bundlePath: string,
  totalBytes: number,
  chunkSizeBytes: number,
): Promise<{ sha256: string; chunks: AgentMigrationControlChunk[] }> {
  const wholeHash = createHash("sha256");
  const chunks: AgentMigrationControlChunk[] = [];
  let chunkHash = createHash("sha256");
  let chunkBytes = 0;
  let offsetBytes = 0;
  for await (const value of createReadStream(bundlePath, { highWaterMark: Math.min(chunkSizeBytes, 1024 * 1024) })) {
    let buffer = Buffer.from(value);
    wholeHash.update(buffer);
    while (buffer.byteLength > 0) {
      const remaining = chunkSizeBytes - chunkBytes;
      const piece = buffer.subarray(0, remaining);
      chunkHash.update(piece);
      chunkBytes += piece.byteLength;
      buffer = buffer.subarray(piece.byteLength);
      if (chunkBytes === chunkSizeBytes) {
        chunks.push({
          index: chunks.length,
          offsetBytes,
          sizeBytes: chunkBytes,
          sha256: chunkHash.digest("hex"),
        });
        offsetBytes += chunkBytes;
        chunkBytes = 0;
        chunkHash = createHash("sha256");
      }
    }
  }
  if (chunkBytes > 0) {
    chunks.push({
      index: chunks.length,
      offsetBytes,
      sizeBytes: chunkBytes,
      sha256: chunkHash.digest("hex"),
    });
  }
  if (chunks.length === 0 && totalBytes === 0) {
    throw new Error("MIGRATION_OBJECT_STORE_BUNDLE_EMPTY");
  }
  if (chunks.length > AGENT_MIGRATION_MAX_CHUNKS) {
    throw new Error("MIGRATION_CONTROL_CHUNK_COUNT_LIMIT_EXCEEDED");
  }
  return { sha256: wholeHash.digest("hex"), chunks };
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

function checkedEntrySize(entry: AgentMigrationSourceBundleFileEntry): number {
  if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes ?? -1) < 0) {
    throw new Error("MIGRATION_OBJECT_STORE_FILE_SIZE_INVALID");
  }
  return entry.sizeBytes ?? 0;
}

function createByteLimit(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
        callback(new Error(`MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=${bytes}:maxBytes=${maxBytes}`));
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
    sanitizeSegment(control.identity.migrationId),
    sanitizeSegment(control.identity.migrationGeneration),
  );
}

function commitMarkerMatches(
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

async function readCommitMarker(finalWorkspacePath: string): Promise<AgentMigrationCommitMarker | undefined> {
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

function normalizeArchiveRelativePath(value: string): string {
  if (value.includes("\\")) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_PATH");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_PATH");
  }
  const normalized = path.posix.normalize(value);
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.includes("\0")
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_PATH");
  }
  return normalized;
}

function assertSafeSymlink(relativePath: string, linkTarget: string | null | undefined): string {
  if (linkTarget === undefined || linkTarget === null) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  const normalized = normalizeAgentMigrationSymlinkTarget(relativePath, linkTarget);
  if (normalized !== linkTarget) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  return normalized;
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

async function drainEntry(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream as AsyncIterable<Uint8Array>) {
    // Tar entries are sequential; every rejected payload still needs draining.
  }
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

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "migration";
}

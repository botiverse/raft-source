import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rm, statfs, symlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { extract, pack, type Headers, type Pack } from "tar-stream";
import {
  AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION,
  buildAgentMigrationExportPlan,
  normalizeAgentMigrationSymlinkTarget,
  type AgentMigrationBundleFileEntry,
  type AgentMigrationExportManifest,
  type AgentMigrationSourceBundleFileEntry,
} from "./agentMigrationExport.js";
import { normalizeAgentMigrationWorkspaceRelativePath } from "./agentMigrationWorkspacePath.js";

export const AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION =
  "agent-object-store-tar/v2" as const;
export const AGENT_MIGRATION_OBJECT_STORE_CONTENT_TYPE =
  "application/vnd.raft.agent-migration-bundle+tar+gzip";
const ARCHIVE_MANIFEST_PATH = "manifest.json";
const ARCHIVE_WORKSPACE_PREFIX = "workspace/";
const MAX_ARCHIVE_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT_STORE_BUNDLE_ENTRIES = 250_000;
const TARGET_ADOPTION_COPY_MULTIPLIER = 2n;
const TARGET_DISK_RESERVE_BYTES = 512n * 1024n * 1024n;
const MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES = 3;
const MAX_ENCODED_ACCOUNTING_PATH_LENGTH = 96;

interface AgentMigrationObjectStoreArchiveManifest {
  schemaVersion: typeof AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION;
  manifest: AgentMigrationExportManifest;
}

export interface BuildAgentMigrationObjectStoreBundleInput {
  agentId: string;
  slockHome: string;
  workspacePath: string;
  /** Maximum bytes in the final gzip-compressed archive stream. */
  maxBytes: number;
}

export interface StageAgentMigrationObjectStoreBundleInput {
  bundle: Readable;
  slockHome: string;
  sessionId: string;
  /** Maximum bytes accepted from the gzip-compressed archive stream. */
  maxBytes: number;
  signal?: AbortSignal;
}

export interface StagedAgentMigrationObjectStoreBundle {
  manifest: AgentMigrationExportManifest;
  manifestSha256: string;
  stagingWorkspacePath: string;
  contentBytes: number;
}

export interface BuiltAgentMigrationObjectStoreBundle {
  bundle: Readable;
  manifest: AgentMigrationExportManifest;
  manifestSha256: string;
  contentBytes: number;
}

export interface AgentMigrationObjectStoreLargestEntry {
  path: string;
  sizeBytes: number;
}

export interface AgentMigrationObjectStoreTopPathCount {
  path: string;
  entryCount: number;
}

export class AgentMigrationObjectStoreEntryCountLimitError extends Error {
  readonly code = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED";

  constructor(
    readonly entryCount: number,
    readonly maxEntries: number,
    readonly topPathCounts: AgentMigrationObjectStoreTopPathCount[] = [],
  ) {
    super(entryCountLimitWireMessage(entryCount, maxEntries, topPathCounts));
    this.name = "AgentMigrationObjectStoreEntryCountLimitError";
  }
}

export class AgentMigrationObjectStoreManifestTooLargeError extends Error {
  readonly code = "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE";

  constructor(
    readonly manifestBytes: number,
    readonly maxBytes: number,
    readonly entryCount: number,
    readonly topPaths: AgentMigrationObjectStoreTopPathCount[] = [],
  ) {
    super(manifestTooLargeWireMessage(manifestBytes, maxBytes, entryCount, topPaths));
    this.name = "AgentMigrationObjectStoreManifestTooLargeError";
  }
}

export class AgentMigrationObjectStoreBundleTooLargeError extends Error {
  readonly code = "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly largestEntries: AgentMigrationObjectStoreLargestEntry[] = [],
  ) {
    super(bundleTooLargeWireMessage(actualBytes, maxBytes, largestEntries));
    this.name = "AgentMigrationObjectStoreBundleTooLargeError";
  }
}

export class AgentMigrationObjectStoreInsufficientDiskError extends Error {
  readonly code = "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK";

  constructor(
    readonly requiredBytes: bigint,
    readonly availableBytes: bigint,
    readonly contentBytes: number,
  ) {
    super(
      `MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK:requiredBytes=${requiredBytes}`
      + `:availableBytes=${availableBytes}:contentBytes=${contentBytes}`,
    );
    this.name = "AgentMigrationObjectStoreInsufficientDiskError";
  }
}

export async function buildAgentMigrationObjectStoreBundle(
  input: BuildAgentMigrationObjectStoreBundleInput,
): Promise<BuiltAgentMigrationObjectStoreBundle> {
  assertPositiveMaxBytes(input.maxBytes);
  const workspacePath = path.resolve(input.workspacePath);
  const buildPlan = await buildAgentMigrationExportPlan({
    agentId: input.agentId,
    slockHome: input.slockHome,
    workspacePath,
    mode: "forensic",
  });
  const { manifest } = buildPlan;
  const contentBytes = agentMigrationObjectStoreContentBytes(manifest);

  const archiveManifest: AgentMigrationObjectStoreArchiveManifest = {
    schemaVersion: AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION,
    manifest,
  };
  const manifestBuffer = Buffer.from(`${canonicalJson(archiveManifest)}\n`, "utf8");
  if (manifestBuffer.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) {
    throw new AgentMigrationObjectStoreManifestTooLargeError(
      manifestBuffer.byteLength,
      MAX_ARCHIVE_MANIFEST_BYTES,
      manifest.files.length,
      largestWorkspaceEntryCounts(manifest),
    );
  }

  const tarPack = pack();
  const gzip = createGzip();
  const compressedSizeLimit = createCompressedSizeLimit(
    input.maxBytes,
    largestWorkspaceEntries(manifest),
  );
  const bundle = tarPack.pipe(gzip).pipe(compressedSizeLimit);
  tarPack.on("error", (error) => gzip.destroy(error));
  gzip.on("error", (error) => compressedSizeLimit.destroy(error));
  compressedSizeLimit.on("error", (error) => {
    gzip.destroy(error);
    tarPack.destroy(error);
  });
  void writeArchive(tarPack, manifestBuffer, buildPlan.files, manifest.createdAt).catch((error: unknown) => {
    tarPack.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    bundle,
    manifest,
    manifestSha256: sha256Buffer(Buffer.from(canonicalJson(manifest), "utf8")),
    contentBytes,
  };
}

export async function stageAgentMigrationObjectStoreBundle(
  input: StageAgentMigrationObjectStoreBundleInput,
): Promise<StagedAgentMigrationObjectStoreBundle> {
  assertPositiveMaxBytes(input.maxBytes);
  input.signal?.throwIfAborted();
  const stagingWorkspacePath = path.join(
    path.resolve(input.slockHome),
    "migrations",
    sanitizePathSegment(input.sessionId),
    "workspace",
  );
  await rm(stagingWorkspacePath, { recursive: true, force: true });
  await mkdir(stagingWorkspacePath, { recursive: true });

  let archiveManifest: AgentMigrationObjectStoreArchiveManifest | null = null;
  let expectedEntries = new Map<string, AgentMigrationBundleFileEntry>();
  const extractedEntries = new Set<string>();
  let contentBytes = 0;
  const compressedSizeLimit = createCompressedSizeLimit(input.maxBytes);
  const tarExtract = extract();
  tarExtract.on("entry", (header, stream, next) => {
    void handleArchiveEntry({
      header,
      stream,
      stagingWorkspacePath,
      getArchiveManifest: () => archiveManifest,
      setArchiveManifest: (value) => {
        archiveManifest = value;
        expectedEntries = expectedWorkspaceEntries(value.manifest);
      },
      getExpectedEntries: () => expectedEntries,
      extractedEntries,
      addContentBytes: (value) => {
        contentBytes += value;
        if (!Number.isSafeInteger(contentBytes)) {
          throw new Error("MIGRATION_OBJECT_STORE_FILE_SIZE_INVALID");
        }
      },
    }).then(() => next(), next);
  });

  try {
    await pipeline(input.bundle, compressedSizeLimit, createGunzip(), tarExtract, { signal: input.signal });
    const completedManifest = archiveManifest as AgentMigrationObjectStoreArchiveManifest | null;
    if (!completedManifest) throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_MISSING");
    for (const relativePath of expectedEntries.keys()) {
      if (!extractedEntries.has(relativePath)) {
        throw new Error(`MIGRATION_OBJECT_STORE_ARCHIVE_ENTRY_MISSING:${relativePath}`);
      }
    }
    return {
      manifest: completedManifest.manifest,
      manifestSha256: sha256Buffer(
        Buffer.from(canonicalJson(completedManifest.manifest), "utf8"),
      ),
      stagingWorkspacePath,
      contentBytes,
    };
  } catch (error) {
    await rm(stagingWorkspacePath, { recursive: true, force: true });
    throw error;
  }
}

async function writeArchive(
  tarPack: Pack,
  manifestBuffer: Buffer,
  sourceEntries: AgentMigrationSourceBundleFileEntry[],
  createdAt: string,
): Promise<void> {
  await writeBufferedEntry(tarPack, {
    name: ARCHIVE_MANIFEST_PATH,
    type: "file",
    size: manifestBuffer.byteLength,
    mode: 0o600,
    mtime: new Date(createdAt),
  }, manifestBuffer);

  for (const entry of sourceEntries) {
    if (entry.source !== "workspace" || !entry.workspaceRelativePath) {
      throw new Error("MIGRATION_OBJECT_STORE_UNSUPPORTED_ENTRY");
    }
    const relativePath = normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath);
    const sourcePath = path.resolve(entry.sourcePath);
    const archivePath = `${ARCHIVE_WORKSPACE_PREFIX}${relativePath}`;
    if (entry.kind === "symlink") {
      const linkTarget = normalizedSymlinkTarget(relativePath, entry.linkTarget);
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

    const stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.size !== entry.sizeBytes) {
      throw new Error(`MIGRATION_OBJECT_STORE_FILE_CHANGED:${relativePath}`);
    }
    const tarEntry = tarPack.entry({
      name: archivePath,
      type: "file",
      size: stat.size,
      mode: archiveMode(entry.mode),
      mtime: archiveMtime(entry.mtimeMs),
    });
    await pipeline(createReadStream(sourcePath), tarEntry);
  }
  tarPack.finalize();
}

async function handleArchiveEntry(input: {
  header: Headers;
  stream: NodeJS.ReadableStream;
  stagingWorkspacePath: string;
  getArchiveManifest: () => AgentMigrationObjectStoreArchiveManifest | null;
  setArchiveManifest: (value: AgentMigrationObjectStoreArchiveManifest) => void;
  getExpectedEntries: () => Map<string, AgentMigrationBundleFileEntry>;
  extractedEntries: Set<string>;
  addContentBytes: (value: number) => void;
}): Promise<void> {
  if (input.header.name === ARCHIVE_MANIFEST_PATH) {
    if (input.getArchiveManifest()) throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_DUPLICATE");
    if (input.header.type !== "file") throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_INVALID");
    const manifestBuffer = await readEntryBuffer(input.stream, MAX_ARCHIVE_MANIFEST_BYTES);
    const archiveManifest = parseArchiveManifest(manifestBuffer);
    await assertTargetWorkspaceResourceBudget(input.stagingWorkspacePath, archiveManifest.manifest);
    input.setArchiveManifest(archiveManifest);
    return;
  }
  const archiveManifest = input.getArchiveManifest();
  if (!archiveManifest) throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_MUST_BE_FIRST");
  if (!input.header.name.startsWith(ARCHIVE_WORKSPACE_PREFIX)) {
    throw new Error("MIGRATION_OBJECT_STORE_ARCHIVE_ENTRY_UNEXPECTED");
  }
  const relativePath = normalizeObjectStoreWorkspaceRelativePath(
    input.header.name.slice(ARCHIVE_WORKSPACE_PREFIX.length),
  );
  if (input.extractedEntries.has(relativePath)) {
    throw new Error(`MIGRATION_OBJECT_STORE_ARCHIVE_ENTRY_DUPLICATE:${relativePath}`);
  }
  const expected = input.getExpectedEntries().get(relativePath);
  if (!expected) throw new Error(`MIGRATION_OBJECT_STORE_ARCHIVE_ENTRY_UNEXPECTED:${relativePath}`);
  input.extractedEntries.add(relativePath);
  const targetPath = path.join(input.stagingWorkspacePath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });

  if (expected.kind === "symlink") {
    const expectedLinkTarget = normalizedSymlinkTarget(relativePath, expected.linkTarget);
    const archiveLinkTarget = normalizedSymlinkTarget(relativePath, input.header.linkname);
    if (input.header.type !== "symlink" || archiveLinkTarget !== expectedLinkTarget) {
      throw new Error(`MIGRATION_OBJECT_STORE_LINK_TARGET_MISMATCH:${relativePath}`);
    }
    await drainEntry(input.stream);
    await symlink(expectedLinkTarget, targetPath);
    return;
  }
  if (input.header.type !== "file" || input.header.size !== expected.sizeBytes) {
    throw new Error(`MIGRATION_OBJECT_STORE_FILE_SIZE_MISMATCH:${relativePath}`);
  }
  input.addContentBytes(input.header.size ?? 0);
  const hash = createHash("sha256");
  const hashPassThrough = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    input.stream as Readable,
    hashPassThrough,
    createWriteStream(targetPath, { mode: archiveMode(expected.mode) }),
  );
  if (expected.sha256 && hash.digest("hex") !== expected.sha256) {
    throw new Error(`MIGRATION_OBJECT_STORE_FILE_HASH_MISMATCH:${relativePath}`);
  }
}

function parseArchiveManifest(buffer: Buffer): AgentMigrationObjectStoreArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_INVALID");
  }
  const archiveManifest = parsed as Partial<AgentMigrationObjectStoreArchiveManifest>;
  if (archiveManifest.schemaVersion !== AGENT_MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_VERSION) {
    throw new Error("MIGRATION_OBJECT_STORE_BUNDLE_SCHEMA_UNSUPPORTED");
  }
  if (
    !archiveManifest.manifest
    || typeof archiveManifest.manifest !== "object"
    || Array.isArray(archiveManifest.manifest)
    || archiveManifest.manifest.schemaVersion !== AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION
    || !Array.isArray(archiveManifest.manifest.files)
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_MANIFEST_INVALID");
  }
  return archiveManifest as AgentMigrationObjectStoreArchiveManifest;
}

function expectedWorkspaceEntries(
  manifest: AgentMigrationExportManifest,
): Map<string, AgentMigrationBundleFileEntry> {
  const result = new Map<string, AgentMigrationBundleFileEntry>();
  for (const entry of manifest.files) {
    if (entry.source !== "workspace") {
      throw new Error("MIGRATION_OBJECT_STORE_UNSUPPORTED_ENTRY");
    }
    const relativePath = normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath);
    if (result.has(relativePath)) {
      throw new Error(`MIGRATION_OBJECT_STORE_MANIFEST_ENTRY_DUPLICATE:${relativePath}`);
    }
    if (entry.kind === "symlink") {
      normalizedSymlinkTarget(relativePath, entry.linkTarget);
    }
    result.set(relativePath, entry);
  }
  return result;
}

function normalizedSymlinkTarget(relativePath: string, linkTarget: string | null | undefined): string {
  if (linkTarget === undefined || linkTarget === null) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  const normalized = normalizeAgentMigrationSymlinkTarget(relativePath, linkTarget);
  if (normalized !== linkTarget) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  return normalized;
}

function agentMigrationObjectStoreContentBytes(
  manifest: AgentMigrationExportManifest,
): number {
  assertAgentMigrationObjectStoreEntryLimit(manifest.files);
  let total = 0;
  for (const entry of manifest.files) {
    if (entry.source !== "workspace") {
      throw new Error("MIGRATION_OBJECT_STORE_UNSUPPORTED_ENTRY");
    }
    normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath);
    if (entry.kind !== "file") continue;
    if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes ?? -1) < 0) {
      throw new Error("MIGRATION_OBJECT_STORE_FILE_SIZE_INVALID");
    }
    total += entry.sizeBytes ?? 0;
    if (!Number.isSafeInteger(total)) throw new Error("MIGRATION_OBJECT_STORE_FILE_SIZE_INVALID");
  }
  return total;
}

async function assertTargetWorkspaceResourceBudget(
  stagingWorkspacePath: string,
  manifest: AgentMigrationExportManifest,
): Promise<void> {
  const contentBytes = agentMigrationObjectStoreContentBytes(manifest);
  const volume = await statfs(stagingWorkspacePath, { bigint: true });
  const availableBytes = volume.bavail * volume.bsize;
  const requiredBytes = BigInt(contentBytes) * TARGET_ADOPTION_COPY_MULTIPLIER
    + TARGET_DISK_RESERVE_BYTES;
  if (availableBytes < requiredBytes) {
    throw new AgentMigrationObjectStoreInsufficientDiskError(
      requiredBytes,
      availableBytes,
      contentBytes,
    );
  }
}

function createCompressedSizeLimit(
  maxBytes: number,
  largestEntries: AgentMigrationObjectStoreLargestEntry[] = [],
): Transform {
  assertPositiveMaxBytes(maxBytes);
  let compressedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (!Number.isSafeInteger(compressedBytes)) {
        callback(new Error("MIGRATION_OBJECT_STORE_BUNDLE_SIZE_INVALID"));
        return;
      }
      if (compressedBytes > maxBytes) {
        callback(new AgentMigrationObjectStoreBundleTooLargeError(
          compressedBytes,
          maxBytes,
          largestEntries,
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

export function largestWorkspaceEntries(
  manifest: AgentMigrationExportManifest,
  limit = MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES,
): AgentMigrationObjectStoreLargestEntry[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const sizeByTopLevelPath = new Map<string, number>();
  for (const entry of manifest.files) {
    if (
      entry.source !== "workspace"
      || entry.kind !== "file"
      || !entry.workspaceRelativePath
      || !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes ?? -1) < 0
    ) {
      continue;
    }
    const relativePath = normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath);
    const slashIndex = relativePath.indexOf("/");
    const accountingPath = slashIndex === -1
      ? relativePath
      : `${relativePath.slice(0, slashIndex)}/`;
    sizeByTopLevelPath.set(
      accountingPath,
      (sizeByTopLevelPath.get(accountingPath) ?? 0) + (entry.sizeBytes ?? 0),
    );
  }
  return [...sizeByTopLevelPath]
    .map(([accountingPath, sizeBytes]) => ({ path: accountingPath, sizeBytes }))
    .sort((left, right) => right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function bundleTooLargeWireMessage(
  actualBytes: number,
  maxBytes: number,
  largestEntries: AgentMigrationObjectStoreLargestEntry[],
): string {
  const prefix = `MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=${actualBytes}:maxBytes=${maxBytes}`;
  const encodedEntries = largestEntries
    .slice(0, MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES)
    .map((entry) => `${encodeAccountingPath(entry.path)},${entry.sizeBytes}`)
    .filter((entry) => entry.length > 0);
  return encodedEntries.length > 0
    ? `${prefix}:topEntries=${encodedEntries.join(";")}`
    : prefix;
}

function manifestTooLargeWireMessage(
  manifestBytes: number,
  maxBytes: number,
  entryCount: number,
  topPaths: AgentMigrationObjectStoreTopPathCount[],
): string {
  const prefix = `MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE:manifestBytes=${manifestBytes}:maxBytes=${maxBytes}:entryCount=${entryCount}`;
  const encodedPaths = topPaths
    .slice(0, MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES)
    .map((entry) => `${encodeAccountingPath(entry.path)},${entry.entryCount}`)
    .filter((entry) => entry.length > 0);
  return encodedPaths.length > 0
    ? `${prefix}:topPaths=${encodedPaths.join(";")}`
    : prefix;
}

function entryCountLimitWireMessage(
  entryCount: number,
  maxEntries: number,
  topPathCounts: AgentMigrationObjectStoreTopPathCount[],
): string {
  const encodedPaths = topPathCounts
    .slice(0, MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES)
    .map((entry) => `${encodeAccountingPath(entry.path)},${entry.entryCount}`)
    .filter((entry) => entry.length > 0);
  return `MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=${entryCount}`
    + `:maxEntries=${maxEntries}:topPathCounts=${encodedPaths.join(";")}`;
}

export function assertAgentMigrationObjectStoreEntryLimit(
  entries: readonly AgentMigrationBundleFileEntry[],
  maxEntries = MAX_OBJECT_STORE_BUNDLE_ENTRIES,
): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("MIGRATION_OBJECT_STORE_MAX_ENTRIES_INVALID");
  }
  if (entries.length <= maxEntries) return;
  throw new AgentMigrationObjectStoreEntryCountLimitError(
    entries.length,
    maxEntries,
    largestWorkspaceEntryCounts({ files: entries }),
  );
}

export function largestWorkspaceEntryCounts(
  manifest: { files: readonly AgentMigrationBundleFileEntry[] },
  limit = MAX_BUNDLE_TOO_LARGE_ACCOUNTING_ENTRIES,
): AgentMigrationObjectStoreTopPathCount[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const countByTopLevelPath = new Map<string, number>();
  for (const entry of manifest.files) {
    if (entry.source !== "workspace" || !entry.workspaceRelativePath) continue;
    const relativePath = normalizeObjectStoreWorkspaceRelativePath(entry.workspaceRelativePath);
    const slashIndex = relativePath.indexOf("/");
    const unredactedAccountingPath = slashIndex === -1
      ? relativePath
      : `${relativePath.slice(0, slashIndex)}/`;
    const accountingPath = isSensitiveAccountingPath(unredactedAccountingPath)
      ? "other/"
      : unredactedAccountingPath;
    countByTopLevelPath.set(accountingPath, (countByTopLevelPath.get(accountingPath) ?? 0) + 1);
  }
  return [...countByTopLevelPath]
    .map(([accountingPath, entryCount]) => ({ path: accountingPath, entryCount }))
    .sort((left, right) => right.entryCount - left.entryCount || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function isSensitiveAccountingPath(value: string): boolean {
  const basename = value.endsWith("/") ? value.slice(0, -1) : value;
  return /^\.env(?:\.|$)/i.test(basename)
    || /(?:secret|token|credential|api[-_]?key)/i.test(basename);
}

function encodeAccountingPath(value: string): string {
  let encoded = "";
  for (const character of value) {
    const next = encodeURIComponent(character);
    if (encoded.length + next.length > MAX_ENCODED_ACCOUNTING_PATH_LENGTH) break;
    encoded += next;
  }
  return encoded;
}

function normalizeObjectStoreWorkspaceRelativePath(relativePath: unknown): string {
  return normalizeAgentMigrationWorkspaceRelativePath(
    relativePath,
    "MIGRATION_OBJECT_STORE_UNSAFE_PATH",
  );
}

function writeBufferedEntry(tarPack: Pack, header: Headers, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    tarPack.entry(header, buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readEntryBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new AgentMigrationObjectStoreManifestTooLargeError(total, maxBytes, 0);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function drainEntry(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream as AsyncIterable<Uint8Array>) {
    // Drain tar entry before requesting the next sequential entry.
  }
}

function assertPositiveMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("MIGRATION_OBJECT_STORE_MAX_BYTES_INVALID");
  }
}

function archiveMode(mode: number | undefined): number {
  return typeof mode === "number" ? mode & 0o777 : 0o600;
}

function archiveMtime(mtimeMs: number | undefined): Date {
  return typeof mtimeMs === "number" && Number.isFinite(mtimeMs)
    ? new Date(mtimeMs)
    : new Date(0);
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

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "migration";
}

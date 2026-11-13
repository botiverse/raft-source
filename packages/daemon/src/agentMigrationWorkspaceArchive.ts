import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { currentDate } from "@botiverse/raft-shared";
import { sha256File } from "./agentMigrationExport";
import { readVolumeCapacity } from "./volumeCapacity";

export const AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY = "migration-workspace-backups";
export const AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT = 3;
/**
 * Seven days: what moved is on the target, and what was left out is by
 * definition regenerable. The backup only exists to recover a path the agent
 * wrongly ignored, which shows up within a day or two of the move.
 */
export const AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * Total size kept per agent when the caller can measure backups (the daily
 * janitor). The newest backup is always kept, whatever its size: it is the
 * only copy someone can recover files from.
 */
export const AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT = 20 * 1024 * 1024 * 1024;

export type AgentMigrationWorkspaceArchiveOutcome =
  | "archived"
  | "already_archived"
  // Nothing of this agent is left on the source: the goal of archiving (no
  // residue that blocks a later migration back) already holds.
  | "source_absent";

function assertSafePathSegment(value: string, label: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(`MIGRATION_WORKSPACE_ARCHIVE_${label}_INVALID`);
  }
}

function pathExists(targetPath: string): Promise<boolean> {
  return lstat(targetPath).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  });
}

function assertBackupRootOutsideDataDir(dataDir: string, backupRoot: string): void {
  const relative = path.relative(path.resolve(dataDir), path.resolve(backupRoot));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")) {
    throw new Error("MIGRATION_WORKSPACE_ARCHIVE_ROOT_INSIDE_DATA_DIR");
  }
}

async function assertRealDirectory(targetPath: string, errorCode: string): Promise<void> {
  const info = await lstat(targetPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(errorCode);
  }
}

async function prepareBackupDirectory(input: {
  dataDir: string;
  backupRoot: string;
  agentBackupRoot: string;
}): Promise<void> {
  await mkdir(input.backupRoot, { recursive: true });
  await assertRealDirectory(input.backupRoot, "MIGRATION_WORKSPACE_ARCHIVE_ROOT_INVALID");
  const [realDataDir, realBackupRoot] = await Promise.all([
    realpath(input.dataDir),
    realpath(input.backupRoot),
  ]);
  assertBackupRootOutsideDataDir(realDataDir, realBackupRoot);

  await mkdir(input.agentBackupRoot, { recursive: true });
  await assertRealDirectory(input.agentBackupRoot, "MIGRATION_WORKSPACE_ARCHIVE_AGENT_ROOT_INVALID");
}

export interface AgentMigrationWorkspaceBackupEntry {
  name: string;
  modifiedAtMs: number;
}

/**
 * Keeps the newest AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT backups that
 * are younger than AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS. With
 * `measureBytes`, also removes older backups once the kept ones (newest first)
 * exceed AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT, together with
 * every backup older than the first one removed for size; the newest is never
 * removed for size. A short (bounded) measurement only keeps more.
 * Removals run one at a time so a sweep never deletes several workspaces
 * concurrently.
 */
export async function pruneAgentMigrationWorkspaceBackups(input: {
  agentBackupRoot: string;
  now: Date;
  measureBytes?: (backupPath: string) => Promise<number>;
  beforeRemove?: (entry: AgentMigrationWorkspaceBackupEntry, measuredBytes: number | null) => Promise<void>;
}): Promise<void> {
  const entries = await readdir(input.agentBackupRoot, { withFileTypes: true });
  const directories: AgentMigrationWorkspaceBackupEntry[] = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => ({
      name: entry.name,
      modifiedAtMs: (await stat(path.join(input.agentBackupRoot, entry.name))).mtimeMs,
    })));
  directories.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.name.localeCompare(left.name));
  const cutoffMs = input.now.getTime() - AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS;
  let keptBytes = 0;
  // Once one backup goes for size, every older one goes too (oldest first).
  let overCap = false;
  for (const [index, entry] of directories.entries()) {
    const entryPath = path.join(input.agentBackupRoot, entry.name);
    let measuredBytes: number | null = null;
    if (!overCap && index < AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT && entry.modifiedAtMs >= cutoffMs) {
      if (!input.measureBytes) continue;
      measuredBytes = await input.measureBytes(entryPath);
      if (index === 0 || keptBytes + measuredBytes <= AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT) {
        keptBytes += measuredBytes;
        continue;
      }
      overCap = true;
    }
    await input.beforeRemove?.(entry, measuredBytes);
    await rm(entryPath, { recursive: true, force: true });
  }
}

/**
 * `rename` cannot cross filesystems (a custom dataDir on another volume than
 * slockHome fails with EXDEV). Fall back to copy → verify → swap into place →
 * delete the source; the source is only removed after the copy verified.
 */
async function moveWorkspaceToArchive(sourcePath: string, archivePath: string): Promise<void> {
  try {
    await rename(sourcePath, archivePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
  }
  const stagingPath = `${archivePath}.partial-${randomUUID()}`;
  try {
    await cp(sourcePath, stagingPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const [sourceTree, copiedTree] = await Promise.all([describeTree(sourcePath), describeTree(stagingPath)]);
    if (sourceTree !== copiedTree) throw new Error("MIGRATION_WORKSPACE_ARCHIVE_COPY_MISMATCH");
    await rename(stagingPath, archivePath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
  await rm(sourcePath, { recursive: true, force: true });
}

/** Deterministic digest of a tree: relative paths, entry kinds, symlink targets, file contents. */
async function describeTree(root: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const entryPath = path.join(relative, entry.name);
      const absolute = path.join(root, entryPath);
      if (entry.isSymbolicLink()) {
        digest.update(`l\0${entryPath}\0${await readlink(absolute)}\0`);
      } else if (entry.isDirectory()) {
        digest.update(`d\0${entryPath}\0`);
        await walk(entryPath);
      } else if (entry.isFile()) {
        digest.update(`f\0${entryPath}\0${await sha256File(absolute)}\0`);
      } else {
        digest.update(`o\0${entryPath}\0`);
      }
    }
  };
  await walk("");
  return digest.digest("hex");
}

export async function archiveCompletedAgentMigrationSourceWorkspace(input: {
  slockHome: string;
  dataDir: string;
  agentId: string;
  migrationId: string;
  now?: Date;
}): Promise<AgentMigrationWorkspaceArchiveOutcome> {
  assertSafePathSegment(input.agentId, "AGENT_ID");
  assertSafePathSegment(input.migrationId, "MIGRATION_ID");

  const now = input.now ?? currentDate();
  const dataDir = path.resolve(input.dataDir);
  const backupRoot = path.resolve(input.slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY);
  assertBackupRootOutsideDataDir(dataDir, backupRoot);

  const sourceWorkspacePath = path.join(dataDir, input.agentId);
  const agentBackupRoot = path.join(backupRoot, input.agentId);
  const archivePath = path.join(agentBackupRoot, input.migrationId);
  const [sourceExists, archiveExists] = await Promise.all([
    pathExists(sourceWorkspacePath),
    pathExists(archivePath),
  ]);

  if (!sourceExists && !archiveExists) {
    return "source_absent";
  }
  await prepareBackupDirectory({ dataDir, backupRoot, agentBackupRoot });
  if (sourceExists && archiveExists) {
    throw new Error("MIGRATION_WORKSPACE_ARCHIVE_CONFLICT");
  }
  if (archiveExists) {
    await assertRealDirectory(archivePath, "MIGRATION_WORKSPACE_ARCHIVE_TARGET_INVALID");
  }

  let outcome: AgentMigrationWorkspaceArchiveOutcome;
  if (sourceExists) {
    try {
      const sourceInfo = await lstat(sourceWorkspacePath);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new Error("MIGRATION_WORKSPACE_ARCHIVE_SOURCE_INVALID");
      }
      await moveWorkspaceToArchive(sourceWorkspacePath, archivePath);
      outcome = "archived";
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !await pathExists(archivePath)) {
        throw error;
      }
      await assertRealDirectory(archivePath, "MIGRATION_WORKSPACE_ARCHIVE_TARGET_INVALID");
      outcome = "already_archived";
    }
  } else {
    outcome = "already_archived";
  }

  await utimes(archivePath, now, now);
  await pruneAgentMigrationWorkspaceBackups({ agentBackupRoot, now });
  return outcome;
}

/** Headroom kept free on the backup filesystem when a quarantine must copy across disks. */
export const AGENT_MIGRATION_QUARANTINE_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

async function treeSizeBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) total += (await lstat(entryPath)).size;
    }
  };
  await walk(root);
  return total;
}

/**
 * A migration target already holds a directory for the agent that this
 * migration did not create: typically the agent lived on this computer before
 * and its old workspace was never archived (A → B → A). Instead of failing the
 * migration, move it into the same per-agent backup root the source archive
 * uses (`preexisting-<migrationId>`), which shares its retention: newest
 * AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT, at most
 * AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS, and (in the daily janitor) at
 * most AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT.
 *
 * The caller must have established that the agent is not live on this
 * computer (the server holds authority on the source until the flip).
 */
export async function quarantinePreexistingAgentWorkspace(input: {
  slockHome: string;
  dataDir: string;
  agentId: string;
  migrationId: string;
  now?: Date;
}): Promise<{ quarantinePath: string }> {
  assertSafePathSegment(input.agentId, "AGENT_ID");
  assertSafePathSegment(input.migrationId, "MIGRATION_ID");
  const now = input.now ?? currentDate();
  const dataDir = path.resolve(input.dataDir);
  const backupRoot = path.resolve(input.slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY);
  assertBackupRootOutsideDataDir(dataDir, backupRoot);
  const workspacePath = path.join(dataDir, input.agentId);
  const agentBackupRoot = path.join(backupRoot, input.agentId);
  const quarantinePath = path.join(agentBackupRoot, `preexisting-${input.migrationId}`);

  await assertRealDirectory(workspacePath, "MIGRATION_WORKSPACE_QUARANTINE_SOURCE_INVALID");
  await prepareBackupDirectory({ dataDir, backupRoot, agentBackupRoot });
  if (await pathExists(quarantinePath)) throw new Error("MIGRATION_WORKSPACE_QUARANTINE_CONFLICT");

  // Same filesystem: an atomic rename needs no space. Across filesystems the
  // copy must fit, with headroom, before anything is touched.
  const [workspaceInfo, backupInfo] = await Promise.all([stat(workspacePath), stat(agentBackupRoot)]);
  if (workspaceInfo.dev !== backupInfo.dev) {
    const [needed, capacity] = await Promise.all([treeSizeBytes(workspacePath), readVolumeCapacity(agentBackupRoot)]);
    if (!capacity) throw new Error("MIGRATION_WORKSPACE_QUARANTINE_DISK_UNREADABLE");
    if (capacity.availableBytes < needed + AGENT_MIGRATION_QUARANTINE_DISK_HEADROOM_BYTES) {
      throw new Error("MIGRATION_WORKSPACE_QUARANTINE_INSUFFICIENT_DISK");
    }
  }

  await moveWorkspaceToArchive(workspacePath, quarantinePath);
  await utimes(quarantinePath, now, now);
  await pruneAgentMigrationWorkspaceBackups({ agentBackupRoot, now });
  return { quarantinePath };
}

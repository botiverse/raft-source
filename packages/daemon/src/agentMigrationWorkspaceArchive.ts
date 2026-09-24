import { lstat, mkdir, readdir, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { currentDate } from "@botiverse/raft-shared";

export const AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY = "migration-workspace-backups";
export const AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT = 3;
export const AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type AgentMigrationWorkspaceArchiveOutcome =
  | "archived"
  | "already_archived";

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

async function pruneAgentMigrationWorkspaceBackups(input: {
  agentBackupRoot: string;
  now: Date;
}): Promise<void> {
  const entries = await readdir(input.agentBackupRoot, { withFileTypes: true });
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({
    name: entry.name,
    modifiedAtMs: (await stat(path.join(input.agentBackupRoot, entry.name))).mtimeMs,
  })));
  directories.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || right.name.localeCompare(left.name));
  const cutoffMs = input.now.getTime() - AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS;
  await Promise.all(directories.map(async (entry, index) => {
    if (index < AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT && entry.modifiedAtMs >= cutoffMs) return;
    await rm(path.join(input.agentBackupRoot, entry.name), { recursive: true, force: true });
  }));
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
    throw new Error("MIGRATION_WORKSPACE_ARCHIVE_SOURCE_MISSING");
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
      await rename(sourceWorkspacePath, archivePath);
      outcome = "archived";
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !await pathExists(archivePath)) {
        throw error;
      }
      await assertRealDirectory(archivePath, "MIGRATION_WORKSPACE_ARCHIVE_TARGET_INVALID");
      outcome = "already_archived";
    }
  } else if (archiveExists) {
    outcome = "already_archived";
  } else {
    throw new Error("MIGRATION_WORKSPACE_ARCHIVE_SOURCE_MISSING");
  }

  await utimes(archivePath, now, now);
  await pruneAgentMigrationWorkspaceBackups({ agentBackupRoot, now });
  return outcome;
}

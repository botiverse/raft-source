import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { currentDate, currentTimeMs } from "@botiverse/raft-shared";
import {
  AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
  pruneAgentMigrationWorkspaceBackups,
} from "./agentMigrationWorkspaceArchive";

/**
 * Raft Computer's own disk use under SLOCK_HOME: migration transfer copies,
 * archived workspaces and per-launch CLI transport. Agent workspaces are never
 * walked or touched here.
 *
 * Every walk and every sweep is bounded by an entry budget and a deadline so a
 * single pass cannot saturate disk IO; a bounded result says so explicitly
 * (`truncated` / `timeout`) instead of reporting a misleadingly small number.
 */

export const RAFT_MIGRATIONS_DIRECTORY = "migrations";
export const RAFT_CLI_TRANSPORT_DIRECTORY = "cli-transport";
export const RAFT_AGENT_PROXY_TOKENS_DIRECTORY = "agent-proxy-tokens";

/**
 * Migration deadlines are minutes to hours, so a transport generation with no
 * activity for a week belongs to a migration that has ended either way.
 */
export const RAFT_MIGRATION_GENERATION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
/** Bulk transfer data inside a generation; the JSON reports stay. */
const MIGRATION_GENERATION_BULK_ENTRY = /^(chunks|source-spool|extracting-.+)$/u;

export const RAFT_DISK_WALK_MAX_ENTRIES = 200_000;
export const RAFT_DISK_WALK_DEADLINE_MS = 30_000;
/** Yield to the event loop (and the disk) between lstat batches. */
const WALK_BATCH_SIZE = 64;

export type RaftDiskMeasureOutcome = "complete" | "truncated" | "timeout";

export interface RaftDiskWalkBudget {
  entriesLeft: number;
  deadlineMs: number;
  outcome: RaftDiskMeasureOutcome;
}

export function createRaftDiskWalkBudget(input?: { maxEntries?: number; deadlineMs?: number; nowMs?: number }): RaftDiskWalkBudget {
  return {
    entriesLeft: input?.maxEntries ?? RAFT_DISK_WALK_MAX_ENTRIES,
    deadlineMs: (input?.nowMs ?? currentTimeMs()) + (input?.deadlineMs ?? RAFT_DISK_WALK_DEADLINE_MS),
    outcome: "complete",
  };
}

function budgetExhausted(budget: RaftDiskWalkBudget): boolean {
  if (budget.outcome !== "complete") return true;
  if (budget.entriesLeft <= 0) {
    budget.outcome = "truncated";
    return true;
  }
  if (currentTimeMs() >= budget.deadlineMs) {
    budget.outcome = "timeout";
    return true;
  }
  return false;
}

/** Apparent bytes of regular files under `root`; symlinks are not followed. */
export async function measureDirectoryBytes(root: string, budget: RaftDiskWalkBudget): Promise<number> {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (budgetExhausted(budget)) return bytes;
    const dir = pending.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (let index = 0; index < names.length; index += WALK_BATCH_SIZE) {
      if (budgetExhausted(budget)) return bytes;
      const batch = names.slice(index, index + WALK_BATCH_SIZE);
      budget.entriesLeft -= batch.length;
      const infos = await Promise.all(batch.map((name) =>
        lstat(path.join(dir, name)).then((info) => ({ name, info }), () => null)));
      for (const entry of infos) {
        if (!entry) continue;
        if (entry.info.isDirectory()) pending.push(path.join(dir, entry.name));
        else if (entry.info.isFile()) bytes += entry.info.size;
      }
    }
  }
  return bytes;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export type RaftDiskFootprint = {
  raft_migration_chunks_bytes: number;
  raft_workspace_backups_bytes: number;
  raft_launch_dirs_bytes: number;
  measure_outcome: RaftDiskMeasureOutcome;
};

export async function measureRaftDiskFootprint(
  slockHome: string,
  budget: RaftDiskWalkBudget = createRaftDiskWalkBudget(),
): Promise<RaftDiskFootprint> {
  const migrations = await measureDirectoryBytes(path.join(slockHome, RAFT_MIGRATIONS_DIRECTORY), budget);
  const backups = await measureDirectoryBytes(path.join(slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY), budget);
  const launches = await measureDirectoryBytes(path.join(slockHome, RAFT_CLI_TRANSPORT_DIRECTORY), budget)
    + await measureDirectoryBytes(path.join(slockHome, RAFT_AGENT_PROXY_TOKENS_DIRECTORY), budget);
  return {
    raft_migration_chunks_bytes: migrations,
    raft_workspace_backups_bytes: backups,
    raft_launch_dirs_bytes: launches,
    measure_outcome: budget.outcome,
  };
}

/**
 * Removes the bulk transfer data of one migration transport generation and
 * keeps its JSON reports. Returns the bytes freed (bounded measurement).
 */
export async function removeMigrationGenerationBulk(
  generationRoot: string,
  budget: RaftDiskWalkBudget,
): Promise<number> {
  let freed = 0;
  let names: string[];
  try {
    names = await readdir(generationRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!MIGRATION_GENERATION_BULK_ENTRY.test(name)) continue;
    const target = path.join(generationRoot, name);
    freed += await measureDirectoryBytes(target, budget);
    await rm(target, { recursive: true, force: true });
  }
  return freed;
}

/** Newest mtime of the generation root and its direct children. */
async function generationLastActivityMs(generationRoot: string): Promise<number | null> {
  try {
    let newest = (await lstat(generationRoot)).mtimeMs;
    for (const name of await readdir(generationRoot)) {
      const info = await lstat(path.join(generationRoot, name)).catch(() => null);
      if (info && info.mtimeMs > newest) newest = info.mtimeMs;
    }
    return newest;
  } catch {
    return null;
  }
}

export interface RaftDiskJanitorBackupRemoval {
  ownerAgentId: string;
  backupKind: "migration" | "preexisting";
  ageDays: number;
  freedBytes: number;
}

export interface RaftDiskJanitorResult {
  migrationGenerationsCleaned: number;
  migrationFreedBytes: number;
  backupsRemoved: RaftDiskJanitorBackupRemoval[];
  backupsFreedBytes: number;
  sweepOutcome: RaftDiskMeasureOutcome;
}

/**
 * One bounded janitor pass:
 * - idle (>7d) migration transport generations lose their bulk data;
 * - workspace backups get the existing keep-3 / 7-day rule, which until now
 *   only ran when the same agent migrated again.
 */
export async function runRaftDiskJanitor(input: {
  slockHome: string;
  now?: Date;
  budget?: RaftDiskWalkBudget;
}): Promise<RaftDiskJanitorResult> {
  const now = input.now ?? currentDate();
  const budget = input.budget ?? createRaftDiskWalkBudget();
  const result: RaftDiskJanitorResult = {
    migrationGenerationsCleaned: 0,
    migrationFreedBytes: 0,
    backupsRemoved: [],
    backupsFreedBytes: 0,
    sweepOutcome: "complete",
  };

  const migrationsRoot = path.join(input.slockHome, RAFT_MIGRATIONS_DIRECTORY);
  const idleBeforeMs = now.getTime() - RAFT_MIGRATION_GENERATION_IDLE_MS;
  for (const migration of await listDirectories(migrationsRoot)) {
    for (const generation of await listDirectories(path.join(migrationsRoot, migration))) {
      if (budgetExhausted(budget)) break;
      const generationRoot = path.join(migrationsRoot, migration, generation);
      const names = await readdir(generationRoot).catch(() => [] as string[]);
      if (!names.some((name) => MIGRATION_GENERATION_BULK_ENTRY.test(name))) continue;
      const lastActivityMs = await generationLastActivityMs(generationRoot);
      if (lastActivityMs === null || lastActivityMs >= idleBeforeMs) continue;
      result.migrationFreedBytes += await removeMigrationGenerationBulk(generationRoot, budget);
      result.migrationGenerationsCleaned += 1;
    }
  }

  const backupRoot = path.join(input.slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY);
  const ownerAgentIds = await listDirectories(backupRoot);
  const pruneOwner = async (ownerAgentId: string, measureSizes: boolean): Promise<void> => {
    const agentBackupRoot = path.join(backupRoot, ownerAgentId);
    await pruneAgentMigrationWorkspaceBackups({
      agentBackupRoot,
      now,
      measureBytes: measureSizes ? (backupPath) => measureDirectoryBytes(backupPath, budget) : undefined,
      beforeRemove: async (entry, measuredBytes) => {
        const freedBytes = measuredBytes ?? await measureDirectoryBytes(path.join(agentBackupRoot, entry.name), budget);
        result.backupsFreedBytes += freedBytes;
        result.backupsRemoved.push({
          ownerAgentId,
          backupKind: entry.name.startsWith("preexisting-") ? "preexisting" : "migration",
          ageDays: Math.floor((now.getTime() - entry.modifiedAtMs) / (24 * 60 * 60 * 1_000)),
          freedBytes,
        });
      },
    });
  };
  // Count and age first for every agent; sizing kept backups can take the
  // whole walk budget, so the size cap only spends what is left.
  for (const ownerAgentId of ownerAgentIds) {
    if (budgetExhausted(budget)) break;
    await pruneOwner(ownerAgentId, false);
  }
  for (const ownerAgentId of ownerAgentIds) {
    if (budgetExhausted(budget)) break;
    await pruneOwner(ownerAgentId, true);
  }
  result.sweepOutcome = budget.outcome;
  return result;
}

/** First pass well after startup, then daily. */
export const RAFT_DISK_JANITOR_INITIAL_DELAY_MS = 10 * 60 * 1_000;
export const RAFT_DISK_JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface RaftDiskJanitorTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const defaultTimers: RaftDiskJanitorTimers = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Runs `pass` after the initial delay and then every interval; never overlapping. */
export function scheduleRaftDiskJanitor(input: {
  pass: () => Promise<void>;
  timers?: RaftDiskJanitorTimers;
  initialDelayMs?: number;
  intervalMs?: number;
}): { stop(): void } {
  const timers = input.timers ?? defaultTimers;
  let timer: unknown = null;
  let stopped = false;
  const arm = (delayMs: number) => {
    timer = timers.setTimeout(() => {
      timer = null;
      void input.pass().catch(() => {}).finally(() => {
        if (!stopped) arm(input.intervalMs ?? RAFT_DISK_JANITOR_INTERVAL_MS);
      });
    }, delayMs);
  };
  arm(input.initialDelayMs ?? RAFT_DISK_JANITOR_INITIAL_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}

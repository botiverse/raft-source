// Ordered singleton migration phases for the deploy path.
//
// The stock PostgreSQL migrator runs every migration it is given in one
// transaction. The deploy runner invokes it once per migration so no migration
// can accidentally extend the lock lifetime of the migrations around it. Each
// phase is a temporary one-entry view of the exact journal: SQL files are copied
// byte-for-byte, and Drizzle still owns SQL execution and journal inserts.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

const MIN_LOCK_TIMEOUT_MS = 100;
const MAX_LOCK_TIMEOUT_MS = 60_000;

export type MigrationPhase = {
  tags: string[];
  migrations: MigrationMeta[];
};

type JournalEntry = {
  idx: number;
  version?: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
};

type MigrationJournal = {
  version?: string;
  dialect?: string;
  entries: JournalEntry[];
};

export type MigrationPhaseConfig = {
  lockTimeoutMs: number;
  advisoryLockNamespace: number;
  advisoryLockKey: number;
};

const MIGRATION_ADVISORY_NAMESPACE_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE";
const MIGRATION_ADVISORY_KEY_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_KEY";
const PG_INT32_MIN = -2_147_483_648;
const PG_INT32_MAX = 2_147_483_647;

/**
 * Resolve lock settings supplied by the deploy contract. Phase isolation is a
 * source invariant: every migration is a singleton, so there is no opt-in list
 * that a future release can forget to extend.
 */
export function resolveMigrationPhaseConfig(env: NodeJS.ProcessEnv): MigrationPhaseConfig {
  if (
    env.SERVER_MIGRATION_PHASE_BOUNDARY_TAGS?.trim()
    || env.SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS?.trim()
    || env.SERVER_MIGRATION_LOCK_SCHEMA?.trim()
    || env.SERVER_MIGRATION_LOCK_RELATIONS?.trim()
  ) {
    throw new Error("MIGRATION_PHASE_CONFIG_OBSOLETE");
  }

  const lockRaw = env.SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS?.trim() ?? "";
  if (!lockRaw || !/^[1-9][0-9]*$/.test(lockRaw)) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }
  const lockTimeoutMs = Number(lockRaw);
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < MIN_LOCK_TIMEOUT_MS || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }

  const namespaceRaw = env[MIGRATION_ADVISORY_NAMESPACE_ENV]?.trim() ?? "";
  const keyRaw = env[MIGRATION_ADVISORY_KEY_ENV]?.trim() ?? "";
  if (!/^-?[0-9]+$/.test(namespaceRaw) || !/^-?[0-9]+$/.test(keyRaw)) {
    throw new Error("MIGRATION_ADVISORY_LOCK_INVALID");
  }
  const advisoryLockNamespace = Number(namespaceRaw);
  const advisoryLockKey = Number(keyRaw);
  if (
    !Number.isSafeInteger(advisoryLockNamespace)
    || !Number.isSafeInteger(advisoryLockKey)
    || advisoryLockNamespace < PG_INT32_MIN
    || advisoryLockNamespace > PG_INT32_MAX
    || advisoryLockKey < PG_INT32_MIN
    || advisoryLockKey > PG_INT32_MAX
  ) {
    throw new Error("MIGRATION_ADVISORY_LOCK_INVALID");
  }

  return {
    lockTimeoutMs,
    advisoryLockNamespace,
    advisoryLockKey,
  };
}

/**
 * Split an ordered journal into singleton phases. This is deliberately the
 * default rather than an opt-in boundary list: newly-added migrations must not
 * silently fall into the previous migration's transaction.
 */
export function splitMigrationPhases(
  tags: string[],
  migrations: MigrationMeta[],
): MigrationPhase[] {
  if (tags.length !== migrations.length) {
    throw new Error("MIGRATION_MANIFEST_JOURNAL_LENGTH_MISMATCH");
  }
  return tags.map((tag, index) => ({ tags: [tag], migrations: [migrations[index]] }));
}

/**
 * Create a temporary journal view containing exactly one contiguous phase.
 * Drizzle computes hashes from the copied SQL bytes, so journal rows retain
 * the canonical hashes and created_at values from the repository manifest.
 */
export function createMigrationPhaseFolder(
  migrationsFolder: string,
  phase: MigrationPhase,
): string {
  const sourceJournal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = sourceJournal.entries;
  const start = entries.findIndex((entry) => entry.tag === phase.tags[0]);
  const selected = entries.slice(start, start + phase.tags.length);
  if (
    start < 0
    || selected.length !== phase.tags.length
    || selected.some((entry, index) => entry.tag !== phase.tags[index])
  ) {
    throw new Error("MIGRATION_PHASE_JOURNAL_MISMATCH");
  }

  const phaseFolder = mkdtempSync(path.join(os.tmpdir(), "slock-migration-phase-"));
  try {
    mkdirSync(path.join(phaseFolder, "meta"));
    writeFileSync(
      path.join(phaseFolder, "meta", "_journal.json"),
      JSON.stringify({ ...sourceJournal, entries: selected }),
    );
    for (const tag of phase.tags) {
      copyFileSync(
        path.join(migrationsFolder, `${tag}.sql`),
        path.join(phaseFolder, `${tag}.sql`),
      );
    }
    return phaseFolder;
  } catch (error) {
    rmSync(phaseFolder, { recursive: true, force: true });
    throw error;
  }
}

export type MigrationPhaseDriver = (
  phase: MigrationPhase,
  phaseFolder: string,
) => Promise<void>;

export type MigrationPhasePreflight = (phase: MigrationPhase) => Promise<void>;

export type MigrationLockPreflightQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<{ rows: readonly Record<string, unknown>[] }>;

/** Acquire the deploy-wide lease without ever waiting indefinitely. A
 * concurrent migration task is a bounded fail-closed outcome; the PostgreSQL
 * session close releases the lease after this run completes. */
export async function acquireMigrationAdvisoryLock(
  query: MigrationLockPreflightQuery,
  namespace: number,
  key: number,
): Promise<void> {
  const result = await query(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [namespace, key],
  );
  const acquired = result.rows[0]?.acquired === true || result.rows[0]?.acquired === "t";
  if (!acquired) throw new Error("MIGRATION_ADVISORY_LOCK_UNAVAILABLE");
}



/**
 * Apply ordered phases. A failed phase is rolled back by the canonical
 * Drizzle driver; earlier committed phases remain journaled and can be
 * skipped safely on the next invocation.
 */
export async function runMigrationPhases(
  migrationsFolder: string,
  drive: MigrationPhaseDriver,
  beforePhase?: MigrationPhasePreflight,
): Promise<void> {
  const tags = readPhaseJournalTags(migrationsFolder);
  const migrations = readMigrationFiles({ migrationsFolder });
  const phases = splitMigrationPhases(tags, migrations);
  for (const phase of phases) {
    await beforePhase?.(phase);
    const phaseFolder = createMigrationPhaseFolder(migrationsFolder, phase);
    try {
      await drive(phase, phaseFolder);
    } finally {
      rmSync(phaseFolder, { recursive: true, force: true });
    }
  }
}

export function readPhaseJournalTags(migrationsFolder: string): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  return journal.entries.map((entry) => entry.tag);
}

// ---------------------------------------------------------------------------
// Per-migration transaction timeout (auto-release step 1, #botiverse-raft-deployment:3e5ec8cc).
//
// PostgreSQL 17 fixes a transaction's `transaction_timeout` when the
// transaction BEGINs: a `SET LOCAL transaction_timeout` inside the migration
// neither raises nor lowers it (measured on 17.11), and hitting it terminates
// the whole connection (FATAL 25P04), not just the transaction. Drizzle opens
// each migration's transaction itself, so the runner sets the session value
// before each phase. A migration that legitimately needs longer declares it in
// its leading comment block:
//
//   -- migration: transaction_timeout=15min
//
// Migrations numbered below the cutoff were written before this existed (0601
// scans for ~10 minutes); they run with no transaction timeout so a fresh
// database still replays the whole history.

/** First migration number that runs under a transaction timeout. Fixed in
 * source, never derived at run time; see migrationPhases.test.ts. */
export const MIGRATION_TRANSACTION_TIMEOUT_FROM = 611;
export const DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS = 30_000;
const MAX_MIGRATION_TRANSACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export type MigrationTransactionTimeout = {
  /** null = no transaction timeout (a migration from before the cutoff). */
  ms: number | null;
  source: "before-cutoff" | "default" | "declared" | "malformed-declaration";
};

const DIRECTIVE = /^--\s*migration:\s*transaction_timeout\s*=\s*(.*?)\s*$/i;
const DURATION = /^([1-9][0-9]*)(ms|s|min|h)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 };

/** The number a drizzle tag starts with (`0611_x` -> 611), or null. */
export function migrationNumber(tag: string): number | null {
  const match = /^([0-9]{4,})_/.exec(tag);
  return match ? Number(match[1]) : null;
}

/** Read `-- migration: transaction_timeout=…` from the leading comment block
 * only (comment and blank lines before the first statement). Anything that is
 * not exactly one well-formed declaration is malformed: the runner then uses
 * the default, and the release classifier refuses to auto-ship the file. */
export function parseTransactionTimeoutDeclaration(
  sql: string,
): { kind: "none" } | { kind: "declared"; ms: number } | { kind: "malformed"; raw: string } {
  const found: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break;
    const match = DIRECTIVE.exec(trimmed);
    if (match) found.push(match[1]);
    else if (/^--\s*migration:/i.test(trimmed)) found.push(trimmed);
  }
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "malformed", raw: found.join(" | ") };
  const duration = DURATION.exec(found[0]);
  if (!duration) return { kind: "malformed", raw: found[0] };
  const ms = Number(duration[1]) * UNIT_MS[duration[2]];
  if (!Number.isSafeInteger(ms) || ms > MAX_MIGRATION_TRANSACTION_TIMEOUT_MS) {
    return { kind: "malformed", raw: found[0] };
  }
  return { kind: "declared", ms };
}

export function resolveMigrationTransactionTimeout(tag: string, sql: string): MigrationTransactionTimeout {
  const number = migrationNumber(tag);
  // A tag without the NNNN_ prefix cannot be placed before the cutoff, so it
  // gets the limit: a misnamed new migration must not skip the protection.
  if (number !== null && number < MIGRATION_TRANSACTION_TIMEOUT_FROM) {
    return { ms: null, source: "before-cutoff" };
  }
  const declaration = parseTransactionTimeoutDeclaration(sql);
  if (declaration.kind === "declared") return { ms: declaration.ms, source: "declared" };
  if (declaration.kind === "malformed") {
    return { ms: DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS, source: "malformed-declaration" };
  }
  return { ms: DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS, source: "default" };
}

/** SQLSTATE 25P04: the session was terminated by transaction_timeout. */
export const TRANSACTION_TIMEOUT_SQLSTATE = "25P04";

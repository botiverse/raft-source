// Ordered migration phases for the deploy path.
//
// The stock PostgreSQL migrator runs every migration it is given in one
// transaction. The deploy runner invokes it once per phase so a lock-sensitive
// migration starts only after earlier migrations have committed. Each phase is
// a temporary view of the exact journal: SQL files are copied byte-for-byte,
// and Drizzle still owns SQL execution and journal inserts.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";

const MIGRATION_TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;
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
  boundaryTags: string[];
  requiredBoundaryTags: string[];
  lockTimeoutMs: number;
  lockSchema: string;
  lockRelations: string[];
  advisoryLockNamespace: number;
  advisoryLockKey: number;
};

const MIGRATION_REQUIRED_BOUNDARIES_ENV = "SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS";
const MIGRATION_LOCK_SCHEMA_ENV = "SERVER_MIGRATION_LOCK_SCHEMA";
const MIGRATION_LOCK_RELATIONS_ENV = "SERVER_MIGRATION_LOCK_RELATIONS";
const MIGRATION_ADVISORY_NAMESPACE_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE";
const MIGRATION_ADVISORY_KEY_ENV = "SERVER_MIGRATION_ADVISORY_LOCK_KEY";
const PG_INT32_MIN = -2_147_483_648;
const PG_INT32_MAX = 2_147_483_647;
const PG_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Resolve phase and lock settings supplied by the deploy contract. The helper
 * owns only generic syntax, ordering, and range validation; the deploy
 * contract owns which migrations require a phase and which relations it covers.
 */
export function resolveMigrationPhaseConfig(
  env: NodeJS.ProcessEnv,
  tags: readonly string[],
): MigrationPhaseConfig {
  const tagSet = new Set(tags);
  const boundaryRaw = env.SERVER_MIGRATION_PHASE_BOUNDARY_TAGS?.trim() ?? "";
  const boundaryTags = boundaryRaw
    ? boundaryRaw.split(",").map((tag) => tag.trim())
    : [];
  if (boundaryTags.length === 0) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_REQUIRED");
  }

  if (boundaryTags.some((tag) => !MIGRATION_TAG_PATTERN.test(tag))) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_INVALID");
  }
  if (new Set(boundaryTags).size !== boundaryTags.length) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_DUPLICATE");
  }
  if (boundaryTags.some((tag) => !tagSet.has(tag))) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_UNKNOWN");
  }
  const boundaryIndexes = boundaryTags.map((tag) => tags.indexOf(tag));
  if (boundaryIndexes.some((index, position) => position > 0 && index <= boundaryIndexes[position - 1])) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_ORDER_INVALID");
  }

  const requiredBoundaryRaw = env[MIGRATION_REQUIRED_BOUNDARIES_ENV]?.trim() ?? "";
  const requiredBoundaryTags = requiredBoundaryRaw
    ? requiredBoundaryRaw.split(",").map((tag) => tag.trim())
    : [];
  if (
    requiredBoundaryTags.some((tag) => !MIGRATION_TAG_PATTERN.test(tag))
    || new Set(requiredBoundaryTags).size !== requiredBoundaryTags.length
    || requiredBoundaryTags.some((tag) => !tagSet.has(tag))
  ) {
    throw new Error("MIGRATION_REQUIRED_PHASE_BOUNDARY_INVALID");
  }
  if (requiredBoundaryTags.some((tag) => !boundaryTags.includes(tag))) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_REQUIRED");
  }

  const lockRaw = env.SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS?.trim() ?? "";
  if (!lockRaw || !/^[1-9][0-9]*$/.test(lockRaw)) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }
  const lockTimeoutMs = Number(lockRaw);
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < MIN_LOCK_TIMEOUT_MS || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw new Error("MIGRATION_LOCK_TIMEOUT_INVALID");
  }

  const lockSchema = env[MIGRATION_LOCK_SCHEMA_ENV]?.trim() ?? "";
  if (!PG_IDENTIFIER_PATTERN.test(lockSchema)) {
    throw new Error("MIGRATION_LOCK_SCHEMA_INVALID");
  }

  const relationRaw = env[MIGRATION_LOCK_RELATIONS_ENV]?.trim() ?? "";
  const lockRelations = relationRaw
    ? relationRaw.split(",").map((relation) => relation.trim())
    : [];
  if (
    lockRelations.length === 0
    || lockRelations.some((relation) => !PG_IDENTIFIER_PATTERN.test(relation))
    || new Set(lockRelations).size !== lockRelations.length
  ) {
    throw new Error("MIGRATION_LOCK_RELATIONS_INVALID");
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
    boundaryTags,
    requiredBoundaryTags,
    lockTimeoutMs,
    lockSchema,
    lockRelations,
    advisoryLockNamespace,
    advisoryLockKey,
  };
}

/**
 * Split an ordered journal into phases. A boundary tag starts a new phase;
 * the boundary migration itself remains in that new phase.
 */
export function splitMigrationPhases(
  tags: string[],
  migrations: MigrationMeta[],
  phaseBoundaryTags: readonly string[],
): MigrationPhase[] {
  if (tags.length !== migrations.length) {
    throw new Error("MIGRATION_MANIFEST_JOURNAL_LENGTH_MISMATCH");
  }
  if (tags.length === 0) return [];
  if (phaseBoundaryTags.some((tag) => !tags.includes(tag))) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_UNKNOWN");
  }
  if (new Set(phaseBoundaryTags).size !== phaseBoundaryTags.length) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_DUPLICATE");
  }
  const boundaryIndexes = phaseBoundaryTags.map((tag) => tags.indexOf(tag));
  if (boundaryIndexes.some((index, position) => position > 0 && index <= boundaryIndexes[position - 1])) {
    throw new Error("MIGRATION_PHASE_BOUNDARY_ORDER_INVALID");
  }

  const boundaries = new Set(phaseBoundaryTags);
  const phases: MigrationPhase[] = [];
  let currentTags: string[] = [];
  let currentMigrations: MigrationMeta[] = [];

  for (let i = 0; i < tags.length; i += 1) {
    if (currentTags.length > 0 && boundaries.has(tags[i])) {
      phases.push({ tags: currentTags, migrations: currentMigrations });
      currentTags = [];
      currentMigrations = [];
    }
    currentTags.push(tags[i]);
    currentMigrations.push(migrations[i]);
  }

  phases.push({ tags: currentTags, migrations: currentMigrations });
  return phases;
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
 * Read-only admission check for the relations supplied by the deploy
 * contract. It rejects an already-waiting relation lock or a
 * transaction older than the configured lock budget while holding one of
 * those relation locks. It also fails closed when the schema is already
 * established but a configured relation does not resolve to a real table:
 * the query matches names with `relname = ANY($2)`, so an unknown or misspelled
 * name matches nothing and raises nothing — the guard would keep passing while
 * watching nothing. That silent-blindness failure mode is exactly what let the
 * v1.13.0 deadlock through, so it must be loud.
 *
 * The resolution check is scoped to an established schema on purpose. The
 * preflight also runs before the FIRST phase of a fresh database, where the
 * configured relations legitimately do not exist yet — they are created by the
 * very migrations that phase is about to run. Treating those as configuration
 * errors would fail closed on every first install. "Established" is read from
 * the presence of the drizzle accounting schema, which the migrator creates
 * before it executes anything.
 *
 * ⚠️ CONSTRAINT on SERVER_MIGRATION_LOCK_RELATIONS: declare only relations that
 * already exist when this migration batch STARTS. The check asks whether each
 * configured relation resolves right now, so naming a table that this batch
 * itself creates would fail closed during the earlier phases - the config would
 * be correct but blocked. To protect a table introduced by a later batch, add it
 * to this list once it exists, in the release that follows its creation.
 *
 * This is a race-reducing preflight, not a substitute for the per-session
 * lock_timeout used by the canonical migrator.
 */
export async function runMigrationLockPreflight(
  query: MigrationLockPreflightQuery,
  lockTimeoutMs: number,
  lockSchema: string,
  lockRelations: readonly string[],
): Promise<void> {
  const result = await query(
    `WITH target_relations AS (
       SELECT c.oid
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = $3
         AND c.relname = ANY($2::text[])
     ), lock_observations AS (
       SELECT l.granted, a.xact_start
       FROM pg_locks AS l
       JOIN pg_stat_activity AS a ON a.pid = l.pid
       WHERE l.pid <> pg_backend_pid()
         AND l.relation IN (SELECT oid FROM target_relations)
     )
     SELECT
       (SELECT count(*)::int FROM target_relations) AS resolved_relations,
       (SELECT count(*)::int
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations') AS schema_established,
       count(*) FILTER (WHERE NOT granted)::int AS waiting_locks,
       count(*) FILTER (
         WHERE xact_start IS NOT NULL
           AND xact_start < clock_timestamp() - ($1::bigint * interval '1 millisecond')
       )::int AS long_transactions
     FROM lock_observations`,
    [lockTimeoutMs, lockRelations, lockSchema],
  );
  const row = result.rows[0];
  const resolvedRelations = Number(row?.resolved_relations ?? Number.NaN);
  const schemaEstablished = Number(row?.schema_established ?? Number.NaN);
  const waitingLocks = Number(row?.waiting_locks ?? 0);
  const longTransactions = Number(row?.long_transactions ?? 0);
  if (
    !Number.isSafeInteger(resolvedRelations)
    || !Number.isSafeInteger(schemaEstablished)
    || !Number.isSafeInteger(waitingLocks)
    || !Number.isSafeInteger(longTransactions)
  ) {
    throw new Error("MIGRATION_LOCK_PREFLIGHT_UNREADABLE");
  }
  if (schemaEstablished > 0 && resolvedRelations !== lockRelations.length) {
    // Schema exists, so the contract named relations that should be present.
    // Fail closed: we cannot prove the guard is watching what was named.
    throw new Error("MIGRATION_LOCK_PREFLIGHT_RELATION_UNRESOLVED");
  }
  if (waitingLocks > 0 || longTransactions > 0) {
    throw new Error("MIGRATION_LOCK_PREFLIGHT_BLOCKED");
  }
}

/**
 * Apply ordered phases. A failed phase is rolled back by the canonical
 * Drizzle driver; earlier committed phases remain journaled and can be
 * skipped safely on the next invocation.
 */
export async function runMigrationPhases(
  migrationsFolder: string,
  phaseBoundaryTags: readonly string[],
  drive: MigrationPhaseDriver,
  beforePhase?: MigrationPhasePreflight,
): Promise<void> {
  const tags = readPhaseJournalTags(migrationsFolder);
  const migrations = readMigrationFiles({ migrationsFolder });
  const phases = splitMigrationPhases(tags, migrations, phaseBoundaryTags);
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

// Deploy-path migration runner with OWNED failure output (task #379 evidence:
// drizzle-kit's bundled hanji@0.0.8 renderWithTask() swallows the rejection and
// calls process.exit(1) directly — CI/FORCE_COLOR env never participates, so a
// failing migration surfaces as "spinner + exit 1" with no SQLSTATE. The 0214
// staging failure was undiagnosable from first-run logs for exactly this
// reason.)
//
// This module replaces the `drizzle-kit migrate` CLI on the DEPLOY path with
// drizzle-orm's programmatic migrator (same journal, same
// drizzle.__drizzle_migrations accounting), so the error object never passes
// through hanji: we format SQLSTATE + failing migration + message ourselves,
// print it, then exit non-zero. The migrator function is injected per driver
// (node-postgres in the CLI, pglite in tests).
import { readFileSync } from "node:fs";
import path from "node:path";

export interface DeployMigrationFailure {
  sqlstate: string | null;
  message: string;
  migrationTag: string | null;
  position: string | null;
  statement: string | null;
}

interface JournalEntry {
  tag: string;
}

export function readJournalTags(migrationsFolder: string): string[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((e) => e.tag);
}

/**
 * node-postgres (and pglite) surface the PostgreSQL SQLSTATE as `code` on the
 * thrown error; drizzle may wrap it, so walk the `cause` chain until a
 * five-char code is found. Never throws.
 */
const QUERY_SNIPPET_MAX = 300;
const MESSAGE_MAX = 500;

/**
 * All dynamic fields go through this before entering the single log line:
 * strip ANSI/ESC sequences and control characters, fold CR/LF/whitespace to
 * single spaces, and bound the length — a hostile or multiline PG message must
 * not split or pollute the one CloudWatch line.
 */
export function sanitizeLogField(value: string, max: number): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function extractPgError(err: unknown): {
  code: string | null;
  message: string;
  position: string | null;
  query: string | null;
} {
  const message = err instanceof Error ? err.message : String(err);
  let code: string | null = null;
  let pgMessage: string | null = null;
  let position: string | null = null;
  let query: string | null = null;
  let cursor: unknown = err;
  // Walk the real error chain: DrizzleQueryError carries the failing SQL as
  // `query`; the deepest pg error carries `code` (SQLSTATE) + server message.
  for (let depth = 0; depth < 6 && cursor; depth++) {
    const candidate = cursor as {
      code?: unknown;
      message?: unknown;
      position?: unknown;
      query?: unknown;
      cause?: unknown;
    };
    if (query === null && typeof candidate.query === "string" && candidate.query.length > 0) {
      query = candidate.query;
    }
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      code = candidate.code;
      pgMessage = typeof candidate.message === "string" ? candidate.message : null;
      position = typeof candidate.position === "string" ? candidate.position : null;
    }
    cursor = candidate.cause;
  }
  return { code, message: pgMessage ?? message, position, query };
}

export function boundStatementSnippet(query: string | null): string | null {
  if (!query) return null;
  return sanitizeLogField(query, QUERY_SNIPPET_MAX);
}

/**
 * Each deploy phase is applied by Drizzle in one transaction. A failed phase
 * rolls back its transient statements, while earlier completed phases retain
 * their normal Drizzle journal rows. The reliable source for the failing tag
 * is still the failing statement itself (DrizzleQueryError.query): find the
 * journal file that contains it verbatim, restricted to the unapplied tail.
 */
export function findFailingTag(
  migrationsFolder: string,
  rawQuery: string | null,
  appliedCount: number | null,
): string | null {
  if (!rawQuery) return null;
  const needle = rawQuery.trim();
  if (needle.length === 0) return null;
  // The current phase rolled back, so post-failure accounting rows = migrations
  // applied by earlier deploys and completed phases. Only PENDING tags can be
  // the failing one —
  // matching across applied tags would blame an old migration whenever the
  // same statement text recurs. Ambiguity (multiple pending matches) is
  // fail-closed to UNKNOWN: a wrong tag is worse than no tag.
  if (appliedCount === null) {
    // Accounting unreadable: scanning ALL tags would deterministically blame
    // an already-applied migration whenever statement text recurs — a wrong
    // tag is worse than UNKNOWN, so fail closed.
    return null;
  }
  const tags = readJournalTags(migrationsFolder);
  const pending = tags.slice(appliedCount);
  const matches: string[] = [];
  for (const tag of pending) {
    try {
      const content = readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
      if (content.includes(needle)) matches.push(tag);
    } catch {
      // Missing file: skip; tag resolution stays best-effort.
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function formatMigrationFailure(failure: DeployMigrationFailure): string {
  // ONE deterministic line, no ANSI, no DSN/secret material: only the
  // SQLSTATE, the journal tag, the server message, and a bounded statement
  // snippet taken from the real error chain (DrizzleQueryError.query).
  const message = sanitizeLogField(failure.message, MESSAGE_MAX);
  const statement = failure.statement ? sanitizeLogField(failure.statement, QUERY_SNIPPET_MAX) : null;
  // The tag comes from journal file names — untrusted for log purposes like
  // every other dynamic field. Sanitize + bound it too.
  const tag = failure.migrationTag ? sanitizeLogField(failure.migrationTag, 120) : null;
  return (
    `[MIGRATION_FAILED] sqlstate=${failure.sqlstate ?? "UNKNOWN"} ` +
    `migration=${tag && tag.length > 0 ? tag : "UNKNOWN"} ` +
    (failure.position ? `position=${sanitizeLogField(failure.position, 16)} ` : "") +
    `message=${message}` +
    (statement ? ` statement=${statement}` : "")
  );
}

/**
 * Accounting-read failure classification for the CLI's appliedCount seam:
 * a FRESH database has no drizzle journal table yet (SQLSTATE 42P01) — that is
 * a true "0 applied" and first-run tag resolution must keep working. Any OTHER
 * read failure (permissions, connection, unexpected) is unknown -> null, which
 * fail-closes tag resolution to UNKNOWN.
 */
export function classifyAppliedCountError(err: unknown): 0 | null {
  const pg = extractPgError(err);
  return pg.code === "42P01" ? 0 : null;
}

type MigrateFn = (opts: { migrationsFolder: string }) => Promise<void>;
type AppliedCountFn = () => Promise<number | null>;

/**
 * SQLSTATEs that represent a transient CONCURRENCY loss rather than a defect in
 * the migration itself. 40P01 (deadlock_detected) and 40001
 * (serialization_failure) both mean "another live session won a lock race" —
 * Postgres aborted *our* transaction to break the cycle, and the identical
 * statement is expected to succeed once the other session commits. Every other
 * SQLSTATE is a real defect (bad SQL, missing relation, constraint violation)
 * and MUST fail on the first attempt: retrying those would convert a genuine
 * error into an accidental success and hide it.
 */
const RETRYABLE_MIGRATION_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);

/** Budget for a deadlock retry. The whole phase rolls back on failure, so one
 * attempt costs a full re-run; the budget is deliberately small and the first
 * retry is delayed long enough for the lock holder to commit. Environment
 * overrides exist so the real-Postgres tooth can drive a fast run. */
export const MIGRATION_RETRY_MAX_ATTEMPTS = readPositiveIntEnv("SERVER_MIGRATION_RETRY_MAX_ATTEMPTS", 3);
export const MIGRATION_RETRY_BASE_DELAY_MS = readPositiveIntEnv("SERVER_MIGRATION_RETRY_BASE_DELAY_MS", 2_000);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export interface DeployMigrationRetryDeps {
  /** Overridable so tests do not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter. Jitter matters here: without it a
 * retry that collided once re-collides at the same interval as any other
 * waiter, and several concurrent deployments (or a retried ECS task) would
 * re-contend in lockstep.
 */
function retryDelayMs(attempt: number, baseDelayMs: number): number {
  const ceiling = baseDelayMs * 2 ** (attempt - 1);
  return Math.floor(Math.random() * ceiling) + Math.floor(ceiling / 2);
}

/**
 * Runs pending migrations via the injected driver migrator. On failure, emits
 * ONE structured `[MIGRATION_FAILED]` line (SQLSTATE + failing migration tag +
 * server message) via `log`, so a failed attempt's logs are always sufficient
 * to diagnose — no TTY dependence. The failing tag is derived from drizzle's own
 * accounting: with N rows recorded in drizzle.__drizzle_migrations, journal[N]
 * is the migration that was in flight.
 *
 * A transient concurrency SQLSTATE (40P01/40001) is retried within a bounded
 * budget, because a failed phase rolls back wholesale — re-running from the
 * phase boundary is safe and is exactly the observable retry the deploy path
 * previously lacked. Each attempt emits its own reason= line so CloudWatch
 * shows whether retries happened and how they resolved. Non-retryable SQLSTATEs
 * rethrow immediately; the final attempt's failure always rethrows, so a run
 * never reports success unless every phase actually committed.
 */
export async function runDeployMigrations(
  migrateFn: MigrateFn,
  migrationsFolder: string,
  appliedCount: AppliedCountFn,
  log: (line: string) => void = console.error,
  deps: DeployMigrationRetryDeps = {},
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? MIGRATION_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = deps.baseDelayMs ?? MIGRATION_RETRY_BASE_DELAY_MS;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrateFn({ migrationsFolder });
      if (attempt > 1) {
        log(
          `[MIGRATION_RETRY_SUCCEEDED] attempt=${attempt}/${maxAttempts} ` +
            `all pending migrations applied after transient concurrency failure`,
        );
      }
      return;
    } catch (err) {
      const pg = extractPgError(err);
      const retryable = pg.code !== null && RETRYABLE_MIGRATION_SQLSTATES.has(pg.code);
      const exhausted = attempt >= maxAttempts;
      let migrationTag: string | null = null;
      try {
        const applied = await appliedCount();
        // Primary: unique pending journal file containing the failing statement.
        migrationTag = findFailingTag(migrationsFolder, pg.query, applied);
        if (migrationTag === null && pg.query === null && applied !== null) {
          // Fallback only when NO statement is available: next unapplied tag.
          migrationTag = readJournalTags(migrationsFolder)[applied] ?? null;
        }
      } catch {
        // Tag resolution is best-effort; the SQLSTATE/message line must still go out.
      }
      log(
        formatMigrationFailure({
          sqlstate: pg.code,
          message: pg.message,
          migrationTag,
          position: pg.position,
          statement: boundStatementSnippet(pg.query),
        }),
      );
      if (!retryable || exhausted) {
        if (retryable && exhausted) {
          log(
            `[MIGRATION_RETRY_EXHAUSTED] sqlstate=${pg.code} attempts=${attempt}/${maxAttempts} ` +
              `transient concurrency failure persisted; failing the deploy`,
          );
        }
        throw err;
      }
      const delayMs = retryDelayMs(attempt, baseDelayMs);
      log(
        `[MIGRATION_RETRY] reason=sqlstate=${pg.code} attempt=${attempt}/${maxAttempts} ` +
          `retrying_in_ms=${delayMs}`,
      );
      await sleep(delayMs);
    }
  }
}

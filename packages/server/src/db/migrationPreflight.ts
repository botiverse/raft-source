// Permanent head-bound admission preflight for production migrations.
//
// Runs BEFORE `drizzle-kit migrate` (production `db:migrate:deploy` script) and
// decides — from the exact's OWN bundled migration manifest, never a hard-coded
// head or a `count == N` heuristic — whether it is safe to hand control to the
// canonical migrator. It is ADMISSION-ONLY: it never writes a migration, a
// journal row, or any DB state; it reads three facts and returns a verdict.
//
// Why this shape (context): serving connects through the Neon PrivateLink
// pooler, but the migration statement_timeout is delivered by the
// operator-provisioned migration DSN's `options=-c statement_timeout=` libpq
// startup option, on a dedicated DIRECT/session endpoint where that option is
// honored (DB-role isolation is intentionally absent — the migrator reuses the
// neondb_owner credential; only the ECS task-def/SSM/IAM and the connection are
// separate). This code never injects or rewrites the DSN; it only reads back.
// Production may already be at the target head (this release's migration is then
// a 204->204 no-op, safe under any timeout), or genuinely behind (a real
// migration that MUST run under the intended long timeout, or it can be
// cancelled mid-statement — the opaque failure drizzle-kit swallows). The
// admission rules encode exactly that:
//
//   1. head == target                  -> ADMIT (canonical no-op; timeout moot)
//   2. behind + effective != required  -> REJECT (real migration under wrong timeout)
//   3. behind + effective == required  -> ADMIT (canonical migrate up to target)
//   4. head ahead / diverged / malformed / manifest empty -> REJECT (fail closed)
//   5. never leak the DSN or any row/credential value; target head + db head are
//      bound by BOTH hash and created_at against the exact manifest.
//
// The target and the db-head relationship are derived by matching the db's
// last-applied (hash, created_at) against the exact's readMigrationFiles output
// (hash = full-file sha256, folderMillis = journal `when`) — the same values
// drizzle records — so the check is bound to the shipped migration set.
//
// Side-effect free (no auto-run) so the classifier is unit-testable;
// scripts/migration-preflight.ts is the thin executable.
import pg from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";

const MIN_MS = 1_000;
const MAX_MS = 3_600_000;
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const QT = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

export type PreflightConfig = { kind: "config"; connectionString: string; requiredMs: number };
export type PreflightAbort = { kind: "abort"; code: string; detail?: string };
export type ManifestEntry = { hash: string; folderMillis: number };
export type DbHead = { hash: unknown; createdAt: unknown } | null;
export type AdmissionVerdict = { admit: boolean; code: string; detail?: string };

/** Resolve config from env. Fail-closed, DB-free. The connection string is the
 * RAW DATABASE_URL byte-for-byte; the timeout rides on the operator-provisioned
 * DSN's `options=-c` startup option and is never injected/rewritten here. */
export function resolvePreflightConfig(
  env: NodeJS.ProcessEnv,
): PreflightConfig | PreflightAbort {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return { kind: "abort", code: "MISSING_DATABASE_URL" };

  // The pre-rename name is refused outright — never read as a fallback. It used
  // to name a value that was *applied* (injected onto the migration DSN by
  // `withMigrationStatementTimeout`); that injection was removed because a bare
  // `?statement_timeout=` is silently dropped by the Neon PrivateLink pooler.
  // The value now only *declares* what this preflight expects to read back from
  // a fresh connection, and the operator-provisioned DSN's `options=-c` startup
  // option (on the direct/session endpoint) is what actually delivers it.
  // Accepting the old name — even as a dual-read — would let a stale deploy
  // config keep looking effective while delivering nothing, which is the exact
  // failure this preflight exists to catch.
  if (env.SERVER_MIGRATION_STATEMENT_TIMEOUT_MS !== undefined) {
    return {
      kind: "abort",
      code: "DEPRECATED_TIMEOUT_ENV",
      detail: "SERVER_MIGRATION_STATEMENT_TIMEOUT_MS was renamed to "
        + "SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS; the old name implied the value was "
        + "applied, but it is only the expected value read back — delivered by the "
        + "operator-provisioned DSN's options=-c startup option, not by this code",
    };
  }

  const raw = env.SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS?.trim();
  if (!raw) return { kind: "abort", code: "MISSING_TIMEOUT" };
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return { kind: "abort", code: "INVALID_TIMEOUT", detail: "not a positive integer" };
  }
  const requiredMs = Number(raw);
  if (!Number.isSafeInteger(requiredMs) || requiredMs < MIN_MS || requiredMs > MAX_MS) {
    return { kind: "abort", code: "INVALID_TIMEOUT", detail: `out of range [${MIN_MS},${MAX_MS}]` };
  }
  return { kind: "config", connectionString: databaseUrl, requiredMs };
}

/** Read the exact's own migration manifest into ordered {hash, folderMillis}.
 * Throws if the folder is unreadable or empty (caller fails closed). */
export function readManifest(migrationsFolder: string): ManifestEntry[] {
  const entries = readMigrationFiles({ migrationsFolder }).map((m) => ({
    hash: m.hash,
    folderMillis: m.folderMillis,
  }));
  if (entries.length === 0) throw new Error("MANIFEST_EMPTY");
  return entries;
}

/** Pure admission classifier — the frozen 5-tooth contract. DB-free.
 *
 * @param manifest ordered manifest of the exact (last = target head)
 * @param dbHead   the db's last-applied {hash, createdAt} (raw), or null if none
 * @param effective pg_settings.statement_timeout (ms string), or null
 * @param requiredMs the intended migration timeout
 */
export function classifyAdmission(
  manifest: ManifestEntry[],
  dbHead: DbHead,
  effective: unknown,
  requiredMs: number,
): AdmissionVerdict {
  if (manifest.length === 0) return { admit: false, code: "MANIFEST_EMPTY" };
  const target = manifest[manifest.length - 1];

  let atTarget: boolean;
  if (dbHead === null) {
    atTarget = false; // no rows applied -> behind (fresh DB)
  } else {
    const hash = dbHead.hash;
    const createdAt = typeof dbHead.createdAt === "string" ? Number(dbHead.createdAt) : dbHead.createdAt;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) {
      return { admit: false, code: "HEAD_MALFORMED" };
    }
    const idx = manifest.findIndex((m) => m.hash === hash && m.folderMillis === createdAt);
    if (idx === -1) {
      // last-applied is not a known migration of this exact
      return {
        admit: false,
        code: createdAt > target.folderMillis ? "HEAD_AHEAD" : "HEAD_DIVERGED",
      };
    }
    atTarget = idx === manifest.length - 1;
  }

  if (atTarget) {
    // Tooth 1: no-op is admissible regardless of the effective timeout.
    return { admit: true, code: "AT_TARGET_NOOP" };
  }

  // Behind: teeth 2/3 — the intended timeout MUST be effectively delivered.
  const verdict = evaluateEffectiveTimeout(effective, requiredMs);
  if (!verdict.ok) return { admit: false, code: verdict.code, detail: verdict.detail };
  return { admit: true, code: "BEHIND_MIGRATE", detail: verdict.detail };
}

/** Compare pg_settings.statement_timeout (ms) vs expected. Pure, DB-free. */
export function evaluateEffectiveTimeout(
  actual: unknown,
  expectedMs: number,
): { ok: boolean; code: string; detail?: string } {
  if (actual === undefined || actual === null) return { ok: false, code: "EFFECTIVE_MISSING" };
  const actualMs = String(actual);
  if (!/^[0-9]+$/.test(actualMs)) return { ok: false, code: "EFFECTIVE_NON_NUMERIC" };
  if (actualMs !== String(expectedMs)) {
    return { ok: false, code: "EFFECTIVE_MISMATCH", detail: `expected=${expectedMs} actual=${actualMs}` };
  }
  return { ok: true, code: "OK", detail: actualMs };
}

/** Recover a PostgreSQL SQLSTATE from an error or its cause chain (code only). */
export function pgSqlState(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function abort(code: string, detail?: string): never {
  console.error(`[MIGRATION_PREFLIGHT_ABORT] ${code}${detail ? " " + detail : ""}`);
  process.exit(2);
}

/** Execute the admission preflight. Aborts (exit 2) on reject or any error;
 * returns normally on admit. Reads: exact manifest, db head, effective timeout.
 * Writes nothing. Never prints the DSN or any row value. */
export async function runPreflight(
  env: NodeJS.ProcessEnv,
  migrationsFolder: string,
): Promise<void> {
  const cfg = resolvePreflightConfig(env);
  if (cfg.kind === "abort") abort(cfg.code, cfg.detail);

  let manifest: ManifestEntry[];
  try {
    manifest = readManifest(migrationsFolder);
  } catch {
    abort("MANIFEST_UNREADABLE");
  }

  const client = new pg.Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: 15_000 });
  let verdict: AdmissionVerdict;
  try {
    await client.connect();

    // Last-applied migration (db head). A missing bookkeeping table = fresh DB
    // (behind), not an error.
    let dbHead: DbHead = null;
    try {
      const r = await client.query(`SELECT hash, created_at FROM ${QT} ORDER BY created_at DESC LIMIT 1`);
      dbHead = r.rows[0] ? { hash: r.rows[0].hash, createdAt: r.rows[0].created_at } : null;
    } catch (e) {
      const code = pgSqlState(e);
      if (code === "42P01" || code === "3F000") dbHead = null; // undefined_table / undefined_schema
      else throw e;
    }

    const eff = await client.query("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'");
    verdict = classifyAdmission(manifest, dbHead, eff.rows[0]?.setting, cfg.requiredMs);
  } catch (e) {
    // Fail-closed. Never print the error message (it can carry the DSN).
    const code = pgSqlState(e);
    verdict = {
      admit: false,
      code: "CONNECTION_OR_QUERY_ERROR",
      detail: code ? `sqlstate=${code}` : e instanceof Error ? `name=${e.name}` : undefined,
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }

  if (!verdict.admit) abort(verdict.code, verdict.detail);
  const target = manifest[manifest.length - 1];
  console.error(
    `[MIGRATION_PREFLIGHT_OK] admit=${verdict.code} target=${target.hash.slice(0, 12)}${verdict.detail ? " " + verdict.detail : ""}`,
  );
}

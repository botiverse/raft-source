// Deploy-path replacement for `drizzle-kit migrate` (runs after
// migration-preflight in `db:migrate:deploy`). Same locked drizzle-orm
// node-postgres migrator — same journal, same drizzle.__drizzle_migrations
// accounting — the only difference is failure-output ownership: see
// src/db/migrateDeploy.ts. DSN contract matches drizzle.config.ts (consume
// DATABASE_URL byte-for-byte; statement_timeout arrives via the operator DSN's
// `options=-c`, never injected here). MIGRATIONS_FOLDER overrides for tests.
// Output is deterministic plain text: no ANSI, no DSN/secret material.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  acquireMigrationAdvisoryLock,
  resolveMigrationPhaseConfig,
  resolveMigrationTransactionTimeout,
  runMigrationPhases,
  TRANSACTION_TIMEOUT_SQLSTATE,
} from "../src/db/migrationPhases";
import { classifyAppliedCountError, extractPgError, runDeployMigrations, sanitizeLogField } from "../src/db/migrateDeploy";

const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

// One session-wide lease serializes migration tasks without touching schema or
// journal state. The try-lock is held across all canonical Drizzle phase calls
// and released when this client closes; a competing task fails closed.

async function countAppliedMigrations(client: pg.Client): Promise<number | null> {
  try {
    const res = await client.query('SELECT count(*)::int AS applied FROM "drizzle"."__drizzle_migrations"');
    return (res.rows[0]?.applied as number) ?? null;
  } catch (err) {
    return classifyAppliedCountError(err);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "[MIGRATION_FAILED] sqlstate=UNKNOWN migration=UNKNOWN message=DATABASE_URL is not set",
    );
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: url });
  // PostgreSQL ends the session when a migration hits transaction_timeout
  // (FATAL 25P04). The in-flight query rejects with that error and is reported
  // below; the client's own 'error' event must not crash the process first.
  // Log the class only (no message: it can carry connection details) so an
  // idle-time disconnect is not silent.
  client.on("error", (err: unknown) => {
    const code = extractPgError(err).code;
    console.error(
      `[MIGRATION_CLIENT_ERROR] class=${sanitizeLogField(err instanceof Error ? err.name : typeof err, 60)}` +
        (code ? ` sqlstate=${sanitizeLogField(code, 10)}` : ""),
    );
  });
  const migrationReports: string[] = [];
  // Drizzle answers a failed migration with ROLLBACK; on a terminated session
  // that ROLLBACK fails too and its error replaces the original one. Keep the
  // server's own SQLSTATE so the timeout is still reported as such.
  let lastServerErrorCode: string | null = null;
  (client as unknown as { connection: { on(event: "errorMessage", fn: (msg: { code?: string }) => void): void } })
    .connection.on("errorMessage", (msg) => {
      lastServerErrorCode = typeof msg.code === "string" ? msg.code : null;
    });
  client.on("notice", (notice) => {
    // Do not forward arbitrary PostgreSQL notices or report rolled-back work.
    // Only named reports containing numeric fields are released after commit.
    if (/^MIGRATION_REPORT migration=[a-z][a-z0-9_]{0,79}(?: [a-z][a-z0-9_]{0,63}=[0-9]{1,30}){1,20}$/.test(notice.message)) {
      migrationReports.push(notice.message);
    }
  });
  try {
    await client.connect();
    const db = drizzle(client);
    const migrateAndReport = async (folder: string) => {
      migrationReports.length = 0;
      try {
        await migrate(db, { migrationsFolder: folder });
      } catch (error) {
        migrationReports.length = 0;
        throw error;
      }
      for (const notice of migrationReports.splice(0)) console.info(`[${notice}]`);
    };
    const phaseContractRaw = process.env.SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED?.trim() ?? "false";
    if (phaseContractRaw !== "true" && phaseContractRaw !== "false") {
      throw new Error("MIGRATION_PHASE_CONTRACT_REQUIRED_INVALID");
    }
    const phaseContractEnabled = phaseContractRaw === "true";
    const phaseContractFields = [
      "SERVER_MIGRATION_PHASE_BOUNDARY_TAGS",
      "SERVER_MIGRATION_REQUIRED_PHASE_BOUNDARY_TAGS",
      "SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS",
      "SERVER_MIGRATION_LOCK_SCHEMA",
      "SERVER_MIGRATION_LOCK_RELATIONS",
      "SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE",
      "SERVER_MIGRATION_ADVISORY_LOCK_KEY",
    ];
    if (!phaseContractEnabled && phaseContractFields.some((name) => process.env[name]?.trim())) {
      throw new Error("MIGRATION_PHASE_CONTRACT_NOT_ENABLED");
    }
    const migrateFn = phaseContractEnabled
      ? async () => {
          const phaseConfig = resolveMigrationPhaseConfig(process.env);
          await client.query("SELECT set_config('lock_timeout', $1, false)", [
            `${phaseConfig.lockTimeoutMs}ms`,
          ]);
          const lockSetting = await client.query(
            "SELECT setting FROM pg_settings WHERE name = 'lock_timeout'",
          );
          if (lockSetting.rows[0]?.setting !== String(phaseConfig.lockTimeoutMs)) {
            throw new Error("MIGRATION_LOCK_TIMEOUT_NOT_EFFECTIVE");
          }
          await acquireMigrationAdvisoryLock(
            (text, values) => client.query(text, values as unknown[]),
            phaseConfig.advisoryLockNamespace,
            phaseConfig.advisoryLockKey,
          );
          // No lock preflight: the session `lock_timeout` above (set and
          // verified effective) is the guard that bounds how long a migration
          // can wait for a lock, and the advisory lock serialises migrators.
          // The preflight additionally refused to *start* when an unrelated
          // transaction was holding one of the watched relations, which failed
          // releases for reasons unrelated to the change. Removed on the
          // owner's instruction.
          // transaction_timeout exists from PostgreSQL 17 (production and
          // staging run 17.11). Older servers (a local 16) run without it.
          const versionRow = await client.query("SELECT current_setting('server_version_num')::int AS v");
          const supportsTransactionTimeout = Number(versionRow.rows[0]?.v) >= 170000;
          if (!supportsTransactionTimeout) {
            console.info("[MIGRATION_TRANSACTION_TIMEOUT_UNSUPPORTED] server_version_num below 170000; migrations run without transaction_timeout");
          }
          await runMigrationPhases(
            migrationsFolder,
            async (phase, phaseFolder) => {
              // Each phase is one file today (splitMigrationPhases). If phases
              // ever group files, one file's limit must not cover the others.
              if (phase.tags.length !== 1) {
                throw new Error(`migration phase has ${phase.tags.length} files; transaction_timeout is per file`);
              }
              const tag = phase.tags[0];
              const sql = readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
              const timeout = resolveMigrationTransactionTimeout(tag, sql);
              const effectiveMs = supportsTransactionTimeout ? timeout.ms ?? 0 : 0;
              if (supportsTransactionTimeout) {
                // Session-level, before Drizzle's BEGIN: a SET inside the
                // migration's own transaction would not change its limit.
                await client.query("SELECT set_config('transaction_timeout', $1, false)", [`${effectiveMs}ms`]);
              }
              const appliedBefore = await countAppliedMigrations(client);
              const startedAt = new Date();
              const t0 = process.hrtime.bigint();
              lastServerErrorCode = null;
              try {
                await migrateAndReport(phaseFolder);
              } catch (error) {
                if (
                  extractPgError(error).code === TRANSACTION_TIMEOUT_SQLSTATE
                  || lastServerErrorCode === TRANSACTION_TIMEOUT_SQLSTATE
                ) {
                  // PostgreSQL has closed this connection; nothing more may run
                  // on it. The journal row was not written, so the next run
                  // re-applies this migration from the start.
                  console.error(
                    `[MIGRATION_FAILED] reason=transaction_timeout migration=${sanitizeLogField(tag, 120)} ` +
                      `limit_ms=${effectiveMs} source=${timeout.source}`,
                  );
                }
                throw error;
              }
              const elapsedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
              // Phases already in the journal are no-ops for Drizzle; only time real work.
              if ((await countAppliedMigrations(client)) === appliedBefore) return;
              console.info(
                `[MIGRATION_FILE] migration=${sanitizeLogField(tag, 120)} started_at=${startedAt.toISOString()} ` +
                  `finished_at=${new Date().toISOString()} elapsed_ms=${elapsedMs} ` +
                  `transaction_timeout_ms=${effectiveMs} source=${timeout.source}`,
              );
            },
          );
          if (supportsTransactionTimeout) {
            await client.query("SELECT set_config('transaction_timeout', '0', false)");
          }
        }
      : async (opts: { migrationsFolder: string }) => migrateAndReport(opts.migrationsFolder);

    await runDeployMigrations(
      migrateFn,
      migrationsFolder,
      async () => {
        try {
          const res = await client.query(
            'SELECT count(*)::int AS applied FROM "drizzle"."__drizzle_migrations"',
          );
          return (res.rows[0]?.applied as number) ?? null;
        } catch (err) {
          // Fresh DB (journal table missing, 42P01) => 0 applied so first-run
          // tag resolution works; any other accounting failure => null =>
          // tag fail-closes to UNKNOWN.
          return classifyAppliedCountError(err);
        }
      },
    );
    console.log("[MIGRATION_DEPLOY_OK] all pending migrations applied");
  } catch {
    // The structured [MIGRATION_FAILED] line is already printed by
    // runDeployMigrations before rethrow.
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

void main();

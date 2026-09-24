// Deploy-path replacement for `drizzle-kit migrate` (runs after
// migration-preflight in `db:migrate:deploy`). Same locked drizzle-orm
// node-postgres migrator — same journal, same drizzle.__drizzle_migrations
// accounting — the only difference is failure-output ownership: see
// src/db/migrateDeploy.ts. DSN contract matches drizzle.config.ts (consume
// DATABASE_URL byte-for-byte; statement_timeout arrives via the operator DSN's
// `options=-c`, never injected here). MIGRATIONS_FOLDER overrides for tests.
// Output is deterministic plain text: no ANSI, no DSN/secret material.
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { classifyAppliedCountError, readJournalTags, runDeployMigrations } from "../src/db/migrateDeploy.js";
import {
  acquireMigrationAdvisoryLock,
  resolveMigrationPhaseConfig,
  runMigrationLockPreflight,
  runMigrationPhases,
} from "../src/db/migrationPhases.js";

const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

// One session-wide lease serializes migration tasks without touching schema or
// journal state. The try-lock is held across all canonical Drizzle phase calls
// and released when this client closes; a competing task fails closed.

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
  try {
    await client.connect();
    const db = drizzle(client);
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
          const tags = readJournalTags(migrationsFolder);
          const phaseConfig = resolveMigrationPhaseConfig(process.env, tags);
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
          const preflight = () =>
            runMigrationLockPreflight(
              (text, values) => client.query(text, values as unknown[]),
              phaseConfig.lockTimeoutMs,
              phaseConfig.lockSchema,
              phaseConfig.lockRelations,
            );
          await runMigrationPhases(
            migrationsFolder,
            phaseConfig.boundaryTags,
            (_phase, phaseFolder) => migrate(db, { migrationsFolder: phaseFolder }),
            preflight,
          );
        }
      : async (opts: { migrationsFolder: string }) => {
          const tags = readJournalTags(migrationsFolder);
          await migrate(db, opts);
        };

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

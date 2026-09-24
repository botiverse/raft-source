// Thin executable for the head-bound migration admission preflight. Runs before
// `drizzle-kit migrate` in the `db:migrate:deploy` script (the production deploy
// path). All logic + testable seams live in src/db/migrationPreflight.ts.
//
// Admits/rejects (exit 2) based on the exact's own migration manifest vs the db
// head and the effective statement_timeout — the frozen 5-tooth contract. Never
// prints the DSN. The plain `db:migrate` command is the no-guard path for
// local/dev/e2e. MIGRATIONS_FOLDER overrides the default folder (tests).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "../src/db/migrationPreflight.js";

const migrationsFolder =
  process.env.MIGRATIONS_FOLDER ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

runPreflight(process.env, migrationsFolder).catch((e) => {
  console.error(
    `[MIGRATION_PREFLIGHT_ABORT] FATAL ${e instanceof Error ? e.name : ""}`,
  );
  process.exit(2);
});

import "dotenv/config";
import { existsSync, readdirSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Each first-party app's Postgres schema, `app_<id>` (apps/<id>/schema.ts).
const appSchemas = readdirSync("./src/apps", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`./src/apps/${entry.name}/schema.ts`))
  .map((entry) => `app_${entry.name}`);

// The migration statement_timeout is delivered by the operator-provisioned
// migrator DSN's `options=-c statement_timeout=60000` libpq startup option on a
// direct/session endpoint (verified by scripts/migration-preflight.ts before
// `drizzle-kit migrate` runs), NOT injected onto the connection string here: a
// bare `?statement_timeout=` query parameter is silently dropped by the Neon
// PrivateLink pooler. Consume the raw DSN byte-for-byte.
export default defineConfig({
  // Core tables, then each first-party app's own Postgres schema (one file
  // per app, apps/<id>/schema.ts, so the app's tables stay inside its module
  // boundary; found by the glob, never listed here).
  schema: ["./src/db/schema.ts", "./src/apps/*/schema.ts"],
  // Which database schemas `drizzle-kit push`/`pull` manage: drizzle-kit's
  // default is `public` alone, which would leave the app schemas out.
  // Migrations (`generate`, `migrate`) don't read it.
  schemaFilter: ["public", ...appSchemas],
  out: "./drizzle",
  dialect: "postgresql",
  // change_log (incremental sync) is hand-written SQL migrations, not schema.ts:
  // keep `drizzle-kit push` from dropping it. Deployed databases and
  // `./raftdev start` build the schema from the migrations.
  tablesFilter: ["*", "!change_log*"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// The migration statement_timeout is delivered by the operator-provisioned
// migrator DSN's `options=-c statement_timeout=60000` libpq startup option on a
// direct/session endpoint (verified by scripts/migration-preflight.ts before
// `drizzle-kit migrate` runs), NOT injected onto the connection string here: a
// bare `?statement_timeout=` query parameter is silently dropped by the Neon
// PrivateLink pooler. Consume the raw DSN byte-for-byte.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

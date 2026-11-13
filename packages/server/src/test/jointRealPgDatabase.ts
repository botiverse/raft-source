// Shared by the joint real-PostgreSQL tests run by `test:joint-source-preview-real-pg`.
// JOINT_SOURCE_PREVIEW_REAL_PG_URL is an ADMIN url: each test creates a random
// database, migrates into it and drops it afterwards; the url's own database is
// never written. JOINT_SOURCE_PREVIEW_REAL_PG_REQUIRED=1 fails instead of skipping.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { attachPoolClientErrorHandler } from "../db/pgPoolErrorHandler";

export const JOINT_REAL_PG_URL_ENV = "JOINT_SOURCE_PREVIEW_REAL_PG_URL";
const adminUrl = process.env[JOINT_REAL_PG_URL_ENV];
const required = process.env.JOINT_SOURCE_PREVIEW_REAL_PG_REQUIRED === "1";

/** Skip only when neither the admin URL nor REQUIRED=1 is set. */
export const skipJointRealPg = !adminUrl && !required;

/** Runs `body` against a freshly created and migrated random database, dropped afterwards. */
export async function withJointRealPgDatabase(label: string, body: (databaseUrl: string) => Promise<void>): Promise<void> {
  assert.ok(adminUrl, `${JOINT_REAL_PG_URL_ENV} is required`);
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${JOINT_REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  const databaseName = `slock_${label}_${process.pid}_${randomBytes(4).toString("hex")}`;
  parsed.pathname = `/${databaseName}`;
  const databaseUrl = parsed.toString();
  const admin = new pg.Client({ connectionString: adminUrl, application_name: `${label}-admin` });
  admin.on("error", (err) => console.warn(`[${label}] admin client error`, err.message));
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    attachPoolClientErrorHandler(pool, `${label}-migrate`);
    try { await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); }
    finally { await pool.end(); }
    await body(databaseUrl);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

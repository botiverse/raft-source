import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(SERVER_DIR, "drizzle", "0106_pretty_fantastic_four.sql");

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE servers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      CREATE TABLE oauth_clients (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        client_id text NOT NULL UNIQUE,
        client_secret_hash text NOT NULL,
        app_type text DEFAULT 'server_local' NOT NULL,
        name text NOT NULL,
        description text,
        homepage_url text,
        return_url text,
        agent_manifest_url text,
        logo_url text,
        logo_storage_key text,
        created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
    await client.exec(`
      INSERT INTO users DEFAULT VALUES;
      INSERT INTO servers DEFAULT VALUES;
      INSERT INTO oauth_clients (
        server_id,
        client_id,
        client_secret_hash,
        app_type,
        name,
        created_by_user_id
      )
      SELECT
        servers.id,
        'existing-survey',
        'hash',
        'slock_builtin',
        'Existing Survey',
        users.id
      FROM servers CROSS JOIN users;
    `);

    const sqlText = await readFile(MIGRATION_PATH, "utf8");
    for (const statement of splitStatements(sqlText)) {
      await client.exec(statement);
    }

    const result = await client.query<{ enabled: boolean; publish_status: string }>(
      `SELECT enabled, publish_status FROM oauth_clients WHERE client_id = 'existing-survey'`,
    );
    const row = result.rows[0];
    if (!row || row.enabled !== true || row.publish_status !== "published") {
      console.error("✗ Existing slock_builtin OAuth clients were not backfilled to live published state.", row);
      process.exit(1);
    }
    console.log("✓ Existing slock_builtin OAuth clients remain live after app-admin migration.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("✗ App Admin migration backfill check failed:", err);
  process.exit(1);
});

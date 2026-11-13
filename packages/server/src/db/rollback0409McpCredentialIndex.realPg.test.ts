// Real-PostgreSQL contract for the 0409 rollback helper
// (scripts/rollback-0409-managed-mcp-credential-index.ts), on the REAL repo
// migrations. Pre-0409 binaries upsert credentials with
// `ON CONFLICT (mcp_server_id)`; after 0409 that statement has no arbiter
// (42P10). Proves: restore makes the old upsert work again; restore refuses
// (and changes nothing) while an App has several Connections; drop lets a
// 0409+ binary add a second Connection again.
//
// Own gate:
//   ROLLBACK_0409_REAL_PG_URL       admin DSN of a disposable PostgreSQL
//   ROLLBACK_0409_REAL_PG_REQUIRED  "1" in Hosted — missing URL then FAILS, no skip
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import {
  dropRollback0409Index,
  findAppsWithSeveralConnections,
  isRestoredIndex,
  readRollback0409IndexStatus,
  restoreRollback0409Index,
} from "../../scripts/rollback-0409-managed-mcp-credential-index";
import { runMigrationPhases } from "./migrationPhases";

const ADMIN_URL = process.env.ROLLBACK_0409_REAL_PG_URL;
const REQUIRED = process.env.ROLLBACK_0409_REAL_PG_REQUIRED === "1";
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

// The statement shape a pre-0409 binary sends (drizzle onConflictDoUpdate on mcpServerId).
const OLD_UPSERT = `
  INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, encrypted_headers)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (mcp_server_id) DO UPDATE
  SET encrypted_headers = EXCLUDED.encrypted_headers,
      credential_version = managed_mcp_credentials.credential_version + 1`;

test("0409 rollback helper: restore re-enables the pre-0409 upsert, refuses on several connections, drop re-enables connections", async (t) => {
  if (!ADMIN_URL) {
    if (REQUIRED) {
      throw new Error("ROLLBACK_0409_REAL_PG_REQUIRED=1 but ROLLBACK_0409_REAL_PG_URL is missing — this tooth must not silently skip in Hosted");
    }
    t.skip();
    return;
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `rollback_0409_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  t.onTestFinished(async () => {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await client.connect();

  const db = drizzle(client);
  await runMigrationPhases(MIGRATIONS, (_phase, folder) => migrate(db, { migrationsFolder: folder }));

  // Seed two Apps with one Connection each. FK targets (servers, managed_mcp_servers) are
  // irrelevant to the index, so FK triggers are off for this session. Unique indexes are not
  // triggers: 42P10 / 23505 below behave exactly as in production.
  const serverId = randomUUID();
  const appA = randomUUID();
  const appB = randomUUID();
  const credA = randomUUID();
  await client.query("SET session_replication_role = replica");
  await client.query(
    `INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id) VALUES ($1, $2, $3), ($4, $2, $5)`,
    [credA, serverId, appA, randomUUID(), appB],
  );

  // After 0409 the old upsert has no arbiter.
  assert.equal((await readRollback0409IndexStatus(client)).exists, false);
  await assert.rejects(
    client.query(OLD_UPSERT, [randomUUID(), serverId, appA, "v2"]),
    (error: { code?: string }) => error.code === "42P10",
  );

  // Restore: index is back, the old upsert updates the existing row instead of inserting.
  assert.deepEqual(await restoreRollback0409Index(client), { kind: "created" });
  assert.ok(isRestoredIndex(await readRollback0409IndexStatus(client)));
  await client.query(OLD_UPSERT, [randomUUID(), serverId, appA, "v2"]);
  const afterUpsert = await client.query(
    `SELECT id, encrypted_headers, credential_version FROM managed_mcp_credentials WHERE mcp_server_id = $1`,
    [appA],
  );
  assert.equal(afterUpsert.rows.length, 1);
  assert.equal(afterUpsert.rows[0].id, credA);
  assert.equal(afterUpsert.rows[0].encrypted_headers, "v2");
  assert.equal(afterUpsert.rows[0].credential_version, 2);
  assert.deepEqual(await restoreRollback0409Index(client), { kind: "already_present" });

  // While restored, a 0409+ binary cannot add a second Connection: drop must come before roll-forward.
  const secondConnection = `
    INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, is_server_default)
    VALUES ($1, $2, $3, false)`;
  await assert.rejects(
    client.query(secondConnection, [randomUUID(), serverId, appB]),
    (error: { code?: string }) => error.code === "23505",
  );
  assert.deepEqual(await dropRollback0409Index(client), { kind: "dropped" });
  assert.equal((await readRollback0409IndexStatus(client)).exists, false);
  await client.query(secondConnection, [randomUUID(), serverId, appB]);
  assert.deepEqual(await dropRollback0409Index(client), { kind: "absent" });

  // With several Connections on one App, restore refuses and changes nothing.
  const rowsBefore = (await client.query(`SELECT count(*)::int AS n FROM managed_mcp_credentials`)).rows[0].n;
  const refused = await restoreRollback0409Index(client);
  assert.equal(refused.kind, "refused_duplicates");
  assert.deepEqual(await findAppsWithSeveralConnections(client), [
    { mcpServerId: appB, connections: 2, defaults: 1 },
  ]);
  assert.equal((await readRollback0409IndexStatus(client)).exists, false);
  const rowsAfter = (await client.query(`SELECT count(*)::int AS n FROM managed_mcp_credentials`)).rows[0].n;
  assert.equal(rowsAfter, rowsBefore);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql, TransactionRollbackError } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "./index";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "./postMigrationIndexes";
import { DEVICE_SESSION_KEY_INDEXES } from "../../scripts/device-session-key-indexes";

// Migration device_session_issued_keys: the indexes behind the session-family
// columns a device login's revoke link follows (the revoke cascade's lookup and
// the ON DELETE SET NULL), built CONCURRENTLY on a large table.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the create script, the post-migration catalog and db:migrate:deploy describe the same indexes", async () => {
  for (const spec of DEVICE_SESSION_KEY_INDEXES) {
    assert.match(spec.createSql, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${spec.name}"`));
    assert.deepEqual(POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name), {
      name: spec.name,
      table: spec.table,
      columns: spec.columns,
      unique: spec.unique,
      predicate: spec.predicate,
      ...(spec.keys !== undefined ? { keys: spec.keys } : {}),
      createScript: "db:create-device-session-key-indexes",
    });
  }
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-device-session-key-indexes"]!, /scripts\/create-device-session-key-indexes\.ts$/);
  // Every deploy builds them after the migrations and before the guard checks them.
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-device-session-key-indexes.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});

test("on a migrated (small) database the migration built them, and the revoke cascade's lookup can use them", async ({ db: _db }) => {
  // The test database speaks drizzle, not pg.Pool: inline the one array parameter.
  const query = async (text: string, values?: unknown[]) => {
    const tables = (values?.[0] ?? []) as string[];
    const inlined = text.replace("$1::text[]", `ARRAY[${tables.map((table) => `'${table}'`).join(",")}]::text[]`);
    const result = await getDb().execute(sql.raw(inlined));
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const catalog = POST_MIGRATION_INDEXES.filter((entry) => DEVICE_SESSION_KEY_INDEXES.some((spec) => spec.name === entry.name));
  assert.equal(catalog.length, DEVICE_SESSION_KEY_INDEXES.length);
  for (const state of evaluatePostMigrationIndexes(await readObservedIndexes(query, catalog), catalog)) {
    assert.equal(state.state, "ok", `${state.spec.name} is built and valid`);
  }
  // A FK action runs `... WHERE <col> = $1`; with seq scans priced out, the plan must pick the index.
  const familyId = randomUUID();
  for (const spec of DEVICE_SESSION_KEY_INDEXES) {
    let text = "";
    await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
      // On these empty tables a live-only index on another column costs the
      // same as the right one, so the planner may pick it and filter. Drop
      // those in this transaction (rolled back below): a real table's
      // statistics price them out.
      for (const other of DEVICE_SESSION_KEY_INDEXES) {
        if (other.table === spec.table && other.columns[0] !== spec.columns[0]) {
          await tx.execute(sql.raw(`DROP INDEX "${other.name}"`));
        }
      }
      // A partial index serves lookups that carry its predicate (the live-only
      // keys, a person's user-created agents, ...); the revoked- and
      // expired-runner indexes serve the retention sweep's oldest-first reads.
      const partial = spec.predicate ? ` AND ${spec.predicate}` : "";
      const probe = spec.name === "idx_agent_credentials_revoked_computer"
        ? `EXPLAIN SELECT id FROM "agent_credentials" WHERE revoked_at IS NOT NULL AND issued_via = 'computer' AND revoked_at <= now() ORDER BY revoked_at LIMIT 500`
        : spec.name === "idx_agent_credentials_expired_computer"
          ? `EXPLAIN SELECT id FROM "agent_credentials" WHERE expires_at IS NOT NULL AND revoked_at IS NULL AND issued_via = 'computer' AND expires_at < now() ORDER BY expires_at LIMIT 500`
          // The board's activity sort: one channel's tasks in the index's order
          // (idx_tasks_channel_number also leads with channel_id, so a bare
          // equality probe could pick either).
          : spec.name === "idx_tasks_channel_activity"
            ? `EXPLAIN SELECT id FROM "tasks" WHERE channel_id = '${familyId}' ORDER BY COALESCE(last_activity_at, updated_at) DESC, id DESC LIMIT 51`
            : spec.name === "idx_tasks_channel_created"
              ? `EXPLAIN SELECT id FROM "tasks" WHERE channel_id = '${familyId}' ORDER BY created_at DESC, id DESC LIMIT 51`
              : `EXPLAIN SELECT 1 FROM "${spec.table}" WHERE "${spec.columns[0]}" = '${familyId}'${partial}`;
      const plan = await tx.execute(sql.raw(probe));
      text = plan.rows.map((row) => Object.values(row as Record<string, unknown>)[0]).join("\n");
      tx.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
    assert.match(text, new RegExp(spec.name), text);
  }
});

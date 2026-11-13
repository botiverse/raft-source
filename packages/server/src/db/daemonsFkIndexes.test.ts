import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "./index";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "./postMigrationIndexes";
import { DAEMONS_FK_INDEXES } from "../../scripts/daemons-fk-indexes";

// Migration daemons_fk_indexes (#triage:67b94880): the indexes behind the
// foreign keys a machine delete follows. Without them each FK action scanned
// its whole table and the delete hit the 15 s statement timeout on production.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the create script, the post-migration catalog and db:migrate:deploy describe the same indexes", async () => {
  for (const spec of DAEMONS_FK_INDEXES) {
    assert.match(spec.createSql, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${spec.name}"`));
    assert.deepEqual(POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name), {
      name: spec.name,
      table: spec.table,
      columns: spec.columns,
      unique: spec.unique,
      predicate: spec.predicate,
      createScript: "db:create-daemons-fk-indexes",
    });
  }
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-daemons-fk-indexes"]!, /scripts\/create-daemons-fk-indexes\.ts$/);
  // Every deploy builds them after the migrations and before the guard checks them.
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-daemons-fk-indexes.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});

test("on a migrated (small) database the migration built them, and the FK actions' lookup can use them", async ({ db: _db }) => {
  // The test database speaks drizzle, not pg.Pool: inline the one array parameter.
  const query = async (text: string, values?: unknown[]) => {
    const tables = (values?.[0] ?? []) as string[];
    const inlined = text.replace("$1::text[]", `ARRAY[${tables.map((table) => `'${table}'`).join(",")}]::text[]`);
    const result = await getDb().execute(sql.raw(inlined));
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const catalog = POST_MIGRATION_INDEXES.filter((entry) => DAEMONS_FK_INDEXES.some((spec) => spec.name === entry.name));
  assert.equal(catalog.length, DAEMONS_FK_INDEXES.length);
  for (const state of evaluatePostMigrationIndexes(await readObservedIndexes(query, catalog), catalog)) {
    assert.equal(state.state, "ok", `${state.spec.name} is built and valid`);
  }
  // A FK action runs `... WHERE <col> = $1`; with seq scans priced out, the plan must pick the index.
  const machineId = randomUUID();
  for (const spec of DAEMONS_FK_INDEXES) {
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));
      const plan = await tx.execute(sql.raw(`EXPLAIN SELECT 1 FROM "${spec.table}" WHERE "${spec.columns[0]}" = '${machineId}'`));
      return plan.rows.map((row) => Object.values(row as Record<string, unknown>)[0]).join("\n");
    });
    assert.match(text, new RegExp(spec.name), text);
  }
});

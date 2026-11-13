import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "./index";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "./postMigrationIndexes";
import { READ_CURSOR_MARKED_UNREAD_INDEX } from "../../scripts/read-cursor-marked-unread-index";

// Migration read_cursor_marked_unread_index: a person's conversations marked
// unread, read on every sidebar summary and Activity load. Built inline only on
// a small table; db:migrate:deploy builds it CONCURRENTLY on a large one.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spec = READ_CURSOR_MARKED_UNREAD_INDEX;

test("the create script, the post-migration catalog and db:migrate:deploy describe the same index", async () => {
  assert.match(spec.createSql, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${spec.name}"`));
  assert.deepEqual(POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name), {
    name: spec.name,
    table: spec.table,
    columns: spec.columns,
    unique: spec.unique,
    predicate: spec.predicate,
    createScript: "db:create-read-cursor-marked-unread-index",
  });
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-read-cursor-marked-unread-index"]!, /scripts\/create-read-cursor-marked-unread-index\.ts$/);
  // Every deploy builds it after the migrations and before the guard checks it.
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-read-cursor-marked-unread-index.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});

test("on a migrated (small) database the migration built it, valid and ready", async ({ db: _db }) => {
  // The test database speaks drizzle, not pg.Pool: inline the one array parameter.
  const query = async (text: string, values?: unknown[]) => {
    const tables = (values?.[0] ?? []) as string[];
    const inlined = text.replace("$1::text[]", `ARRAY[${tables.map((table) => `'${table}'`).join(",")}]::text[]`);
    const result = await getDb().execute(sql.raw(inlined));
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const catalog = POST_MIGRATION_INDEXES.filter((entry) => entry.name === spec.name);
  assert.equal(catalog.length, 1);
  for (const state of evaluatePostMigrationIndexes(await readObservedIndexes(query, catalog), catalog)) {
    assert.equal(state.state, "ok", `${state.spec.name} is built and valid`);
  }
});

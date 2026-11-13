import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { test } from "vitest";

import * as coreSchema from "../../db/schema";
import { accountDeletionCleanupSteps } from "./cleanup";
import { USER_FOREIGN_KEY_CLASSIFICATION, type UserForeignKeyClassification } from "./tableClassification";

// The contract that makes every future foreign key to users.id get a
// decision (design "删除账号：服务端设计 v2" §7.1): the classification lists
// exactly the schema's keys, each with the schema's ON DELETE.

const appsDir = fileURLToPath(new URL("../../apps", import.meta.url));

async function schemaModules(): Promise<Array<Record<string, unknown>>> {
  const modules: Array<Record<string, unknown>> = [coreSchema];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    const file = join(appsDir, entry.name, "schema.ts");
    if (entry.isDirectory() && existsSync(file)) modules.push(await import(file) as Record<string, unknown>);
  }
  return modules;
}

async function userForeignKeys(): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const module of await schemaModules()) {
    for (const value of Object.values(module)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      for (const fk of config.foreignKeys) {
        const reference = fk.reference();
        const target = getTableConfig(reference.foreignTable);
        if (target.name !== "users" || (target.schema ?? "public") !== "public") continue;
        assert.deepEqual(reference.foreignColumns.map((column) => column.name), ["id"], `${config.name}: a key to users other than users.id`);
        assert.equal(reference.columns.length, 1, `${config.name}: a composite key to users.id`);
        const key = `${config.schema ? `${config.schema}.` : ""}${config.name}.${reference.columns[0]!.name}`;
        const onDelete = fk.onDelete ?? "no action";
        const previous = keys.get(key);
        assert.ok(previous === undefined || previous === onDelete, `${key}: two foreign keys with different ON DELETE`);
        keys.set(key, onDelete);
      }
    }
  }
  return keys;
}

test("every foreign key to users.id is classified, with the schema's ON DELETE", async () => {
  const schemaKeys = await userForeignKeys();
  const classified = USER_FOREIGN_KEY_CLASSIFICATION as Record<string, UserForeignKeyClassification>;
  const unclassified = [...schemaKeys.keys()].filter((key) => !(key in classified)).sort();
  assert.deepEqual(unclassified, [], "classify these in services/accountDeletion/tableClassification.ts: delete, keep (with an action if something stays live) or n/a");
  const stale = Object.keys(classified).filter((key) => !schemaKeys.has(key)).sort();
  assert.deepEqual(stale, [], "these classified keys are no longer in the schema");
  const mismatched = [...schemaKeys].filter(([key, onDelete]) => classified[key]!.onDelete !== onDelete).map(([key, onDelete]) => `${key}: schema ${onDelete}, classified ${classified[key]!.onDelete}`);
  assert.deepEqual(mismatched, []);
  // A cascade is the only kind that would have deleted the row: it needs a decision. The others only record who acted.
  for (const [key, classification] of Object.entries(classified)) {
    if (classification.onDelete === "cascade") assert.ok(classification.cleanup === "delete" || classification.cleanup === "keep", key);
    else assert.equal(classification.cleanup, "n/a", key);
  }
});

test("the cleanup has a step for every table it deletes from and every keep action", () => {
  const steps = new Set(accountDeletionCleanupSteps().map((step) => step.name));
  for (const [key, classification] of Object.entries(USER_FOREIGN_KEY_CLASSIFICATION) as Array<[string, UserForeignKeyClassification]>) {
    if (classification.cleanup === "delete") assert.ok(steps.has(key), key);
    if ("action" in classification && classification.action) assert.ok(steps.has(classification.action), `${key}: ${classification.action}`);
  }
  // session_families goes last.
  assert.equal(accountDeletionCleanupSteps().at(-1)?.name, "session_families.user_id");
});

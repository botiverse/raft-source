import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("operator authorization has no source or environment bootstrap roster", () => {
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /FEATURE_FLAG_OPERATOR_PRINCIPAL_IDS/);
  assert.doesNotMatch(worker, /FEATURE_FLAG_OPERATOR_PRINCIPAL_IDS/);
  assert.doesNotMatch(worker, /operatorPrincipalIds/);
  assert.match(worker, /hasPersistentRole\(env, session\.principal\.sub, "admin"\)/);
});

test("role migration creates generic audited storage and bootstraps no principal", () => {
  const migration = readFileSync(new URL("../migrations/0002_admin_role_grants.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS feature_flag_admin_role_grants/);
  assert.match(migration, /role IN \('admin', 'announcement_publisher'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS feature_flag_admin_role_audit_events/);
  assert.doesNotMatch(migration, /INSERT INTO feature_flag_admin_role_grants/);
  assert.doesNotMatch(migration, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

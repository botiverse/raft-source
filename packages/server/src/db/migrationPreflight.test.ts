import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePreflightConfig,
  classifyAdmission,
  evaluateEffectiveTimeout,
  pgSqlState,
  type ManifestEntry,
} from "./migrationPreflight.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(serverRoot, "scripts", "migration-preflight.ts");

const h = (c: string) => c.repeat(64); // a valid 64-char lowercase-hex hash
const MANIFEST: ManifestEntry[] = [
  { hash: h("a"), folderMillis: 1000 },
  { hash: h("b"), folderMillis: 2000 },
  { hash: h("c"), folderMillis: 3000 }, // target
];
const REQUIRED = 60000;

// ---- resolvePreflightConfig (fail-closed, DB-free) ----

test("resolvePreflightConfig: missing DATABASE_URL / timeout / invalid fail closed", () => {
  assert.equal((resolvePreflightConfig({}) as { code?: string }).code, "MISSING_DATABASE_URL");
  assert.equal((resolvePreflightConfig({ DATABASE_URL: "postgres://u:p@h/d" }) as { code?: string }).code, "MISSING_TIMEOUT");
  for (const bad of ["0", "999", "abc", "60000.5", "3600001", "-1"]) {
    assert.equal((resolvePreflightConfig({ DATABASE_URL: "postgres://u:p@h/d", SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: bad }) as { code?: string }).code, "INVALID_TIMEOUT", bad);
  }
});

test("resolvePreflightConfig: valid keeps RAW url + numeric requiredMs (no injection)", () => {
  const raw = "postgres://u:p@h/d?sslmode=require";
  const r = resolvePreflightConfig({ DATABASE_URL: raw, SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" }) as { connectionString: string; requiredMs: number };
  assert.equal(r.connectionString, raw);
  assert.doesNotMatch(r.connectionString, /statement_timeout/);
  assert.equal(r.requiredMs, 60000);
});

// ---- classifyAdmission: the frozen 5-tooth contract (pure) ----

test("tooth 1: head==target + 15s -> ADMIT no-op (timeout moot at target)", () => {
  const v = classifyAdmission(MANIFEST, { hash: h("c"), createdAt: 3000 }, "15000", REQUIRED);
  assert.equal(v.admit, true);
  assert.equal(v.code, "AT_TARGET_NOOP");
  // created_at may arrive as a bigint string from pg — still matches
  assert.equal(classifyAdmission(MANIFEST, { hash: h("c"), createdAt: "3000" }, "15000", REQUIRED).admit, true);
});

test("tooth 2: behind + 15s -> REJECT (real migration under wrong timeout)", () => {
  const v = classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "15000", REQUIRED);
  assert.equal(v.admit, false);
  assert.equal(v.code, "EFFECTIVE_MISMATCH");
  assert.match(v.detail!, /expected=60000 actual=15000/);
});

test("tooth 3: behind + 60s -> ADMIT (canonical migrate up to target)", () => {
  const v = classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "60000", REQUIRED);
  assert.equal(v.admit, true);
  assert.equal(v.code, "BEHIND_MIGRATE");
});

test("tooth 3 (fresh db): dbHead null is behind — 60s admits, 15s rejects", () => {
  assert.equal(classifyAdmission(MANIFEST, null, "60000", REQUIRED).admit, true);
  assert.equal(classifyAdmission(MANIFEST, null, "15000", REQUIRED).code, "EFFECTIVE_MISMATCH");
});

test("tooth 4: ahead / diverged / malformed / empty -> REJECT", () => {
  // ahead: unknown hash, created_at beyond target
  assert.equal(classifyAdmission(MANIFEST, { hash: h("f"), createdAt: 4000 }, "60000", REQUIRED).code, "HEAD_AHEAD");
  // diverged: unknown hash, created_at within range
  assert.equal(classifyAdmission(MANIFEST, { hash: h("f"), createdAt: 2500 }, "60000", REQUIRED).code, "HEAD_DIVERGED");
  // diverged by created_at: known hash but created_at not its folderMillis (binds BOTH)
  assert.equal(classifyAdmission(MANIFEST, { hash: h("b"), createdAt: 2500 }, "60000", REQUIRED).code, "HEAD_DIVERGED");
  // malformed head
  assert.equal(classifyAdmission(MANIFEST, { hash: "not-hex", createdAt: 1000 }, "60000", REQUIRED).code, "HEAD_MALFORMED");
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: "abc" }, "60000", REQUIRED).code, "HEAD_MALFORMED");
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1.5 }, "60000", REQUIRED).code, "HEAD_MALFORMED");
  // empty manifest
  assert.equal(classifyAdmission([], null, "60000", REQUIRED).code, "MANIFEST_EMPTY");
});

test("behind + effective missing/non-numeric -> REJECT (fail closed)", () => {
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, null, REQUIRED).code, "EFFECTIVE_MISSING");
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "1min", REQUIRED).code, "EFFECTIVE_NON_NUMERIC");
});

test("evaluateEffectiveTimeout + pgSqlState seams", () => {
  assert.equal(evaluateEffectiveTimeout("60000", 60000).ok, true);
  assert.equal(evaluateEffectiveTimeout("15000", 60000).code, "EFFECTIVE_MISMATCH");
  assert.equal(pgSqlState({ code: "42P01" }), "42P01");
  assert.equal(pgSqlState({ cause: { code: "3F000" } }), "3F000");
  assert.equal(pgSqlState(new Error("x")), undefined);
});

// ---- Subprocess fail-closed + secret-negative (spawn the entrypoint) ----

function runScript(overrides: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DATABASE_URL;
  delete env.SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath], { cwd: serverRoot, env, encoding: "utf8" });
}

test("subprocess: missing DATABASE_URL -> exit 2, MISSING_DATABASE_URL", () => {
  const r = runScript({ SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_ABORT\] MISSING_DATABASE_URL/);
});

test("subprocess: missing/invalid timeout -> exit 2, no DSN leak", () => {
  let r = runScript({ DATABASE_URL: "postgres://u:secret@h/d" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /MISSING_TIMEOUT/);
  assert.doesNotMatch(r.stderr, /secret/);
  r = runScript({ DATABASE_URL: "postgres://u:secret@h/d", SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "nope" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /INVALID_TIMEOUT/);
  assert.doesNotMatch(r.stderr, /secret/);
});

test("subprocess (tooth 5): connection error -> exit 2, no DSN/credential leak", () => {
  const r = runScript({
    DATABASE_URL: "postgres://leakuser:leakpass@127.0.0.1:1/leakdb",
    SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_ABORT\] CONNECTION_OR_QUERY_ERROR/);
  const combined = r.stderr + r.stdout;
  for (const s of ["leakuser", "leakpass", "leakdb", "127.0.0.1", "postgres://"]) {
    assert.doesNotMatch(combined, new RegExp(s), `must not leak "${s}"`);
  }
});

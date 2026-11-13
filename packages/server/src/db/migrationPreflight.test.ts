import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePreflightConfig,
  classifyAdmission,
  pgSqlState,
  readManifest,
  type ManifestEntry,
} from "./migrationPreflight";

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

test("resolvePreflightConfig: the pre-rename timeout name is refused, never read as a fallback", () => {
  // A stale deploy config still setting the old name would look effective while
  // delivering nothing; it aborts even when the new name is set beside it.
  for (const env of [
    { DATABASE_URL: "postgres://u:p@h/d", SERVER_MIGRATION_STATEMENT_TIMEOUT_MS: "60000" },
    { DATABASE_URL: "postgres://u:p@h/d", SERVER_MIGRATION_STATEMENT_TIMEOUT_MS: "60000", SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000" },
  ]) {
    const r = resolvePreflightConfig(env);
    assert.equal(r.kind, "abort");
    assert.equal((r as { code: string }).code, "DEPRECATED_TIMEOUT_ENV");
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

test("behind at any effective timeout -> ADMIT (the timeout is no longer a gate)", () => {
  // The effective-timeout equality check was removed on the owner's instruction.
  // The timeout is still requested by the migration DSN, but a value that
  // differs from the pinned expectation no longer blocks the release.
  for (const eff of ["15000", "60000", "1", null]) {
    const v = classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, eff, REQUIRED);
    assert.equal(v.admit, true, `effective=${eff} must admit`);
    assert.equal(v.code, "BEHIND_MIGRATE");
  }
});

test("tooth 3: behind + 60s -> ADMIT (canonical migrate up to target)", () => {
  const v = classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "60000", REQUIRED);
  assert.equal(v.admit, true);
  assert.equal(v.code, "BEHIND_MIGRATE");
});

test("tooth 3 (fresh db): dbHead null is behind — admits regardless of effective timeout", () => {
  assert.equal(classifyAdmission(MANIFEST, null, "60000", REQUIRED).admit, true);
  assert.equal(classifyAdmission(MANIFEST, null, "15000", REQUIRED).code, "BEHIND_MIGRATE");
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

test("behind + effective missing/non-numeric -> still ADMIT (timeout is informational now)", () => {
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, null, REQUIRED).code, "BEHIND_MIGRATE");
  assert.equal(classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "1min", REQUIRED).code, "BEHIND_MIGRATE");
});

// ---- behind, with a pending entry drizzle would skip (PENDING_NOT_NEWER_THAN_HEAD) ----
// drizzle's migrator applies an entry only when folderMillis > the db head's
// created_at. A late-merged migration generated before the head would be skipped
// silently while the deploy reports success, so the preflight refuses it.

test("behind with a late entry older than the head -> REJECT naming it", () => {
  const manifest: ManifestEntry[] = [
    { hash: h("a"), folderMillis: 1000, tag: "0001_a" },
    { hash: h("b"), folderMillis: 3000, tag: "0002_b" }, // db head
    { hash: h("c"), folderMillis: 2000, tag: "0003_generated_earlier" }, // would be skipped
    { hash: h("d"), folderMillis: 4000, tag: "0004_d" },
  ];
  const v = classifyAdmission(manifest, { hash: h("b"), createdAt: "3000" }, "60000", REQUIRED);
  assert.equal(v.admit, false);
  assert.equal(v.code, "PENDING_NOT_NEWER_THAN_HEAD");
  assert.match(v.detail ?? "", /pending=0003_generated_earlier head_created_at=3000/);
  assert.doesNotMatch(v.detail ?? "", /0004_d/);
});

test("behind with a pending entry at exactly the head's created_at -> REJECT (drizzle needs strictly newer)", () => {
  const manifest: ManifestEntry[] = [
    { hash: h("a"), folderMillis: 1000 },
    { hash: h("b"), folderMillis: 1000 },
  ];
  const v = classifyAdmission(manifest, { hash: h("a"), createdAt: 1000 }, "60000", REQUIRED);
  assert.equal(v.code, "PENDING_NOT_NEWER_THAN_HEAD");
  assert.match(v.detail ?? "", new RegExp(`pending=${h("b").slice(0, 12)}`));
});

test("behind with every pending entry newer than the head -> still ADMIT", () => {
  const v = classifyAdmission(MANIFEST, { hash: h("a"), createdAt: 1000 }, "60000", REQUIRED);
  assert.equal(v.code, "BEHIND_MIGRATE");
});

test("fresh db applies every entry regardless of order -> ADMIT", () => {
  const manifest: ManifestEntry[] = [
    { hash: h("a"), folderMillis: 3000 },
    { hash: h("b"), folderMillis: 2000 },
  ];
  assert.equal(classifyAdmission(manifest, null, "60000", REQUIRED).code, "BEHIND_MIGRATE");
});

test("the repository journal's timestamps strictly increase, so no deploy can hit PENDING_NOT_NEWER_THAN_HEAD", () => {
  const manifest = readManifest(path.join(serverRoot, "drizzle"));
  for (let i = 1; i < manifest.length; i++) {
    assert.ok(
      manifest[i].folderMillis > manifest[i - 1].folderMillis,
      `${manifest[i].tag} (when=${manifest[i].folderMillis}) is not newer than ${manifest[i - 1].tag} ` +
        `(when=${manifest[i - 1].folderMillis}); regenerate it so its journal "when" is the latest`,
    );
  }
  assert.ok(manifest.every((m) => typeof m.tag === "string" && /^[0-9]{4}_/.test(m.tag)), "readManifest attaches journal tags");
});

test("pgSqlState seam", () => {
  assert.equal(pgSqlState({ code: "42P01" }), "42P01");
  assert.equal(pgSqlState({ cause: { code: "3F000" } }), "3F000");
  assert.equal(pgSqlState(new Error("x")), undefined);
});

// ---- Subprocess fail-closed + secret-negative (spawn the entrypoint) ----

function runScript(overrides: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DATABASE_URL;
  delete env.SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS;
  delete env.SERVER_MIGRATION_STATEMENT_TIMEOUT_MS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, ["--import", "@oxc-node/core/register", scriptPath], { cwd: serverRoot, env, encoding: "utf8" });
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

test("subprocess: the pre-rename timeout name -> exit 2, DEPRECATED_TIMEOUT_ENV, no DSN leak", () => {
  const r = runScript({
    DATABASE_URL: "postgres://u:secret@h/d",
    SERVER_MIGRATION_STATEMENT_TIMEOUT_MS: "60000",
    SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS: "60000",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[MIGRATION_PREFLIGHT_ABORT\] DEPRECATED_TIMEOUT_ENV/);
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

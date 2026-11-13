// Per-migration transaction timeout resolution (migrationPhases.ts). The real
// PostgreSQL behaviour it relies on is proven in
// migrationTransactionTimeout.realPg.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS,
  MIGRATION_TRANSACTION_TIMEOUT_FROM,
  migrationNumber,
  parseTransactionTimeoutDeclaration,
  resolveMigrationTransactionTimeout,
} from "./migrationPhases";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
const before = `${String(MIGRATION_TRANSACTION_TIMEOUT_FROM - 1).padStart(4, "0")}_old`;
const at = `${String(MIGRATION_TRANSACTION_TIMEOUT_FROM).padStart(4, "0")}_new`;

test("migrations before the cutoff run with no transaction timeout", () => {
  assert.deepEqual(resolveMigrationTransactionTimeout(before, "SELECT 1;"), { ms: null, source: "before-cutoff" });
  // Even a declaration does not apply to a pre-cutoff migration: history replays unchanged.
  assert.deepEqual(
    resolveMigrationTransactionTimeout(before, "-- migration: transaction_timeout=5s\nSELECT 1;"),
    { ms: null, source: "before-cutoff" },
  );
});

test("the cutoff migration and later ones default to 30 seconds", () => {
  assert.equal(DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS, 30_000);
  assert.deepEqual(resolveMigrationTransactionTimeout(at, "SELECT 1;"), { ms: 30_000, source: "default" });
});

test("a declaration in the leading comment block sets the limit", () => {
  const sql = "-- Backfill.\n-- migration: transaction_timeout=15min\n\nUPDATE t SET x = 1;";
  assert.deepEqual(resolveMigrationTransactionTimeout(at, sql), { ms: 900_000, source: "declared" });
  for (const [raw, ms] of [["250ms", 250], ["45s", 45_000], ["2h", 7_200_000]] as const) {
    assert.deepEqual(parseTransactionTimeoutDeclaration(`-- migration: transaction_timeout=${raw}\nSELECT 1;`), { kind: "declared", ms });
  }
});

test("a declaration after the first statement is not read", () => {
  const sql = "SELECT 1;\n-- migration: transaction_timeout=15min\n";
  assert.deepEqual(parseTransactionTimeoutDeclaration(sql), { kind: "none" });
  assert.deepEqual(resolveMigrationTransactionTimeout(at, sql), { ms: 30_000, source: "default" });
});

test("a malformed declaration falls back to the default, never to a longer limit", () => {
  for (const line of [
    "-- migration: transaction_timeout=15 minutes",
    "-- migration: transaction_timeout=0s",
    "-- migration: transaction_timeout=",
    "-- migration: transaction_timout=15min",
    "-- migration: transaction_timeout=7h",
    "-- migration: transaction_timeout=1min\n-- migration: transaction_timeout=2min",
  ]) {
    assert.equal(parseTransactionTimeoutDeclaration(`${line}\nSELECT 1;`).kind, "malformed", line);
    assert.deepEqual(resolveMigrationTransactionTimeout(at, `${line}\nSELECT 1;`), { ms: 30_000, source: "malformed-declaration" }, line);
  }
});

test("a tag without a number prefix gets the default, not the pre-cutoff exemption", () => {
  assert.deepEqual(resolveMigrationTransactionTimeout("misnamed_migration", "SELECT 1;"), {
    ms: DEFAULT_MIGRATION_TRANSACTION_TIMEOUT_MS,
    source: "default",
  });
});

test("migrationNumber reads the journal tag prefix", () => {
  assert.equal(migrationNumber("0611_foo"), 611);
  assert.equal(migrationNumber("1000_bar"), 1000);
  assert.equal(migrationNumber("foo"), null);
});

test("no migration at or after the cutoff has a malformed transaction_timeout declaration", () => {
  // The cutoff is fixed in source when this lands; anything at or above it was
  // written knowing about the 30 s default. If this fails, a migration was
  // renumbered across the cutoff: check it fits in 30 s or declares a limit.
  const tags = readdirSync(drizzleDir).filter((f) => /^[0-9]{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, -4));
  const atOrAfter = tags.filter((tag) => (migrationNumber(tag) ?? 0) >= MIGRATION_TRANSACTION_TIMEOUT_FROM);
  for (const tag of atOrAfter) {
    const timeout = resolveMigrationTransactionTimeout(tag, readFileSync(path.join(drizzleDir, `${tag}.sql`), "utf8"));
    assert.notEqual(timeout.source, "malformed-declaration", `${tag} has a malformed transaction_timeout declaration`);
  }
});

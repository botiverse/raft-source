/**
 * Static contract tooth: the migration statement_timeout is DELIVERED by the
 * operator-provisioned migration DSN's `options=-c statement_timeout=` libpq
 * startup option (on a dedicated direct/session endpoint), consumed BYTE-FOR-BYTE
 * — no code injects, rewrites, or mutates the DSN. The env var only DECLARES the
 * expected value the preflight reads back.
 *
 * Why this exists, and why NOT role-level. #5392 delivered the timeout by
 * injecting it onto the migration DSN (`withMigrationStatementTimeout`); #5474
 * removed that because a bare `?statement_timeout=` is silently dropped by the
 * Neon PrivateLink pooler, so the injection never took effect. The intended
 * follow-up was a role-level default, but the DB proved that unbuildable: the
 * only role that could carry a role-level `statement_timeout` is `neondb_owner`
 * (the object-owning DDL authority), and it cannot be granted to a new role
 * without the unreachable `cloud_admin` (proven closed on a disposable CoW
 * branch). So delivery is an operator-provisioned dedicated direct/session DSN
 * that REUSES the neondb_owner credential and carries `options=-c` — honored on
 * the direct endpoint, unlike the pooler-dropped bare query param. DB-role
 * isolation is intentionally absent; ECS task-def / SSM / IAM isolation remains.
 *
 * The failure this guards against is a stale NAME/CODE/COMMENT claiming a
 * delivery mechanism that is not the real one (role-level, or code injection) —
 * a reviewer reading `'60000'` and concluding staging is safe when nothing is
 * delivering 60s. These are source reads: the runtime proof that a fresh
 * connection really reads 60000 lives in `migrationPreflight.realPg.test.ts`,
 * and a genuine staging ADMIT is only provable by an exact-bound deploy after
 * the operator provisions the DSN. Not simulated here.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(serverRoot, "..", "..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(repoRoot, "RELEASE_SOURCE"));

const read = (p: string) => readFileSync(p, "utf8");

/**
 * Strip comments so a rule can assert about CODE without tripping over prose
 * that legitimately names the thing being forbidden. `drizzle.config.ts`
 * documents *why* `?statement_timeout=` was removed, and an assertion that
 * matched raw text flagged that explanation as a violation.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const DRIZZLE_CONFIG = path.join(serverRoot, "drizzle.config.ts");
const RUNNER = path.join(repoRoot, "scripts", "deploy", "aws-run-server-migrations.sh");
const PREFLIGHT = path.join(serverRoot, "src", "db", "migrationPreflight.ts");
const FLOOR_GATE = path.join(repoRoot, "scripts", "ci", "migration-floor-gate.sh");
const REAL_PG_TEST = path.join(serverRoot, "src", "db", "migrationPreflight.realPg.test.ts");

const EXPECTED_ENV = "SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS";
const LEGACY_ENV = "SERVER_MIGRATION_STATEMENT_TIMEOUT_MS";

test("drizzle.config.ts does not inject the timeout onto the migration DSN", () => {
  const src = codeOnly(read(DRIZZLE_CONFIG));

  assert.ok(
    !src.includes("withMigrationStatementTimeout"),
    "the removed URL-injection helper must not come back — it never survived the pooler",
  );
  assert.ok(
    !/searchParams|URLSearchParams|\?statement_timeout|&statement_timeout/.test(src),
    "no query-parameter timeout may be appended to the migration connection string",
  );
  assert.ok(
    /url:\s*process\.env\.DATABASE_URL/.test(src),
    "the migration connection string must stay the raw DATABASE_URL",
  );
});

test.skipIf(inSourceSnapshot)("the deploy runner states operator-DSN delivery, not role-level or code injection", () => {
  const src = read(RUNNER);

  // The precise false claim this tooth was written for: our code injecting the
  // timeout onto the connection URL. It never survived the pooler; nothing
  // injects now.
  assert.ok(
    !/adds it to that task's connection URL/.test(src),
    "the stale comment claiming drizzle.config.ts injects the timeout onto the connection URL is back",
  );
  // The truthful delivery mechanism: the operator-provisioned DSN carries
  // `options=-c` on the direct/session endpoint.
  assert.ok(
    /DELIVERED by the operator-provisioned migration DSN/.test(src) && /options=-c/.test(src),
    "the runner must state the operator-provisioned DSN's options=-c delivers the timeout",
  );
  // ...and the secret is consumed byte-for-byte, no runtime rewrite.
  assert.ok(
    /consumed BYTE-FOR-BYTE/.test(src),
    "the runner must state the DSN secret is consumed byte-for-byte (no runtime rewrite/injection)",
  );
});

test.skipIf(inSourceSnapshot)("no stale role-level/server-default delivery claim survives on any migration surface", () => {
  // Delivery is the operator DSN's options=-c, NOT a role-level or server-side
  // default (the DB proved a dedicated role with a role-level default
  // unbuildable — see this file's header). A comment or error still asserting
  // role-level/server-default DELIVERY is the exact NAME/CODE/COMMENT drift this
  // contract exists to catch. Scans every surface that documents the mechanism,
  // not just the runner/preflight — that narrow scan is how three stale claims
  // (drizzle.config, the floor gate, the real-PG proof) initially slipped through.
  const surfaces = [
    ["runner", RUNNER],
    ["preflight", PREFLIGHT],
    ["drizzle.config.ts", DRIZZLE_CONFIG],
    ["floor gate", FLOOR_GATE],
    ["real-PG proof", REAL_PG_TEST],
  ] as const;
  for (const [label, p] of surfaces) {
    const src = read(p);
    assert.ok(
      !/(role-level|server-side)[^.\n]*\b(deliver|delivers|delivered|DELIVERS)\b/i.test(src),
      `${label} still claims role-level/server-side timeout delivery; the real mechanism is the operator DSN's options=-c`,
    );
  }
});

test("no runtime DSN mutation: the migration connection string is consumed raw", () => {
  // The timeout rides on the operator-provisioned secret and is consumed
  // byte-for-byte. Any code that injects/appends/rewrites the DSN at runtime is
  // forbidden — the withMigrationStatementTimeout class (dropped by the pooler)
  // and any successor that silently re-mutates the URL. Checked comment-stripped
  // so the prose explaining *why* `?statement_timeout=` was removed is allowed.
  for (const [label, p] of [["drizzle.config.ts", DRIZZLE_CONFIG], ["preflight", PREFLIGHT]] as const) {
    const src = codeOnly(read(p));
    assert.ok(
      !/withMigrationStatementTimeout/.test(src),
      `${label} must not reintroduce the removed URL-injection helper`,
    );
    assert.ok(
      !/\?statement_timeout|&statement_timeout|searchParams|URLSearchParams/.test(src),
      `${label} must not append a statement_timeout query param or otherwise rewrite the DSN`,
    );
  }
});

test("the preflight reads the expected value back rather than applying it", () => {
  const src = read(PREFLIGHT);

  assert.ok(
    src.includes(`env.${EXPECTED_ENV}`),
    `the preflight must read ${EXPECTED_ENV}`,
  );
  // It compares pg_settings on a fresh connection; it must never SET anything.
  assert.ok(
    /pg_settings WHERE name = 'statement_timeout'/.test(src),
    "the preflight must read the effective statement_timeout from pg_settings",
  );
  assert.ok(
    !/SET\s+(LOCAL\s+)?statement_timeout|set_config\(\s*'statement_timeout'/i.test(src),
    "the preflight must never apply a timeout — it only asserts the delivered one",
  );
});

test("the legacy env name is refused outright, never read as a fallback", () => {
  const src = read(PREFLIGHT);

  assert.ok(
    src.includes("DEPRECATED_TIMEOUT_ENV"),
    "the preflight must fail closed on the pre-rename env name",
  );
  // A dual-read would let a stale config keep looking effective while
  // delivering nothing — the exact failure this preflight exists to catch.
  assert.ok(
    !new RegExp(`env\\.${LEGACY_ENV}\\s*(\\?\\?|\\|\\|)`).test(src),
    "the legacy env name must not be accepted as a fallback value",
  );
  assert.ok(
    !new RegExp(`${LEGACY_ENV}\\?\\.trim\\(\\)`).test(src),
    "the legacy env name must not be parsed as a timeout value",
  );
});

test.skipIf(inSourceSnapshot)("the pre-rename name survives nowhere but the guard that refuses it", () => {
  // Catches the class this change is about: a stale name left behind in prose
  // or config while the mechanism moved on. A closed set of policy-guard/test
  // surfaces may legitimately contain the legacy name:
  //   - the preflight's own deprecation guard (refuses it), and this tooth;
  //   - the staging floor gate (#5491) and its fixtures, which deliberately
  //     read the declared floor under EITHER env name across the rename
  //     boundary (see the load-bearing assertion below).
  // This is NOT a shipped workflow/runtime fallback: the "legacy refused
  // outright" and "no shipped config sets legacy" teeth keep deploy config and
  // runtime code clean, so the only legacy references left are these guards.
  const allowed = new Set([
    "packages/server/src/db/migrationPreflight.ts",
    "packages/server/src/db/migrationTimeoutContract.test.ts",
    "scripts/ci/migration-floor-gate.sh",
    "scripts/ci/migration-floor-gate.test.sh",
  ]);
  const hits = execFileSync("git", ["grep", "-l", LEGACY_ENV], { cwd: repoRoot, encoding: "utf8" })
    .split("\n").filter(Boolean).filter((f) => !allowed.has(f));
  assert.deepEqual(
    hits, [],
    `these still name the pre-rename env var: ${hits.join(", ")}`,
  );
});

test.skipIf(inSourceSnapshot)("the floor gate's legacy-name exception is load-bearing", () => {
  // The allowlist entry for the floor gate is justified only while the gate
  // actually needs the legacy name: it must read the declared staging floor
  // under EITHER the legacy or the successor env var while the rename is in
  // flight. If that dual-name parser is dropped, the exception becomes a
  // silent escape hatch — so require the both-name pattern to stay. Removing
  // it REDs here; the gate would then have no reason to name the legacy var.
  const gate = read(FLOOR_GATE);
  assert.ok(
    /SERVER_MIGRATION_\(EXPECTED_\)\?STATEMENT_TIMEOUT_MS/.test(gate),
    "migration-floor-gate.sh must read the floor under both the legacy and successor env names",
  );
});

test.skipIf(inSourceSnapshot)("no shipped config still sets the pre-rename env name", () => {
  for (const rel of [
    ".github/workflows/deploy-aws-staging.yml",
    ".github/workflows/deploy-aws-prod.yml",
  ]) {
    const src = read(path.join(repoRoot, rel));
    assert.ok(
      !new RegExp(`${LEGACY_ENV}\\s*:`).test(src),
      `${rel} still sets ${LEGACY_ENV}; the preflight now fail-closes on it, so the deploy would abort`,
    );
    assert.ok(
      new RegExp(`${EXPECTED_ENV}\\s*:`).test(src),
      `${rel} must declare ${EXPECTED_ENV}`,
    );
  }
});

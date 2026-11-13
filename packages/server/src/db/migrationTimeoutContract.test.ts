/**
 * Contract tooth: the migration statement_timeout is DELIVERED by the
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
 * The failure this guards against is a stale env NAME left behind after the
 * rename. The runtime proof that a fresh connection really reads 60000 lives
 * in `migrationPreflight.realPg.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(serverRoot, "..", "..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(path.join(repoRoot, "RELEASE_SOURCE"));

const LEGACY_ENV = "SERVER_MIGRATION_STATEMENT_TIMEOUT_MS";

test.skipIf(inSourceSnapshot)("the pre-rename name survives nowhere but the guard that refuses it", () => {
  // Catches the class this change is about: a stale name left behind in prose
  // or config while the mechanism moved on. A closed set of policy-guard/test
  // surfaces may legitimately contain the legacy name:
  //   - the preflight's own deprecation guard (refuses it), and this tooth;
  //   - the preflight's behavior test, which sets the legacy name to prove the
  //     guard refuses it;
  //   - the staging floor gate (#5491) and its fixtures, which deliberately
  //     read the declared floor under EITHER env name across the rename
  //     boundary.
  // This is NOT a shipped workflow/runtime fallback: the preflight aborts on the
  // legacy name (DEPRECATED_TIMEOUT_ENV), so the only legacy references left are
  // these guards.
  const allowed = new Set([
    "packages/server/src/db/migrationPreflight.ts",
    "packages/server/src/db/migrationPreflight.test.ts",
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

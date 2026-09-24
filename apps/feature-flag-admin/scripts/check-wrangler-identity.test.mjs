import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkIdentity, parseTopLevel } from "./check-wrangler-identity.mjs";

const repoConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml");
const repoConfig = readFileSync(repoConfigPath, "utf8");

test("current repository wrangler.toml passes the production identity guard", () => {
  assert.deepEqual(checkIdentity(repoConfig), []);
});

test("drifting RAFT_API_ORIGIN fails the guard", () => {
  const tampered = repoConfig.replace("https://api.raft.build", "https://api.staging.example");
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /RAFT_API_ORIGIN/);
});

test("drifting allowed server ids fails the guard", () => {
  const tampered = repoConfig.replace(
    "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    "00000000-0000-0000-0000-000000000000",
  );
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /FEATURE_FLAG_ALLOWED_SERVER_IDS/);
});

test("drifting hyperdrive id fails the guard", () => {
  const tampered = repoConfig.replace("4d73351671b9464a8cbc37e978002169", "deadbeefdeadbeefdeadbeefdeadbeef");
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /hyperdrive/i);
});

test("drifting d1 database id fails the guard", () => {
  const tampered = repoConfig.replace(
    "db117923-c16f-4893-b49e-d3bfbb56fac9",
    "00000000-0000-0000-0000-000000000000",
  );
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /d1/i);
});

test("removing the hyperdrive binding entirely fails the guard", () => {
  const tampered = repoConfig
    .replace('binding = "FEATURE_FLAG_PG"', 'binding = "SOMETHING_ELSE"');
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /expected exactly 1 top-level entry, found 0/);
});

test("[env.*] tables do not satisfy or override top-level identity", () => {
  // An [env.staging] section that redefines identity values must be invisible
  // to the top-level guard: neither satisfying a missing top-level value nor
  // overriding a correct one.
  const withEnv = `${repoConfig}\n[env.staging]\nname = "slock-feature-flag-admin-staging"\n\n[env.staging.vars]\nRAFT_API_ORIGIN = "https://api.staging.example"\n`;
  assert.deepEqual(checkIdentity(withEnv), []);
  const parsed = parseTopLevel(withEnv);
  assert.equal(parsed.vars.RAFT_API_ORIGIN, "https://api.raft.build");
  assert.equal(parsed.root.name, "slock-feature-flag-admin");
});

test("a duplicate hyperdrive binding with a drifted id fails the guard", () => {
  // In TOML, [[hyperdrive]] after an [env.*] table reopens the TOP-LEVEL
  // array. A guard that only checks the first matching entry would pass while
  // wrangler sees an ambiguous/duplicated binding. Exactly-one is enforced.
  const tampered = `${repoConfig}\n[env.staging]\n\n[[hyperdrive]]\nbinding = "FEATURE_FLAG_PG"\nid = "deadbeefdeadbeefdeadbeefdeadbeef"\n`;
  const failures = checkIdentity(tampered);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /expected exactly 1 top-level entry, found 2/);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { SERVER_VERSION, readBuildIdentityStatus, readServerVersion } from "./version.js";

// SERVER_VERSION must match `packages/server/package.json` so traces and any
// future API responses report the version actually shipped. The constant is
// computed once at module load; this test pins that the read mechanism
// reaches the right file even after restructure / tsx vs build flips.

test("readServerVersion returns a non-empty semver string", () => {
  const version = readServerVersion();
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("SERVER_VERSION constant matches readServerVersion()", () => {
  assert.equal(SERVER_VERSION, readServerVersion());
});

test("SERVER_VERSION matches packages/server/package.json version", async () => {
  const pkg = (await import("../package.json", { with: { type: "json" } })).default as {
    version: string;
  };
  assert.equal(SERVER_VERSION, pkg.version);
});

test("readBuildIdentityStatus accepts complete build-time release identity", () => {
  const status = readBuildIdentityStatus({
    SLOCK_RELEASE_SHA: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
    SLOCK_RELEASE_BRANCH: "staging",
  });

  assert.deepEqual(status, {
    ok: true,
    identity: {
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      builtAt: "2026-07-13T04:52:55Z",
      branch: "staging",
    },
  });
});

test("RAFT release identity is canonical and legacy aliases must agree", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const env = {
    RAFT_RELEASE_SHA: sha,
    RAFT_BUILD_AT: "2026-07-13T04:52:55Z",
    RAFT_RELEASE_BRANCH: "staging",
    SLOCK_RELEASE_SHA: sha,
    SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
    SLOCK_RELEASE_BRANCH: "staging",
  };
  assert.equal(readBuildIdentityStatus(env).ok, true);
  assert.equal(readBuildIdentityStatus({ ...env, SLOCK_RELEASE_SHA: "f".repeat(40) }).ok, false);
});

test("readBuildIdentityStatus fails explicitly when release sha is unavailable", () => {
  const status = readBuildIdentityStatus({
    SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
    SLOCK_RELEASE_BRANCH: "staging",
  });

  assert.equal(status.ok, false);
  if (status.ok) return;
  assert.equal(status.code, "build_identity_unavailable");
  assert.equal(status.reason, "RAFT_RELEASE_SHA is missing or disagrees with its legacy alias");
  assert.equal(status.identity.sha, null);
});

test("readBuildIdentityStatus rejects placeholder and short release shas", () => {
  for (const sha of ["unknown", "abcdef1"]) {
    const status = readBuildIdentityStatus({
      SLOCK_RELEASE_SHA: sha,
      SLOCK_BUILD_AT: "2026-07-13T04:52:55Z",
      SLOCK_RELEASE_BRANCH: "staging",
    });

    assert.equal(status.ok, false, `${sha} must not be accepted as deployed identity`);
  }
});

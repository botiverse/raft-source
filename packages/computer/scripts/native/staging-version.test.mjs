import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { STABLE_FLOOR, compareSemver, parseSemver, resolveStagingVersion } from "./staging-version.mjs";
import { compareComputerVersions } from "../../src/kReleaseSource";

test("staging candidate resolves to a prerelease strictly above the stable floor", () => {
  const version = resolveStagingVersion({ packageVersion: "1.0.19", shortSha: "6bdaa9a4f9fc" });
  assert.equal(version, "1.0.19-staging.sha.6bdaa9a4f9fc");
  // Upgrade-relation fixture: stable 1.0.18 → candidate is strictly an
  // upgrade, never downgrade/equal, under the real comparator both ways.
  assert.ok(compareSemver(version, STABLE_FLOOR) > 0);
  assert.ok(compareSemver(STABLE_FLOOR, version) < 0);
  assert.ok(compareComputerVersions(version, "1.0.18") > 0);
});

test("repository package version derives a candidate strictly above the stable floor", async () => {
  // Binds the actual repo state, not a fixture: if packages/computer/
  // package.json ever lags the released stable line again (the 1.0.17-vs-
  // stable-1.0.18 regression), this is the tooth that goes red.
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version = resolveStagingVersion({ packageVersion: pkg.version, shortSha: "6bdaa9a4f9fc" });
  assert.ok(compareSemver(version, STABLE_FLOOR) > 0);
});

test("stale version bases below or at the stable floor fail closed", () => {
  // The exact regression this contract exists for: package.json lagging the
  // released stable line must never produce a publishable staging version.
  assert.throws(
    () => resolveStagingVersion({ packageVersion: "1.0.17", shortSha: "6bdaa9a4f9fc" }),
    /STAGING_FLOOR_VIOLATION/,
  );
  // 1.0.18-staging.* orders BELOW stable 1.0.18 (prerelease of the same
  // triple): equal base is as invalid as a lower one.
  assert.throws(
    () => resolveStagingVersion({ packageVersion: "1.0.18", shortSha: "6bdaa9a4f9fc" }),
    /STAGING_FLOOR_VIOLATION/,
  );
  assert.throws(
    () => resolveStagingVersion({ packageVersion: "1.0.19-rc.1", shortSha: "6bdaa9a4f9fc" }),
    /STAGING_BASE_INVALID/,
  );
});

test("sha input is validated and pathological shas fail closed, not misordered", () => {
  for (const bad of ["", "abc", "6BDAA9A4F9FC", "6bdaa9a4f9fg", "6bdaa9a4f9fc0", undefined]) {
    assert.throws(
      () => resolveStagingVersion({ packageVersion: "1.0.19", shortSha: bad }),
      /STAGING_SHA_INVALID/,
    );
  }
  // An all-digit sha with a leading zero would form a zero-padded numeric
  // pre-release identifier; strict SemVer rejects it and so must we, at
  // derivation time rather than in a downstream consumer.
  assert.throws(
    () => resolveStagingVersion({ packageVersion: "1.0.19", shortSha: "012345678901" }),
    /STAGING_VERSION_UNPARSABLE/,
  );
  // All-digit without leading zero is a valid numeric identifier.
  assert.equal(
    resolveStagingVersion({ packageVersion: "1.0.19", shortSha: "123456789012" }),
    "1.0.19-staging.sha.123456789012",
  );
});

test("module comparator orders identically to the runtime updater comparator", () => {
  const versions = [
    "1.0.17",
    "1.0.17-staging.sha.6bdaa9a4f9fc",
    "1.0.18",
    "1.0.18-rc.1",
    "1.0.18-rc.2",
    "1.0.19",
    "1.0.19-staging.sha.6bdaa9a4f9fc",
    "1.0.19-staging.sha.123456789012",
    "1.0.19-staging",
    "1.0.19-staging.sha",
    "2.0.0",
    "1.1.0",
    "0.9.9",
  ];
  for (const a of versions) {
    for (const b of versions) {
      assert.equal(
        Math.sign(compareSemver(a, b)),
        Math.sign(compareComputerVersions(a, b)),
        `ordering divergence between derivation and updater for (${a}, ${b})`,
      );
    }
  }
  for (const bad of ["1.0", "v1.0.19", "1.0.19+build", "1.0.19-01", "1.0.19-staging.sha.01"]) {
    assert.throws(() => parseSemver(bad), /STAGING_VERSION_UNPARSABLE/);
    assert.throws(() => compareComputerVersions(bad, "1.0.18"));
  }
});

test("CLI emits exactly the resolved version and fails closed on floor violations", () => {
  const cli = new URL("./staging-version.mjs", import.meta.url).pathname;
  const mkpkg = (version) => {
    const dir = mkdtempSync(join(tmpdir(), "staging-version-"));
    const file = join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ version }));
    return file;
  };
  const good = execFileSync(process.execPath, [
    cli, "--short-sha", "6bdaa9a4f9fc", "--package-json", mkpkg("1.0.19"),
  ], { encoding: "utf8" });
  assert.equal(good, "1.0.19-staging.sha.6bdaa9a4f9fc\n");
  assert.throws(() => execFileSync(process.execPath, [
    cli, "--short-sha", "6bdaa9a4f9fc", "--package-json", mkpkg("1.0.17"),
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
});

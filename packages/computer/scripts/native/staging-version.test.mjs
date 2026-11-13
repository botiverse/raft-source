import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STABLE_FLOOR, compareSemver, parseSemver, resolveStagingVersion } from "./staging-version.mjs";
import { compareComputerVersions } from "../../src/computerVersionOrder";

// Fixtures are derived from the frozen floor so raising STABLE_FLOOR (a
// deliberate release decision) does not silently invalidate these teeth.
const [FLOOR_MAJOR, FLOOR_MINOR, FLOOR_PATCH] = STABLE_FLOOR.split(".").map(Number);
const ABOVE_FLOOR = `${FLOOR_MAJOR}.${FLOOR_MINOR}.${FLOOR_PATCH + 1}`;
// The nearest valid version under the floor: a floor ending in .0 (1.22.0)
// has no patch to step down from, and "1.22.-1" is not a version at all.
const BELOW_FLOOR =
  FLOOR_PATCH > 0
    ? `${FLOOR_MAJOR}.${FLOOR_MINOR}.${FLOOR_PATCH - 1}`
    : FLOOR_MINOR > 0
      ? `${FLOOR_MAJOR}.${FLOOR_MINOR - 1}.0`
      : `${FLOOR_MAJOR - 1}.0.0`;
// A real commit time (UTC YYYYMMDDHHMMSS) used where order is not under test.
const T = "20261003085512";

test("staging candidate resolves to a prerelease strictly above the stable floor", () => {
  const version = resolveStagingVersion({ commitTime: T, packageVersion: ABOVE_FLOOR, shortSha: "6bdaa9a4f9fc" });
  assert.equal(version, `${ABOVE_FLOOR}-staging.${T}.sha.6bdaa9a4f9fc`);
  // Upgrade-relation fixture: stable floor → candidate is strictly an
  // upgrade, never downgrade/equal, under the real comparator both ways.
  assert.ok(compareSemver(version, STABLE_FLOOR) > 0);
  assert.ok(compareSemver(STABLE_FLOOR, version) < 0);
  assert.ok(compareComputerVersions(version, STABLE_FLOOR) > 0);
});

test("repository package version derives a candidate strictly above the stable floor", async () => {
  // Binds the actual repo state, not a fixture: if packages/computer/
  // package.json ever lags the released stable line again (the 1.0.17-vs-
  // stable-1.0.18 regression), this is the tooth that goes red.
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version = resolveStagingVersion({ commitTime: T, packageVersion: pkg.version, shortSha: "6bdaa9a4f9fc" });
  assert.ok(compareSemver(version, STABLE_FLOOR) > 0);
});

test("stale version bases below or at the stable floor fail closed", () => {
  // The exact regression this contract exists for: package.json lagging the
  // released stable line must never produce a publishable staging version.
  assert.throws(
    () => resolveStagingVersion({ commitTime: T, packageVersion: BELOW_FLOOR, shortSha: "6bdaa9a4f9fc" }),
    /STAGING_FLOOR_VIOLATION/,
  );
  // <floor>-staging.* orders BELOW the stable floor (prerelease of the same
  // triple): equal base is as invalid as a lower one.
  assert.throws(
    () => resolveStagingVersion({ commitTime: T, packageVersion: STABLE_FLOOR, shortSha: "6bdaa9a4f9fc" }),
    /STAGING_FLOOR_VIOLATION/,
  );
  assert.throws(
    () => resolveStagingVersion({ commitTime: T, packageVersion: `${ABOVE_FLOOR}-rc.1`, shortSha: "6bdaa9a4f9fc" }),
    /STAGING_BASE_INVALID/,
  );
});

test("sha input is validated and pathological shas fail closed, not misordered", () => {
  for (const bad of ["", "abc", "6BDAA9A4F9FC", "6bdaa9a4f9fg", "6bdaa9a4f9fc0", undefined]) {
    assert.throws(
      () => resolveStagingVersion({ commitTime: T, packageVersion: ABOVE_FLOOR, shortSha: bad }),
      /STAGING_SHA_INVALID/,
    );
  }
  // An all-digit sha with a leading zero would form a zero-padded numeric
  // pre-release identifier; strict SemVer rejects it and so must we, at
  // derivation time rather than in a downstream consumer.
  assert.throws(
    () => resolveStagingVersion({ commitTime: T, packageVersion: ABOVE_FLOOR, shortSha: "012345678901" }),
    /STAGING_VERSION_UNPARSABLE/,
  );
  // All-digit without leading zero is a valid numeric identifier.
  assert.equal(
    resolveStagingVersion({ commitTime: T, packageVersion: ABOVE_FLOOR, shortSha: "123456789012" }),
    `${ABOVE_FLOOR}-staging.${T}.sha.123456789012`,
  );
});

test("commit time is validated as a strict UTC calendar date-time and fails closed", () => {
  for (const bad of [
    undefined, "", 20261003085512, "2026100308551", "202610030855120", "x2026100308551",
    " 2026100308551", "2026100308551 ", "2026-10-03T08:55", "20191231235959",
    "20260001000000", "20261300000000", "20261000000000", "20261032000000",
    "20260230000000", "20250229000000", "21000229000000", "20260431000000",
    "20261003240000", "20261003246000", "20261003086000", "20261003085560",
  ]) {
    assert.throws(
      () => resolveStagingVersion({ packageVersion: ABOVE_FLOOR, commitTime: bad, shortSha: "6bdaa9a4f9fc" }),
      /STAGING_COMMIT_TIME_INVALID/,
      `commit time ${String(bad)} must be rejected`,
    );
  }
  for (const good of [
    "20200101000000", "20261003085512", "20240229235959", "24000229000000",
    "20261231235959", "20260430000000",
  ]) {
    assert.equal(
      resolveStagingVersion({ packageVersion: ABOVE_FLOOR, commitTime: good, shortSha: "6bdaa9a4f9fc" }),
      `${ABOVE_FLOOR}-staging.${good}.sha.6bdaa9a4f9fc`,
    );
  }
});

test("staging versions order by commit time regardless of sha, under both comparators", () => {
  const at = (commitTime, shortSha) => resolveStagingVersion({ packageVersion: ABOVE_FLOOR, commitTime, shortSha });
  // Each later commit carries a sha that sorts LOWER, so only the time can
  // produce the right order; second, minute, day, month and year boundaries.
  const ordered = [
    at("20261003085959", "ffffffffffff"),
    at("20261003090000", "fffffffffff0"),
    at("20261003090001", "0000aaaaaaaa"),
    at("20261004000000", "00000000000a"),
    at("20261101000000", "123456789012"),
    at("20270101000000", "000000000a00"),
  ];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      const expected = Math.sign(i - j);
      assert.equal(Math.sign(compareSemver(ordered[i], ordered[j])), expected, `${ordered[i]} vs ${ordered[j]}`);
      assert.equal(Math.sign(compareComputerVersions(ordered[i], ordered[j])), expected, `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  // Same commit → same version (reruns reuse it).
  assert.equal(at(T, "6bdaa9a4f9fc"), at(T, "6bdaa9a4f9fc"));
});

test("transition hazard is pinned: new form orders below a legacy same-base sha form only", () => {
  // SemVer §11: numeric identifiers order below alphanumeric ones, so the
  // new form must never share a base with the legacy one.
  const legacySameBase = `${ABOVE_FLOOR}-staging.sha.ffffffffffff`;
  const next = resolveStagingVersion({ packageVersion: ABOVE_FLOOR, commitTime: "20991231235959", shortSha: "ffffffffffff" });
  assert.ok(compareSemver(next, legacySameBase) < 0);
  assert.ok(compareComputerVersions(next, legacySameBase) < 0);
});

test("repository base orders every new-form version above the previous base's legacy staging builds", async () => {
  // Binds the real repo state: the new form shipped with a base bump, so the
  // earliest possible new-form version is above any legacy
  // `${STABLE_FLOOR}-staging.sha.*` already on alpha.
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const earliest = resolveStagingVersion({ packageVersion: pkg.version, commitTime: "20200101000000", shortSha: "00000000000a" });
  for (const legacy of [`${STABLE_FLOOR}-staging.sha.ffffffffffff`, `${STABLE_FLOOR}-staging.sha.123456789012`]) {
    assert.ok(compareSemver(earliest, legacy) > 0, `${earliest} vs ${legacy}`);
    assert.ok(compareComputerVersions(earliest, legacy) > 0, `${earliest} vs ${legacy}`);
  }
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
    "1.0.19-staging.20261003085959.sha.ffffffffffff",
    "1.0.19-staging.20261003090000.sha.0000aaaaaaaa",
    "1.0.19-staging.20261003085512.sha.123456789012",
    "1.0.19-staging.20270101000000.sha.6bdaa9a4f9fc",
    "1.0.20-staging.20200101000000.sha.6bdaa9a4f9fc",
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
  for (const bad of ["1.0", "v1.0.19", "1.0.19+build", "1.0.19-01", "1.0.19-staging.sha.01", "1.0.19-staging.020261003085512.sha.6bdaa9a4f9fc"]) {
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
    cli, "--commit-time", T, "--short-sha", "6bdaa9a4f9fc", "--package-json", mkpkg(ABOVE_FLOOR),
  ], { encoding: "utf8" });
  assert.equal(good, `${ABOVE_FLOOR}-staging.${T}.sha.6bdaa9a4f9fc\n`);
  assert.throws(
    () => execFileSync(process.execPath, [
      cli, "--commit-time", T, "--short-sha", "6bdaa9a4f9fc", "--package-json", mkpkg(BELOW_FLOOR),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => /STAGING_FLOOR_VIOLATION/.test(String(error.stderr)),
  );
  // A missing --commit-time fails closed with its own code, never a time-less version.
  assert.throws(
    () => execFileSync(process.execPath, [
      cli, "--short-sha", "6bdaa9a4f9fc", "--package-json", mkpkg(ABOVE_FLOOR),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    (error) => /STAGING_COMMIT_TIME_INVALID/.test(String(error.stderr)),
  );
});

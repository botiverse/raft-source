// Canonical staging Computer version derivation.
//
// Form: `${packageVersion}-staging.${commitTime}.sha.${shortSha}`.
// `commitTime` is the published commit's committer timestamp in UTC as
// YYYYMMDDHHMMSS (14 digits), read from the commit object itself
// (`git show -s --format=%cd`), so it is deterministic per commit (reruns
// reproduce the same version) and needs no full clone. SemVer compares the
// 14-digit identifier numerically, so staging versions of one base order by
// commit time; the sha stays for provenance and no longer decides order (the
// earlier `-staging.sha.${shortSha}` form ordered by a random sha).
//
// Honest limit: this is a clock, not a counter. Staging merges land one at a
// time, so committer time increases in practice, but nothing here proves it:
// a skewed committer clock, an explicitly set committer date, or two commits
// in the same second could tie or invert the order. The version stays unique
// (the sha differs); only recency order would be wrong. (Requiring year >=
// 2020 also keeps the identifier free of a leading zero.)
//
// Transition note: under SemVer a numeric identifier orders BELOW an
// alphanumeric one, so `X-staging.<time>.sha.*` orders below a legacy
// `X-staging.sha.*` of the SAME base X. The new form ships with the 1.0.41
// base bump, so every new version orders above every `1.0.40-staging.sha.*`;
// never reintroduce the legacy form on a base that also carries the new one.
//
// Every publication consumer (five platform build jobs, manifest production,
// immutable R2 namespaces, Hands registration, staging pointer) must obtain
// the staging version from this one derivation. The previous inline
// `${PKG_VERSION}-staging.sha.${SHORT_SHA}` template in the workflow let the
// package version lag the released stable line: package.json said 1.0.17
// while stable computer-v1.0.18 was already in the field, so staging produced
// a candidate that SemVer-orders BELOW stable. The installers of that time
// skipped their downgrade comparison for prerelease tails, so publishing that
// candidate could silently downgrade any alpha client (today's Rust installer
// compares full SemVer and holds it as a downgrade instead — still a broken
// alpha channel). This module fails closed on that
// entire class: the resolved candidate must be a valid strict-SemVer
// prerelease whose precedence is strictly greater than the stable floor.
//
// The comparator mirrors the runtime's compareComputerVersions
// (packages/computer/src/computerVersionOrder.ts) — strict x.y.z(-pre) only, no
// build metadata, zero-padded numeric pre-release identifiers rejected —
// so a version this module emits is by construction parseable by the
// updater that later consumes it. staging-version.test.mjs pins the two
// implementations to identical ordering over a fixture matrix; change them
// together or that tooth goes red.

// Highest official stable Computer release at the time this floor was frozen
// (source tag computer-v1.22.0, published stable 2026-11-12). Raising the floor is a deliberate release decision; it must
// move with the stable line, never ahead of it. The publish workflow's
// carrier-version closure gate fails closed (STABLE_FLOOR_DRIFT) when this
// constant lags the highest published stable tag.
export const STABLE_FLOOR = "1.22.0";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(version) {
  const m = SEMVER_RE.exec(version);
  if (!m) {
    throw new Error(`STAGING_VERSION_UNPARSABLE: "${version}" is not strict x.y.z(-pre) semver`);
  }
  const pre = m[4] ? m[4].split(".") : null;
  if (pre?.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) {
    throw new Error(
      `STAGING_VERSION_UNPARSABLE: "${version}" has a zero-padded numeric pre-release identifier`,
    );
  }
  return { nums: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], pre };
}

// SemVer 2.0.0 §11 precedence: negative / 0 / positive. Throws (never
// silently orders) on unparsable input.
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const count = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < count; i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}

// Strict UTC calendar date-time, YYYYMMDDHHMMSS, year >= 2020. Throws on
// anything else rather than letting a malformed identifier mis-order.
export function assertCommitTime(commitTime) {
  const fail = (why) => {
    throw new Error(
      `STAGING_COMMIT_TIME_INVALID: commit time must be the commit's UTC committer time as ` +
      `YYYYMMDDHHMMSS (${why}), got "${commitTime}"`,
    );
  };
  if (typeof commitTime !== "string" || !/^\d{14}$/.test(commitTime)) fail("exactly 14 digits");
  const [year, month, day, hour, minute, second] = [
    commitTime.slice(0, 4), commitTime.slice(4, 6), commitTime.slice(6, 8),
    commitTime.slice(8, 10), commitTime.slice(10, 12), commitTime.slice(12, 14),
  ].map(Number);
  if (year < 2020) fail("year >= 2020");
  if (month < 1 || month > 12) fail("month 01-12");
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) fail(`day 01-${daysInMonth} for that month`);
  if (hour > 23) fail("hour 00-23");
  if (minute > 59) fail("minute 00-59");
  if (second > 59) fail("second 00-59");
}

export function resolveStagingVersion({ packageVersion, commitTime, shortSha, stableFloor = STABLE_FLOOR }) {
  assertCommitTime(commitTime);
  if (!/^[0-9a-f]{12}$/.test(shortSha ?? "")) {
    throw new Error(
      `STAGING_SHA_INVALID: short sha must be exactly 12 lowercase hex characters, got "${shortSha}"`,
    );
  }
  const base = parseSemver(packageVersion);
  if (base.pre !== null) {
    throw new Error(
      `STAGING_BASE_INVALID: package version "${packageVersion}" must be a stable x.y.z base`,
    );
  }
  const candidate = `${packageVersion}-staging.${commitTime}.sha.${shortSha}`;
  // An all-digit sha with a leading zero forms a zero-padded numeric
  // pre-release identifier, which strict SemVer rejects — parseSemver throws
  // here rather than letting an unorderable version reach any consumer.
  // (~0.03% of commits; re-landing produces a new sha.)
  const parsed = parseSemver(candidate);
  if (parsed.pre === null) {
    throw new Error(`STAGING_CANDIDATE_INVALID: "${candidate}" must be a prerelease`);
  }
  if (compareSemver(candidate, stableFloor) <= 0) {
    throw new Error(
      `STAGING_FLOOR_VIOLATION: candidate "${candidate}" does not SemVer-order strictly above ` +
      `stable floor "${stableFloor}"; publishing it could silently downgrade alpha clients. ` +
      `Bump packages/computer/package.json above the stable line first.`,
    );
  }
  return candidate;
}

async function main() {
  const { readFile } = await import("node:fs/promises");
  const args = process.argv.slice(2);
  const opts = { packageJson: "packages/computer/package.json", stableFloor: STABLE_FLOOR };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key === "--short-sha") opts.shortSha = value;
    else if (key === "--commit-time") opts.commitTime = value;
    else if (key === "--package-json") opts.packageJson = value;
    else if (key === "--stable-floor") opts.stableFloor = value;
    else {
      process.stderr.write(`unknown argument: ${key}\n`);
      process.exit(1);
    }
  }
  const pkg = JSON.parse(await readFile(opts.packageJson, "utf8"));
  const version = resolveStagingVersion({
    packageVersion: pkg.version,
    commitTime: opts.commitTime,
    shortSha: opts.shortSha,
    stableFloor: opts.stableFloor,
  });
  process.stdout.write(`${version}\n`);
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

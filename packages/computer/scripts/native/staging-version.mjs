// Canonical staging Computer version derivation.
//
// Every publication consumer (five platform build jobs, manifest production,
// immutable R2 namespaces, Hands registration, staging pointer) must obtain
// the staging version from this one derivation. The previous inline
// `${PKG_VERSION}-staging.sha.${SHORT_SHA}` template in the workflow let the
// package version lag the released stable line: package.json said 1.0.17
// while stable computer-v1.0.18 was already in the field, so staging produced
// a candidate that SemVer-orders BELOW stable. Both installers skip their
// downgrade comparison for prerelease tails, so publishing that candidate
// could silently downgrade any alpha client. This module fails closed on that
// entire class: the resolved candidate must be a valid strict-SemVer
// prerelease whose precedence is strictly greater than the stable floor.
//
// The comparator mirrors the runtime's compareComputerVersions
// (packages/computer/src/kReleaseSource.ts) — strict x.y.z(-pre) only, no
// build metadata, zero-padded numeric pre-release identifiers rejected —
// so a version this module emits is by construction parseable by the
// updater that later consumes it. staging-version.test.mjs pins the two
// implementations to identical ordering over a fixture matrix; change them
// together or that tooth goes red.

// Highest official stable Computer release at the time this floor was frozen
// (source tag computer-v1.0.18). Raising the floor is a deliberate release
// decision; it must move with the stable line, never ahead of it.
export const STABLE_FLOOR = "1.0.18";

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

export function resolveStagingVersion({ packageVersion, shortSha, stableFloor = STABLE_FLOOR }) {
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
  const candidate = `${packageVersion}-staging.sha.${shortSha}`;
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

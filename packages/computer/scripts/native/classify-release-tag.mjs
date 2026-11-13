#!/usr/bin/env node

const numericIdentifier = "(?:0|[1-9][0-9]*)";
const baseVersionPattern = `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`;
const stableTagPattern = new RegExp(`^computer-v(${baseVersionPattern})$`);
const rcTagPattern = new RegExp(
  `^computer-v((${baseVersionPattern})-rc\\.([1-9][0-9]*))$`,
);
// task #816 — feature-branch channel tags: computer-v<base>-<channel>.<n>.
// The channel slug follows the Computer CLI's named-channel grammar
// (packages/computer/src/lib/channelState.ts) and refuses cohort words so a
// feature tag can never be read as an RC or a stable release.
const featureChannelSlugPattern = "[a-z0-9][a-z0-9-]{1,62}[a-z0-9]";
const featureTagPattern = new RegExp(
  `^computer-v((${baseVersionPattern})-(${featureChannelSlugPattern})\\.([1-9][0-9]*))$`,
);
// `candidate` is the Hands channel RC tags publish to: the CLI accepts it as a
// named channel, so it must be refused here or a feature tag could publish
// into the release-candidate cohort.
export const RESERVED_CHANNEL_WORDS = new Set([
  "main", "alpha", "candidate", "latest", "stable", "rc", "release", "staging", "production", "prod", "nightly", "preview", "pinned", "default",
]);

export function classifyComputerReleaseTag(tag, packageVersion) {
  if (typeof tag !== "string" || typeof packageVersion !== "string") {
    throw new Error("release tag and Computer package version are required");
  }

  const stable = stableTagPattern.exec(tag);
  if (stable) {
    if (stable[1] !== packageVersion) {
      throw new Error(
        `Tag version ${stable[1]} does not match Computer package ${packageVersion}`,
      );
    }
    return {
      channel: "stable",
      version: stable[1],
      packageVersion,
    };
  }

  const rc = rcTagPattern.exec(tag);
  if (rc) {
    const [, tagVersion, baseVersion] = rc;
    if (baseVersion !== packageVersion) {
      throw new Error(
        `RC base version ${baseVersion} does not match Computer package ${packageVersion}`,
      );
    }
    return {
      channel: "rc",
      // Candidate bytes carry the final package version. The RC tag is an
      // immutable source/provenance identity, not a different user-visible
      // binary version. Stable promotion therefore copies the exact tested
      // bytes instead of rebuilding a second carrier with a different stamp.
      version: baseVersion,
      tagVersion,
      packageVersion,
    };
  }

  const feature = featureTagPattern.exec(tag);
  if (feature) {
    const [, tagVersion, baseVersion, featureChannel, sequence] = feature;
    if (RESERVED_CHANNEL_WORDS.has(featureChannel)) {
      throw new Error(`Feature channel '${featureChannel}' is a reserved cohort word`);
    }
    if (baseVersion !== packageVersion) {
      throw new Error(
        `Feature base version ${baseVersion} does not match Computer package ${packageVersion}`,
      );
    }
    return {
      channel: "feature",
      // Unlike an RC, a feature build's binary is stamped with the full
      // channel-suffixed version so machines on the feature channel can tell
      // it apart from every stable/alpha build of the same base.
      version: tagVersion,
      baseVersion,
      featureChannel,
      sequence: Number(sequence),
      packageVersion,
    };
  }

  throw new Error(
    "Tag must match computer-v<semver>, computer-v<semver>-rc.<positive integer>, or computer-v<semver>-<channel>.<positive integer>",
  );
}

if (process.argv[1]?.endsWith("classify-release-tag.mjs")) {
  try {
    const result = classifyComputerReleaseTag(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`classify Computer release tag: ${message}\n`);
    process.exitCode = 1;
  }
}

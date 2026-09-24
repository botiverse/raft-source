#!/usr/bin/env node

const numericIdentifier = "(?:0|[1-9][0-9]*)";
const baseVersionPattern = `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}`;
const stableTagPattern = new RegExp(`^computer-v(${baseVersionPattern})$`);
const rcTagPattern = new RegExp(
  `^computer-v((${baseVersionPattern})-rc\\.([1-9][0-9]*))$`,
);

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

  throw new Error(
    "Tag must match computer-v<semver> or computer-v<semver>-rc.<positive integer>",
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

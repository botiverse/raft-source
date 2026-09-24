import { createRequire } from "node:module";

// Read the server's own semver from `packages/server/package.json` at runtime
// so traces / logs / future API responses can attribute themselves to a
// concrete release. Pattern mirrors `readDaemonVersion()` in
// `packages/daemon/src/core.ts`.
//
// The convention (per #engineering:3525a4de 2026-05-03):
// - server + web share one semver, bumped together in each release-notes PR.
// - independent of daemon — daemon ships out-of-band on its own tags.
// - starts at 0.1.0; not yet surfaced to users (single deployment), but the
//   server itself needs the version for tracing.

export function readServerVersion(moduleUrl: string = import.meta.url): string {
  try {
    const require = createRequire(moduleUrl);
    return require("../package.json").version as string;
  } catch {
    return "0.0.0-dev";
  }
}

export const SERVER_VERSION = readServerVersion();

export type BuildIdentity = {
  sha: string;
  builtAt: string;
  branch: string;
};

export type BuildIdentityStatus =
  | { ok: true; identity: BuildIdentity }
  | {
    ok: false;
    code: "build_identity_unavailable";
    reason: string;
    identity: {
      sha: string | null;
      builtAt: string | null;
      branch: string | null;
    };
  };

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function cleanEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalEnvValue(env: NodeJS.ProcessEnv, raftName: string, legacyName: string): string | null {
  const raft = cleanEnvValue(env[raftName]);
  const legacy = cleanEnvValue(env[legacyName]);
  if (raft && legacy && raft !== legacy) return null;
  return raft ?? legacy;
}

function readCandidateBuildIdentity(env: NodeJS.ProcessEnv) {
  return {
    sha: canonicalEnvValue(env, "RAFT_RELEASE_SHA", "SLOCK_RELEASE_SHA"),
    builtAt: canonicalEnvValue(env, "RAFT_BUILD_AT", "SLOCK_BUILD_AT"),
    branch: canonicalEnvValue(env, "RAFT_RELEASE_BRANCH", "SLOCK_RELEASE_BRANCH"),
  };
}

function buildIdentityProblem(identity: { sha: string | null; builtAt: string | null; branch: string | null }): string | null {
  if (!identity.sha) return "RAFT_RELEASE_SHA is missing or disagrees with its legacy alias";
  if (!RELEASE_SHA_PATTERN.test(identity.sha)) return "RAFT_RELEASE_SHA must be a 40-character git SHA";
  if (!identity.builtAt) return "RAFT_BUILD_AT is missing or disagrees with its legacy alias";
  if (!UTC_INSTANT_PATTERN.test(identity.builtAt) || Number.isNaN(Date.parse(identity.builtAt))) {
    return "RAFT_BUILD_AT must be a UTC ISO-8601 instant";
  }
  if (!identity.branch) return "RAFT_RELEASE_BRANCH is missing or disagrees with its legacy alias";
  return null;
}

export function readBuildIdentityStatus(env: NodeJS.ProcessEnv = process.env): BuildIdentityStatus {
  const candidate = readCandidateBuildIdentity(env);
  const reason = buildIdentityProblem(candidate);
  if (reason) {
    return {
      ok: false,
      code: "build_identity_unavailable",
      reason,
      identity: candidate,
    };
  }
  const identity = candidate as BuildIdentity;
  return {
    ok: true,
    identity: {
      sha: identity.sha.toLowerCase(),
      builtAt: identity.builtAt,
      branch: identity.branch,
    },
  };
}

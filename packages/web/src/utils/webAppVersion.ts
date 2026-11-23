import { version as packageVersion } from "../../package.json";

type WebAppVersionEnvironment = Pick<ImportMetaEnv, "VITE_APP_VERSION" | "VITE_DEPLOYMENT_ENV" | "VITE_COMMIT_SHA">;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

/**
 * The version this Web build reports (telemetry, X-Raft-Client-Version):
 * VITE_APP_VERSION when the build sets one (the production release build),
 * else the package version. A staging build (VITE_DEPLOYMENT_ENV=staging)
 * sets no VITE_APP_VERSION and its package version lags the releases, so it
 * names its commit as build metadata: `<package version>-staging+<sha7>`.
 * The server reads only the release part of a web version (webClientVersion.ts
 * strips `-…` and `+…`), so a staging build meets the same floors as before;
 * build metadata, unlike a prerelease part, takes any hex sha (a prerelease
 * `0123456` would not parse as SemVer).
 */
export function resolveWebAppVersion(
  environment: WebAppVersionEnvironment | undefined,
  fallbackVersion = packageVersion,
): string {
  const explicit = environment?.VITE_APP_VERSION?.trim();
  if (explicit) return explicit;
  const commitSha = environment?.VITE_COMMIT_SHA?.trim().toLowerCase();
  if (environment?.VITE_DEPLOYMENT_ENV?.trim() === "staging" && commitSha && COMMIT_SHA.test(commitSha)) {
    return `${fallbackVersion}-staging+${commitSha.slice(0, 7)}`;
  }
  return fallbackVersion;
}

/** Version of the Web artifact this browser tab is currently running. */
export const WEB_APP_VERSION = resolveWebAppVersion(import.meta.env);

/**
 * The release a Web build publishes and an open tab compares itself with
 * (/version.json, utils/webVersionCheck): the frontend release id
 * (VITE_FRONTEND_RELEASE_ID, else VITE_COMMIT_SHA; buildIdentity), which every
 * deploy changes, else the version above.
 */
export function resolveWebRelease(
  releaseId: string | null,
  environment: WebAppVersionEnvironment | undefined,
): string {
  return releaseId ?? resolveWebAppVersion(environment);
}

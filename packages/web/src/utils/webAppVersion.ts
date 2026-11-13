import { version as packageVersion } from "../../package.json";

type WebAppVersionEnvironment = Pick<ImportMetaEnv, "VITE_APP_VERSION">;

export function resolveWebAppVersion(
  environment: WebAppVersionEnvironment | undefined,
  fallbackVersion = packageVersion,
): string {
  return environment?.VITE_APP_VERSION?.trim() || fallbackVersion;
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

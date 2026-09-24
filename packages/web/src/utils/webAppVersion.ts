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

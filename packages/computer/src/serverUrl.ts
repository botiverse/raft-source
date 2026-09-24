export const DEFAULT_SLOCK_SERVER_URL = "https://api.raft.build";
export const LEGACY_PRODUCTION_SERVER_URL = "https://api.slock.ai";
export const SLOCK_SERVER_URL_ENV = "SLOCK_SERVER_URL";
export const RAFT_SERVER_URL_ENV = "RAFT_SERVER_URL";

export function canonicalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return trimmed === LEGACY_PRODUCTION_SERVER_URL ? DEFAULT_SLOCK_SERVER_URL : trimmed;
}

export function resolveServerUrl(...candidates: Array<string | undefined | null>): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return canonicalizeServerUrl(value);
  }
  return DEFAULT_SLOCK_SERVER_URL;
}

export function resolveServerUrlEnv(
  env: Partial<Record<typeof SLOCK_SERVER_URL_ENV | typeof RAFT_SERVER_URL_ENV, string | undefined>> = process.env,
): string | undefined {
  return env[SLOCK_SERVER_URL_ENV] ?? env[RAFT_SERVER_URL_ENV];
}

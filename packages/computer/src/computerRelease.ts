import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

/** Public CDN root for published Computer SEA binaries. */
export const DEFAULT_UPGRADE_BASE_URL = "https://cdn.raft.build/computer";

/** Test/staging override for the Computer release source. */
export const UPGRADE_BASE_URL_ENV = "RAFT_COMPUTER_UPGRADE_BASE_URL";

export function resolveUpgradeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[UPGRADE_BASE_URL_ENV];
  return typeof override === "string" && override.trim().length > 0
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_UPGRADE_BASE_URL;
}

export type ComputerLatestVersionResolveResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: "publishing" | "network" };

/** Read the same latest pointer used by install.sh and K's ReleaseSource. */
export async function fetchCdnLatestVersionResult(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ComputerLatestVersionResolveResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/manifest.json`;
  const controller = new AbortController();
  const timeoutId = setClockTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, reason: response.status === 404 ? "publishing" : "network" };
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0
      ? { ok: true, version: body.version }
      : { ok: false, reason: "publishing" };
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearClockTimeout(timeoutId);
  }
}

export async function fetchCdnLatestVersion(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const result = await fetchCdnLatestVersionResult(baseUrl, fetchFn);
  return result.ok ? result.version : null;
}

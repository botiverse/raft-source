// Fetch latest Raft Computer version from the CDN SEA manifest. Refreshes
// hourly in the background; returns the cached value immediately so the REST
// path never blocks on a network call. The CDN manifest is the same authority
// used by install.sh and `raft-computer upgrade`.
//
// Surfaced through `GET /api/servers/:id/machines` as `latestComputerVersion`
// alongside the existing `latestDaemonVersion`. The server also derives each
// managed Computer row's `computerUpgradeAvailable` value from this authority
// so web surfaces consume a readback-backed comparison instead of guessing.

import { bothComputerVersionsKnown, isComputerOutdated } from "@botiverse/raft-shared";

let cachedLatestComputerVersion: string | null = null;
let lastFetchTime = 0;
let refreshPromise: Promise<void> | null = null;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const COMPUTER_LATEST_MANIFEST_URL = "https://cdn.raft.build/computer/manifest.json";

export function getLatestComputerVersion(): Promise<string | null> {
  const now = Date.now();
  if (cachedLatestComputerVersion && now - lastFetchTime < REFRESH_INTERVAL_MS) {
    return Promise.resolve(cachedLatestComputerVersion);
  }

  void refreshLatestComputerVersion();
  return Promise.resolve(cachedLatestComputerVersion);
}

async function refreshLatestComputerVersion(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchLatestComputerVersion()
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function fetchLatestComputerVersion(): Promise<void> {
  try {
    const res = await fetch(COMPUTER_LATEST_MANIFEST_URL);
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      if (data.version) {
        cachedLatestComputerVersion = data.version;
        lastFetchTime = Date.now();
      }
    }
  } catch {
    // Network lookup is best-effort; fall back to the last cached version.
  }
}

export function __resetLatestComputerVersionForTest(): void {
  cachedLatestComputerVersion = null;
  lastFetchTime = 0;
  refreshPromise = null;
}

export function resolveComputerUpgradeAvailable(
  isComputer: boolean,
  computerVersion: string | null | undefined,
  latestComputerVersion: string | null | undefined,
): boolean | null {
  if (!isComputer) return null;
  if (!bothComputerVersionsKnown(computerVersion, latestComputerVersion)) {
    return null;
  }
  return isComputerOutdated(computerVersion, latestComputerVersion);
}

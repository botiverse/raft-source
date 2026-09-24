// Fetch latest daemon version from npm registry, refresh hourly.
let cachedLatestDaemonVersion: string | null = null;
let lastFetchTime = 0;
let refreshPromise: Promise<void> | null = null;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DAEMON_LATEST_URL = "https://registry.npmjs.org/@botiverse/raft-daemon/latest";

export function getLatestDaemonVersion(): Promise<string | null> {
  const now = Date.now();
  if (cachedLatestDaemonVersion && now - lastFetchTime < REFRESH_INTERVAL_MS) {
    return Promise.resolve(cachedLatestDaemonVersion);
  }

  void refreshLatestDaemonVersion();
  return Promise.resolve(cachedLatestDaemonVersion);
}

async function refreshLatestDaemonVersion(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchLatestDaemonVersion()
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function fetchLatestDaemonVersion(): Promise<void> {
  try {
    const res = await fetch(DAEMON_LATEST_URL);
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      if (data.version) {
        cachedLatestDaemonVersion = data.version;
        lastFetchTime = Date.now();
      }
    }
  } catch {
    // Network lookup is best-effort; fall back to the last cached version.
  }
}

export function __resetLatestDaemonVersionForTest(): void {
  cachedLatestDaemonVersion = null;
  lastFetchTime = 0;
  refreshPromise = null;
}

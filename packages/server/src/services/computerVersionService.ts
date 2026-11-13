// Fetch latest Raft Computer version from the Hands release authority.
// Refreshes hourly in the background; returns the cached value immediately so
// the REST path never blocks on a network call. Hands is the same authority
// the Installer resolves downloads from, so the web's upgrade hint and the
// actual install source can no longer diverge across two stores.
//
// Surfaced through `GET /api/servers/:id/machines` as `latestComputerVersion`
// alongside the existing `latestDaemonVersion`. The server also derives each
// managed Computer row's `computerUpgradeAvailable` value from this authority
// so web surfaces consume a readback-backed comparison instead of guessing.
//
// The same refresh also caches that version's bilingual release notes from
// Hands' `/latest` build (the update-check response carries no notes), surfaced
// as `latestComputerReleaseNotes`. Notes are only ever exposed for the exact
// version cached above, so the web can never pair one version with another
// version's notes.

import {
  bothComputerVersionsKnown,
  isComputerOutdated,
  normalizeComputerReleaseNotes,
} from "@botiverse/raft-shared";
import type { ComputerReleaseNotes } from "@botiverse/raft-shared";
import { isPrivacyModeOn } from "../config/privacyMode";

let cachedLatestComputerVersion: string | null = null;
let cachedLatestComputerReleaseNotes: ComputerReleaseNotes | null = null;
let lastFetchTime = 0;
let refreshPromise: Promise<void> | null = null;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// Public read-only update query; platform/arch only select an artifact row,
// the release version is platform-independent. channel=main is stable.
const HANDS_LATEST_VERSION_URL =
  "https://hands.build/public/v2/apps/raft-computer-cli/updates/check" +
  "?product_type=cli-binary&current_version=0.0.0&platform=linux&arch=x64&channel=main";
// Public read-only latest-build query; `build.release_notes` is
// `{ "zh-CN"?: string, en?: string } | null` markdown keyed by locale.
const HANDS_LATEST_BUILD_URL =
  "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main";

export function getLatestComputerVersion(): Promise<string | null> {
  // RAFT_PRIVACY_MODE: no update check against hands.build; unknown, as when
  // Hands cannot be reached. A manual pinned upgrade on the Computer still works.
  if (isPrivacyModeOn()) return Promise.resolve(null);
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
    const res = await fetch(HANDS_LATEST_VERSION_URL);
    if (res.ok) {
      const data = (await res.json()) as { release?: { version?: unknown } };
      const version = data.release?.version;
      if (typeof version === "string" && version.length > 0) {
        cachedLatestComputerVersion = version;
        lastFetchTime = Date.now();
      }
    }
  } catch {
    // Network lookup is best-effort; fall back to the last cached version.
  }
  await fetchLatestComputerReleaseNotes();
}

async function fetchLatestComputerReleaseNotes(): Promise<void> {
  const version = cachedLatestComputerVersion;
  if (!version) return;
  try {
    const res = await fetch(HANDS_LATEST_BUILD_URL);
    if (!res.ok) return;
    const data = (await res.json()) as { build?: { version?: unknown; release_notes?: unknown } } | null;
    const build = data?.build;
    // A build for a different version (rollout skew between the two Hands
    // reads) never replaces the cache: those notes would not describe the
    // version the web is told about.
    if (!build || build.version !== version) return;
    cachedLatestComputerReleaseNotes = normalizeComputerReleaseNotes(build.version, build.release_notes);
  } catch {
    // Best-effort like the version lookup; keep the last cached notes.
  }
}

/** Cached notes for exactly the cached latest version; null otherwise. Never fetches. */
export function getLatestComputerReleaseNotes(): ComputerReleaseNotes | null {
  const notes = cachedLatestComputerReleaseNotes;
  if (!notes || !cachedLatestComputerVersion) return null;
  return notes.version === cachedLatestComputerVersion ? notes : null;
}

export function __resetLatestComputerVersionForTest(): void {
  cachedLatestComputerVersion = null;
  cachedLatestComputerReleaseNotes = null;
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

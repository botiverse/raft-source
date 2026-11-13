import { privacyModeFromEnv } from "@botiverse/raft-shared";

// RAFT_PRIVACY_MODE for this server process (shared/src/privacyMode.ts says
// what it gates). server.ts reads it once at startup, before anything that
// could reach Raft's own services, and an invalid value stops startup there.
// Everything else only asks `isPrivacyModeOn()`; off (the default) changes
// nothing.

let privacyMode = false;

/** Read and remember RAFT_PRIVACY_MODE. Throws PrivacyModeConfigError on an invalid value. */
export function initPrivacyModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  privacyMode = privacyModeFromEnv(env);
  return privacyMode;
}

export function isPrivacyModeOn(): boolean {
  return privacyMode;
}

export function setPrivacyModeForTest(on: boolean): void {
  privacyMode = on;
}

// The Raft App template logos (mcp_app_templates, seeded from
// config/mcpAppTemplates.json) live on app.raft.build. The web ships the same
// files under its own `/app-logos/`, so under privacy mode a client is given
// that same-origin path and never fetches them from app.raft.build.
const RAFT_APP_LOGO_PREFIX = "https://app.raft.build/app-logos/";
const APP_LOGO_FILE = /^[A-Za-z0-9._-]+$/u;

/** A logo URL as a client should load it: unchanged with privacy mode off or for any other host. */
export function clientLogoUrl(url: string | null): string | null {
  if (!privacyMode || !url?.startsWith(RAFT_APP_LOGO_PREFIX)) return url;
  const file = url.slice(RAFT_APP_LOGO_PREFIX.length);
  return APP_LOGO_FILE.test(file) ? `/app-logos/${file}` : null;
}

/**
 * The Raft web build a request names (X-Raft-Client-Platform browser, pwa or
 * desktop_app with an X-Raft-Client-Version, which every web API call sends:
 * packages/web/src/utils/clientPlatformHint.ts). Requests that name no web
 * build, or a version that does not parse, are "unknown": callers decide
 * what unknown means for them.
 */
import { compareComputerVersions, isComputerSemver, RAFT_CLIENT_VERSION_HEADER } from "@botiverse/raft-shared";

const WEB_PLATFORMS: ReadonlySet<string> = new Set(["browser", "pwa", "desktop_app"]);

/** The release part only, so a staging build of 1.21.44 meets a 1.21.44 floor. */
const release = (version: string) => version.split("+", 1)[0]!.split("-", 1)[0]!;

/** The web build's release version, or null when the request names none. */
export function webClientRelease(header: (name: string) => string | undefined): string | null {
  const platform = header("X-Raft-Client-Platform")?.trim();
  const version = header(RAFT_CLIENT_VERSION_HEADER)?.trim();
  if (!platform || !WEB_PLATFORMS.has(platform) || !version || !isComputerSemver(version)) return null;
  return release(version);
}

/** true / false for a web build at or after `minVersion`; null when the request names no web build. */
export function webClientAtLeast(header: (name: string) => string | undefined, minVersion: string): boolean | null {
  const version = webClientRelease(header);
  return version === null ? null : compareComputerVersions(version, minVersion) >= 0;
}

// Where and on what a product event happened, derived on ingest from the
// request (cindyz, 2026-10-14; design reviewed by Tenny in #proj-analytics).
// Only coarse values are kept, as pipeline properties (`$` names are reserved
// for the pipeline): browser family and major version, OS family, device type,
// and the country CloudFront reports. The raw IP and User-Agent are never
// stored, logged or traced, and nothing here is taken from the client's own
// claims. Do not add finer fields (city, screen size, language, OS version):
// combined they start to fingerprint people (Tenny); discuss first.

import Bowser from "bowser";
import type { ACCOUNT_AGE_BUCKETS, AnnouncementClient, AnnouncementClientPlatform, ClientPlatform } from "@botiverse/raft-shared";

export interface ProductEventContextHeaders {
  userAgent: string | undefined;
  /** `CloudFront-Viewer-Country`: ISO 3166-1 alpha-2, set by CloudFront. */
  country: string | undefined;
  /** Not a product-event request: skip the once-per-process header note. */
  quiet?: boolean;
}

export type ProductEventContext = Readonly<Record<string, string | number>>;

const BROWSERS: Readonly<Record<string, string>> = {
  chrome: "chrome",
  chromium: "chrome",
  safari: "safari",
  firefox: "firefox",
  "microsoft edge": "edge",
  opera: "opera",
  "samsung internet for android": "samsung_internet",
};

const OPERATING_SYSTEMS: Readonly<Record<string, string>> = {
  windows: "windows",
  macos: "macos",
  ios: "ios",
  android: "android",
  linux: "linux",
  "chrome os": "chromeos",
};

const DEVICE_TYPES = new Set(["desktop", "mobile", "tablet"]);
const COUNTRY = /^[A-Z]{2}$/;

/** Unknown, empty or unparsable values become `other`; never a piece of the raw string. */
export function productEventContext(headers: ProductEventContextHeaders): ProductEventContext {
  let browser = "other";
  let browserVersion: number | null = null;
  let os = "other";
  let deviceType = "other";
  if (headers.userAgent) {
    try {
      const result = Bowser.getParser(headers.userAgent).getResult();
      browser = BROWSERS[result.browser.name?.toLowerCase() ?? ""] ?? "other";
      const major = Number.parseInt(result.browser.version ?? "", 10);
      if (browser !== "other" && Number.isInteger(major) && major > 0 && major < 1000) browserVersion = major;
      os = OPERATING_SYSTEMS[result.os.name?.toLowerCase() ?? ""] ?? "other";
      const platform = result.platform.type ?? "";
      deviceType = DEVICE_TYPES.has(platform) ? platform : "other";
    } catch {
      // Unparsable: every field stays `other`.
    }
  }
  const context: Record<string, string | number> = { $browser: browser, $os: os, $device_type: deviceType };
  if (browserVersion !== null) context.$browser_version = browserVersion;
  if (headers.country && COUNTRY.test(headers.country)) context.$country = headers.country;
  if (!headers.quiet) noteCountryHeader(headers.country !== undefined);
  return context;
}

/** The values clients send in `X-Raft-Client-Platform`; requestClientPlatform turns `browser` into `web` or `mobile_web`. */
export const CLIENT_PLATFORM_HEADER_VALUES: ReadonlySet<string> = new Set(["browser", "pwa", "desktop_app", "ios", "android", "harmonyos"]);

/**
 * The client a request came from (task #13): a signup for `account_created`,
 * a card step for `action_card_action`. Clients send `X-Raft-Client-Platform`: the web `browser` / `pwa`, the
 * desktop app `desktop_app`, the native apps themselves; a `browser` is
 * `mobile_web` on a phone or tablet (by User-Agent), else `web`. Anything
 * else, including no header (older clients), is `unknown`.
 */
export function requestClientPlatform(headerValue: string | undefined, userAgent: string | undefined): ClientPlatform | "unknown" {
  const value = headerValue?.trim() ?? "";
  if (value === "browser") {
    const deviceType = productEventContext({ userAgent, country: undefined, quiet: true }).$device_type;
    return deviceType === "mobile" || deviceType === "tablet" ? "mobile_web" : "web";
  }
  return CLIENT_PLATFORM_HEADER_VALUES.has(value) ? value as ClientPlatform : "unknown";
}

/** The client a request came from, by its own headers (never its body). */
export interface RequestClient {
  platform: ClientPlatform | "unknown";
  /**
   * The Raft version the App or the desktop app names in its User-Agent: the
   * App's `Raft/<version>+<build> (<system>; <build type>) Mobile`, Electron's
   * `... Raft/<version> Chrome/...`. Only `<version>` (no build), only for
   * those platforms, and only when it looks like one: a digit, then at most 63
   * letters, digits, dots or hyphens. Never a product-event property (see the
   * note at the top); it is the client's own version for its feedback
   * (feedbackCardForm.ts).
   */
  raftVersion?: string;
}

const RAFT_VERSION = /(?:^|\s)Raft\/(\d[0-9A-Za-z.-]{0,63})(?:\+[0-9A-Za-z.-]{1,64})?(?=[\s;(]|$)/;
const VERSIONED_PLATFORMS: ReadonlySet<string> = new Set(["desktop_app", "ios", "android", "harmonyos"]);

/** The `<version>` of a `Raft/<version>[+<build>]` User-Agent product, if it has one. */
export function raftVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  return userAgent?.match(RAFT_VERSION)?.[1];
}

/** requestClientPlatform, plus the App's or desktop app's version from its User-Agent. */
export function requestClient(platformHeader: string | undefined, userAgent: string | undefined): RequestClient {
  const platform = requestClientPlatform(platformHeader, userAgent);
  const raftVersion = VERSIONED_PLATFORMS.has(platform) ? raftVersionFromUserAgent(userAgent) : undefined;
  return raftVersion ? { platform, raftVersion } : { platform };
}

// `Raft/<version>[+<build>] (<system>[; <build type>])`: the native App's
// prefix (older iOS builds also put a device first: `(iPhone; iOS 18.1; release)`).
// Electron's `Raft/<version> Chrome/...` has no `(` after it.
const RAFT_APP = /(?:^|\s)Raft\/\d[0-9A-Za-z.-]{0,63}(?:\+([0-9A-Za-z.-]{1,64}))?\s+\(([^()]{1,128})\)/;
const APP_BUILD_TYPE = /^[a-z0-9_-]{1,32}$/;

function appPlatform(system: string): AnnouncementClientPlatform | null {
  if (system.startsWith("Android")) return "android";
  if (system.startsWith("iOS") || system.startsWith("iPadOS")) return "ios";
  if (system.startsWith("HarmonyOS") || system.startsWith("OpenHarmony")) return "harmonyos";
  return null;
}

/**
 * The native App build a request comes from, by its User-Agent alone (older
 * Apps send no `X-Raft-Client-Platform`), for announcement client targeting.
 * Only these coarse values leave this function; like the rest of this file,
 * the raw User-Agent is never stored, logged or traced. Web, desktop and
 * anything unrecognised is `null`; a build number or build type that is
 * missing or malformed is simply absent.
 */
export function parseRaftAppClient(userAgent: string | undefined): AnnouncementClient | null {
  const match = userAgent?.slice(0, 1024).match(RAFT_APP);
  if (!match) return null;
  const tokens = match[2].split(";").map((token) => token.trim());
  const systemIndex = tokens.findIndex((token) => appPlatform(token) !== null);
  // The system token comes before the build type; a lone `(release)` names no system.
  if (systemIndex < 0 || (tokens.length > 1 && systemIndex === tokens.length - 1)) return null;
  const client: AnnouncementClient = { platform: appPlatform(tokens[systemIndex])! };
  const buildNumber = match[1] && /^\d{1,15}$/.test(match[1]) ? Number(match[1]) : undefined;
  if (buildNumber !== undefined && Number.isSafeInteger(buildNumber)) client.buildNumber = buildNumber;
  const buildType = tokens.length > 1 ? tokens[tokens.length - 1].toLowerCase() : undefined;
  if (buildType && APP_BUILD_TYPE.test(buildType)) client.buildType = buildType;
  return client;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * `$account_age` (task #13): the account's age when the event happened, as a
 * coarse bucket. Lets usage split into new and long-standing accounts without
 * storing a signup date next to the analytics id.
 */
export function accountAgeBucket(createdAt: Date, at: Date): (typeof ACCOUNT_AGE_BUCKETS)[number] {
  const days = (at.getTime() - createdAt.getTime()) / DAY_MS;
  if (days < 8) return "0-7d";
  if (days < 31) return "8-30d";
  if (days < 91) return "31-90d";
  if (days < 366) return "91-365d";
  return "365d+";
}

let countryHeaderNoted = false;

// Once per process: whether CloudFront's country header reaches this server
// at all (Arkbriar verified prod's origin request policy; staging unchecked).
// Presence only, never the value.
function noteCountryHeader(present: boolean): void {
  if (countryHeaderNoted) return;
  countryHeaderNoted = true;
  console.info(`[product-events] CloudFront-Viewer-Country header ${present ? "present" : "absent"}`);
}

/** Test-only. */
export function resetProductEventContextForTest(): void {
  countryHeaderNoted = false;
}

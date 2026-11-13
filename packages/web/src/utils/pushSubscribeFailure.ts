// A Web Push subscribe that failed on this device although permission is
// granted (Brave with Google push services off, some Chromium forks, Firefox
// with push disabled, a server that refused the subscription). Remembered per
// device and signed-in person so the automatic re-subscribe does not retry,
// and re-log, on every focus and visibility change (Nova: ~68 failed events per
// affected person in a week); it tries again only once something changed.

import { WEB_APP_VERSION } from "./webAppVersion";
import { accessTokenSubject } from "./hostAccessTokenSync";

export const WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX = "raft.webPush.subscribeFailure.v1:";
/**
 * Retry an automatic re-subscribe that failed at most this often when nothing
 * else changed: a day when a browser known to refuse push refused it (it will
 * refuse again), an hour for what may be passing: the server, the network, or
 * Chrome/Edge/Chromium, whose FCM "AbortError: Registration failed - push
 * service error" is often transient.
 */
export const WEB_PUSH_AUTO_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const WEB_PUSH_AUTO_RETRY_TRANSIENT_BACKOFF_MS = 60 * 60 * 1000;
/** The server keeps 128 characters of `detail`; stay under it so nothing is cut mid-field. */
const MAX_DETAIL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 60;

/**
 * Where the subscribe stopped: no VAPID key from the server, no service
 * worker registration, `pushManager.subscribe` rejected (the browser or its
 * push service), the server refused POST /push/subscribe, or anything else.
 */
export type PushSubscribeFailureKind =
  | "vapid_unavailable"
  | "service_worker"
  | "push_subscribe"
  | "report"
  | "unexpected";

export type BrowserFamily =
  | "brave"
  | "edge"
  | "opera"
  | "samsung"
  | "vivaldi"
  | "chrome"
  | "chromium"
  | "firefox"
  | "safari"
  | "other";

export interface PushSubscribeFailure {
  kind: PushSubscribeFailureKind;
  errorName: string;
  errorMessage: string;
  browser: BrowserFamily;
  /** What the retry guard compares: any change means "try again". */
  permission: string;
  endpoint: string | null;
  appVersion: string;
  at: number;
}

type BrandedNavigator = Navigator & {
  brave?: unknown;
  userAgentData?: { brands?: Array<{ brand?: string }> };
};

/** A coarse browser family: no version, no OS, nothing that identifies a person. */
export function detectBrowserFamily(nav: BrandedNavigator | undefined = typeof navigator === "undefined" ? undefined : navigator): BrowserFamily {
  if (!nav) return "other";
  if (nav.brave) return "brave";
  const brands = (nav.userAgentData?.brands ?? []).map((entry) => (entry.brand ?? "").toLowerCase());
  if (brands.some((brand) => brand.includes("brave"))) return "brave";
  if (brands.some((brand) => brand.includes("edge"))) return "edge";
  if (brands.some((brand) => brand.includes("opera"))) return "opera";
  if (brands.some((brand) => brand.includes("vivaldi"))) return "vivaldi";
  if (brands.some((brand) => brand.includes("samsung"))) return "samsung";
  if (brands.some((brand) => brand === "google chrome")) return "chrome";
  const ua = nav.userAgent ?? "";
  if (/Edg(?:e|A|iOS)?\//.test(ua)) return "edge";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/Vivaldi\//.test(ua)) return "vivaldi";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (brands.some((brand) => brand === "chromium")) return "chromium";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/** Analytics tokens for the `detail` field, never shown to people. */
const GENERIC_ERROR_NAME = "Error";
const NON_ERROR_NAME = "Unknown";

function errorParts(err: unknown): { name: string; message: string } {
  if (err && typeof err === "object") {
    const { name, message } = err as { name?: unknown; message?: unknown };
    return {
      name: typeof name === "string" && name ? name : GENERIC_ERROR_NAME,
      message: typeof message === "string" ? message : "",
    };
  }
  return { name: typeof err === "string" ? GENERIC_ERROR_NAME : NON_ERROR_NAME, message: typeof err === "string" ? err : "" };
}

/** A short, PII-free message: URLs, e-mail addresses and long tokens removed, bounded. */
function scrubMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[^\s@]+@[^\s@]+/g, "<email>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<id>")
    .replace(/[;=]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || GENERIC_ERROR_NAME;
}

export function buildPushSubscribeFailure(input: {
  kind: PushSubscribeFailureKind;
  error?: unknown;
  permission: string;
  endpoint: string | null;
  now?: number;
}): PushSubscribeFailure {
  const { name, message } = input.error === undefined ? { name: "", message: "" } : errorParts(input.error);
  return {
    kind: input.kind,
    errorName: name ? safeName(name) : "",
    errorMessage: scrubMessage(message),
    browser: detectBrowserFamily(),
    permission: input.permission,
    endpoint: input.endpoint,
    appVersion: WEB_APP_VERSION,
    at: input.now ?? Date.now(),
  };
}

/** The prompt event's `detail`: `browser=brave;kind=push_subscribe;name=AbortError;msg=...`, under 128 characters. */
export function pushSubscribeFailureDetail(failure: PushSubscribeFailure): string {
  const parts = [`browser=${failure.browser}`, `kind=${failure.kind}`];
  if (failure.errorName) parts.push(`name=${failure.errorName}`);
  if (failure.errorMessage) parts.push(`msg=${failure.errorMessage}`);
  return parts.join(";").slice(0, MAX_DETAIL_LENGTH);
}

function storageKey(): string {
  let subject: string | null = null;
  try {
    subject = accessTokenSubject(window.localStorage.getItem("slock_access_token"));
  } catch {
    subject = null;
  }
  return `${WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX}${subject ?? "anonymous"}`;
}

// Only when storage refused the write (hardened/private browsing): still stops
// the loop for this tab. Never shadows what storage holds otherwise, so another
// tab's success (which clears storage) is seen here too.
let unsavedFailure: { key: string; failure: PushSubscribeFailure } | null = null;

function parseFailure(raw: string | null): PushSubscribeFailure | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PushSubscribeFailure;
    return parsed && typeof parsed === "object" && typeof parsed.kind === "string" && typeof parsed.at === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function readPushSubscribeFailure(): PushSubscribeFailure | null {
  const key = storageKey();
  if (unsavedFailure?.key === key) return unsavedFailure.failure;
  try {
    return parseFailure(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function rememberPushSubscribeFailure(failure: PushSubscribeFailure): void {
  const key = storageKey();
  try {
    window.localStorage.setItem(key, JSON.stringify(failure));
    unsavedFailure = null;
  } catch {
    unsavedFailure = { key, failure };
  }
}

export function clearPushSubscribeFailure(): void {
  const key = storageKey();
  unsavedFailure = null;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}

/**
 * Whether the automatic re-subscribe may run now: no failure remembered, or
 * something changed since (permission, the reported endpoint, the app
 * version), or the backoff has passed. An explicit Enable never asks.
 */
export function shouldAutoRetryPushSubscribe(current: { permission: string; endpoint: string | null; now?: number }): boolean {
  const failure = readPushSubscribeFailure();
  if (!failure) return true;
  const now = current.now ?? Date.now();
  const backoff = isBrowserPushRegistrationFailure(failure) && isKnownPushRefuser(failure.browser)
    ? WEB_PUSH_AUTO_RETRY_BACKOFF_MS
    : WEB_PUSH_AUTO_RETRY_TRANSIENT_BACKOFF_MS;
  return failure.permission !== current.permission
    || failure.endpoint !== current.endpoint
    || failure.appVersion !== WEB_APP_VERSION
    || now - failure.at >= backoff
    || now < failure.at;
}

/** Families whose push service is reliable enough that a refusal is likely transient. */
const RELIABLE_PUSH_FAMILIES: ReadonlySet<BrowserFamily> = new Set(["chrome", "edge", "chromium"]);

/** Brave, or a family other than Chrome/Edge/Chromium, where a refused subscribe means push is blocked. */
export function isKnownPushRefuser(browser: BrowserFamily): boolean {
  return !RELIABLE_PUSH_FAMILIES.has(browser);
}

/** A failure the browser itself caused (not the server): worth telling the person in Settings. */
export function isBrowserPushRegistrationFailure(failure: PushSubscribeFailure | null): boolean {
  return failure?.kind === "push_subscribe" || failure?.kind === "service_worker";
}

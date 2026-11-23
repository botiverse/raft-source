// A Web Push subscribe that failed on this device although permission is
// granted (Brave with Google push services off, some Chromium forks, Firefox
// with push disabled, a server that refused the subscription). Remembered per
// device and signed-in person so the automatic re-subscribe does not retry,
// and re-log, on every focus and visibility change (Nova: ~68 failed events per
// affected person in a week); it tries again only once something changed
// (permission, the reported endpoint, the signed-in person) or the backoff
// passed. The same failure again doubles the backoff (a streak per device and
// person). A new app version does not retry a failure the browser or its push
// service caused (`push_subscribe`): a release fixes no browser. For what our
// own code or server may cause (`report`, `vapid_unavailable`, `service_worker`
// (our /sw.js), `unexpected`) a new version shortens the wait to the 1 h base
// and starts a new streak; it still does not retry at once.

import { WEB_APP_VERSION } from "./webAppVersion";
import { accessTokenSubject } from "./hostAccessTokenSync";

export const WEB_PUSH_SUBSCRIBE_FAILURE_KEY_PREFIX = "raft.webPush.subscribeFailure.v1:";
/**
 * Retry an automatic re-subscribe that failed at most this often when nothing
 * else changed: a day when a browser known to refuse push refused it (it will
 * refuse again), an hour for what may be passing: the server, the network, or
 * Chrome/Edge/Chromium, whose FCM "AbortError: Registration failed - push
 * service error" is often transient. Each further failure of the same kind
 * doubles the wait (1 h, 2 h, 4 h, …), never beyond a day: an Edge tab left
 * open all day failed every hour (PR #15559).
 */
export const WEB_PUSH_AUTO_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const WEB_PUSH_AUTO_RETRY_TRANSIENT_BACKOFF_MS = 60 * 60 * 1000;
/** The server keeps 128 characters of `detail`; stay under it so nothing is cut mid-field. */
const MAX_DETAIL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 60;
const MAX_VERSION_LENGTH = 24;

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
  /** Diagnostics only (`v=` in `detail`): a new version does not retry. */
  appVersion: string;
  /** The latest failure's time. */
  at: number;
  /**
   * Consecutive failures of this kind and error on this device for this
   * person, the latest included (1, 2, 3, …); a success, another permission
   * or endpoint, or another kind of failure starts again at 1 (records
   * written before it existed read as 1).
   */
  streak: number;
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
    streak: 1,
  };
}

function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, MAX_VERSION_LENGTH) || "unknown";
}

function failureStreak(failure: PushSubscribeFailure): number {
  const streak = failure.streak;
  return typeof streak === "number" && Number.isFinite(streak) && streak >= 1 ? Math.floor(streak) : 1;
}

/** Appends `;key=value`, the value cut to what is left of the budget; nothing when not even one character fits. */
function appendBounded(detail: string, key: string, value: string): string {
  if (!value) return detail;
  const prefix = `${detail};${key}=`;
  const room = MAX_DETAIL_LENGTH - prefix.length;
  return room > 0 ? prefix + value.slice(0, room) : detail;
}

/**
 * The prompt event's `detail`, at most 120 characters (the server keeps 128):
 * `browser=brave;kind=push_subscribe;n=3;v=1.21.54;name=AbortError;msg=...`
 * (`n` the consecutive failure count, `v` the web app version). `browser`,
 * `kind`, `n` and `v` are bounded and always whole; `name` and then `msg`
 * get what is left, `msg` cut first.
 */
export function pushSubscribeFailureDetail(failure: PushSubscribeFailure): string {
  const head = [
    `browser=${failure.browser}`,
    `kind=${failure.kind}`,
    `n=${failureStreak(failure)}`,
    `v=${safeVersion(failure.appVersion ?? "")}`,
  ].join(";");
  return appendBounded(appendBounded(head, "name", failure.errorName), "msg", failure.errorMessage);
}

/**
 * `detail` for a failure event that has no failure of its own to describe:
 * the automatic re-subscribe found permission no longer granted mid-way
 * (`result` default/denied/unsupported). Never an empty `detail`.
 */
export function pushSubscribeOutcomeDetail(result: string): string {
  const outcome = result.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || "unknown";
  return [
    `browser=${detectBrowserFamily()}`,
    `kind=no_failure_record`,
    `result=${outcome}`,
    `v=${safeVersion(WEB_APP_VERSION)}`,
  ].join(";").slice(0, MAX_DETAIL_LENGTH);
}

/**
 * A failure event's `detail`: this attempt's own failure (as stored, with its
 * streak), never one re-read from storage, which another tab's success may
 * have cleared meanwhile (rows without `detail`, PR #15559); else what the
 * result was.
 */
export function subscriptionFailedDetail(failure: PushSubscribeFailure | null, result: string): string {
  return failure ? pushSubscribeFailureDetail(failure) : pushSubscribeOutcomeDetail(result);
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
      ? { ...parsed, streak: failureStreak(parsed) }
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

/**
 * Failures our own code or server may cause, which a new web app version can
 * fix: a version change shortens the wait to the base and starts a new streak.
 * `push_subscribe` (the browser or its push service refused) is not here.
 */
const VERSION_SENSITIVE_KINDS: ReadonlySet<PushSubscribeFailureKind> = new Set([
  "report",
  "vapid_unavailable",
  "service_worker",
  "unexpected",
]);

function isVersionSensitive(failure: PushSubscribeFailure): boolean {
  return VERSION_SENSITIVE_KINDS.has(failure.kind);
}

/** The same failure again: same kind and error, same permission and endpoint (and version, where it matters). */
function continuesStreak(previous: PushSubscribeFailure, next: PushSubscribeFailure): boolean {
  return previous.kind === next.kind
    && (previous.errorName ?? "") === next.errorName
    && previous.permission === next.permission
    && (previous.endpoint ?? null) === next.endpoint
    && (!isVersionSensitive(next) || previous.appVersion === next.appVersion);
}

/**
 * Stores a failure for this device and person, counting it into the streak of
 * the one before when it is the same failure again. Returns what was stored.
 */
export function rememberPushSubscribeFailure(failure: PushSubscribeFailure): PushSubscribeFailure {
  const previous = readPushSubscribeFailure();
  const stored: PushSubscribeFailure = {
    ...failure,
    streak: previous && continuesStreak(previous, failure) ? failureStreak(previous) + 1 : 1,
  };
  const key = storageKey();
  try {
    window.localStorage.setItem(key, JSON.stringify(stored));
    unsavedFailure = null;
  } catch {
    unsavedFailure = { key, failure: stored };
  }
  return stored;
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
 * How long the automatic re-subscribe waits after this failure: a day for a
 * browser known to refuse push, else an hour doubled for each consecutive
 * failure before it (1 h, 2 h, 4 h, …), at most a day. A failure our own code
 * may cause, recorded by another web app version than this one: the 1 h base.
 */
export function pushSubscribeRetryBackoffMs(failure: PushSubscribeFailure): number {
  if (isVersionSensitive(failure) && failure.appVersion !== WEB_APP_VERSION) return WEB_PUSH_AUTO_RETRY_TRANSIENT_BACKOFF_MS;
  if (isBrowserPushRegistrationFailure(failure) && isKnownPushRefuser(failure.browser)) return WEB_PUSH_AUTO_RETRY_BACKOFF_MS;
  // 2^5 h already passes a day; keeps the power small for any stored streak.
  const doublings = Math.min(failureStreak(failure) - 1, 5);
  return Math.min(WEB_PUSH_AUTO_RETRY_TRANSIENT_BACKOFF_MS * 2 ** doublings, WEB_PUSH_AUTO_RETRY_BACKOFF_MS);
}

/**
 * Whether the automatic re-subscribe may run now: no failure remembered, or
 * something changed since (permission, the reported endpoint; another person
 * has their own record), or the backoff has passed. A new app version alone
 * never retries at once; for a failure our own code may cause it shortens the
 * backoff to the 1 h base (pushSubscribeRetryBackoffMs). An explicit Enable
 * never asks.
 */
export function shouldAutoRetryPushSubscribe(current: { permission: string; endpoint: string | null; now?: number }): boolean {
  const failure = readPushSubscribeFailure();
  if (!failure) return true;
  const now = current.now ?? Date.now();
  return failure.permission !== current.permission
    || failure.endpoint !== current.endpoint
    || now - failure.at >= pushSubscribeRetryBackoffMs(failure)
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

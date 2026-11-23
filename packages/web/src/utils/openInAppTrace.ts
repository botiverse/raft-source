/**
 * slock.open_in_app — what happens to the offer to open a Raft link in the
 * app (#proj-mobile:#128). `deep_links_v1` is on for everyone since 11-13
 * (xxchan), and until now nothing said whether the hand-over works: how often
 * the offer shows, how often people take it, and whether the app then
 * actually took over.
 *
 * Signed-in people only. The web's events go out with a signed-in session's
 * server and credentials (webAuthTrace), so a signed-out person's would be
 * dropped on the way: nothing is reported for them (the sign-in page's offer,
 * a link opened before signing in). Counting those needs a path of its own.
 *
 * Steps (one event each):
 *   offered      the offer is on screen (once per landed page)
 *   open         Open in the app / Open in desktop app was clicked; sent at
 *                once (keepalive): a phone's Open may navigate away right after
 *   handed_over  within HAND_OVER_MS of `open` the page lost focus or was
 *                hidden: the app (or, on a computer, the browser's own "Open
 *                Raft Desktop?" prompt) came to the front. Sent at once, as
 *                the page goes. At most one per `attempt`
 *   not_handed   `open`, and the page kept focus for HAND_OVER_MS: most
 *                likely no app took the link
 *   app_missing  a phone came back with `app=missing` (open.raft.build found
 *                no app) and the "not installed" sheet showed. Its `attempt`
 *                is the Open's: that Open went to open.raft.build, so its
 *                `handed_over` (the page left) is not a hand-over
 *   download     a download link in the offer was clicked
 *   stay         Continue on web, or the offer was dismissed
 *
 * Fields (closed sets; no person, server, conversation or message id, no
 * URL):
 *   surface      desktop_banner | phone_row | phone_sheet
 *   platform     mac | windows | linux | ios | android | other
 *   link         channel | message | dm | thread | task | artifact | other
 *   attempt      open, handed_over, not_handed, app_missing: a random id per
 *                Open, kept in this tab's sessionStorage until the page comes
 *                back with `app=missing`; it ties one Open's events together
 *                and stands for no person or address
 *   phase        download only: offer (before Open) | opening (after Open:
 *                "Nothing happened? Download")
 *   remembered   open/stay on desktop: always false since 2026-11-17 (nothing
 *                is remembered any more); kept so the report's fields don't change
 *
 * Consumer: @AndyLok's report (offered → open → handed_over without an
 * app_missing of the same attempt, by surface and platform); registered in
 * packages/shared traceFamilyRegistry.
 */
import { emitWebEvent, emitWebEventAndFlushBeforeUnload } from "./webAuthTrace";

const OPEN_IN_APP = "slock.open_in_app" as const;

/** How long after Open the page may lose focus for the app to count as having taken the link. */
export const HAND_OVER_MS = 5000;

/** Where an Open's attempt waits for the page to come back with `app=missing` (this tab only). */
export const OPEN_IN_APP_ATTEMPT_KEY = "raft:open-in-app:attempt";

export type OpenInAppStep = "offered" | "open" | "handed_over" | "not_handed" | "app_missing" | "download" | "stay";
export type OpenInAppSurface = "desktop_banner" | "phone_row" | "phone_sheet";
export type OpenInAppPlatform = "mac" | "windows" | "linux" | "ios" | "android" | "other";
export type OpenInAppLink = "channel" | "message" | "dm" | "thread" | "task" | "artifact" | "other";

export interface OpenInAppContext {
  surface: OpenInAppSurface;
  link: OpenInAppLink;
  signedIn: boolean;
}

/** `urgent`: sent at once with keepalive (the page may be leaving), else queued with the rest. */
type Emitter = (name: typeof OPEN_IN_APP, attrs: Record<string, unknown>, urgent: boolean) => void;
const send: Emitter = (name, attrs, urgent) => {
  if (urgent) void emitWebEventAndFlushBeforeUnload(name, attrs);
  else emitWebEvent(name, attrs);
};
let emitter: Emitter = send;

/** Test seam. */
export function __setOpenInAppEmitterForTest(next: Emitter | null): void {
  emitter = next ?? send;
}

/** The platform by the browser's user agent, coarse. */
export function openInAppPlatformOf(userAgent: string): OpenInAppPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Linux|X11|CrOS/i.test(userAgent)) return "linux";
  return "other";
}

/**
 * What kind of Raft address a landed page is, by its path and query only: a
 * message (`?msg=`), a thread, a task, a DM, a channel, an Artifact (its share
 * link, or one open in a server's Artifacts), else other.
 */
export function openInAppLinkOf(pathname: string, search: string): OpenInAppLink {
  const params = new URLSearchParams(search);
  if (/^\/artifacts\//.test(pathname) || (/^\/s\/[^/]+\/artifacts\/?$/.test(pathname) && params.has("artifact"))) return "artifact";
  if (!/^\/s\/[^/]+\//.test(pathname)) return "other";
  if (params.has("msg")) return "message";
  if (/\/thread\//.test(pathname) || params.has("thread")) return "thread";
  if (/\/tasks?\//.test(pathname) || params.has("task")) return "task";
  if (/^\/s\/[^/]+\/dm\//.test(pathname)) return "dm";
  if (/^\/s\/[^/]+\/channel\//.test(pathname)) return "channel";
  return "other";
}

function emit(step: OpenInAppStep, context: OpenInAppContext, extra: Record<string, unknown> = {}, urgent = false): void {
  // Signed out it would be dropped on the way (the file's header): not sent at all.
  if (!context.signedIn) return;
  try {
    emitter(OPEN_IN_APP, {
      step,
      surface: context.surface,
      platform: openInAppPlatformOf(typeof navigator === "undefined" ? "" : navigator.userAgent),
      link: context.link,
      ...extra,
    }, urgent);
  } catch {
    // Reporting must never affect the offer.
  }
}

function newAttempt(): string {
  const attempt = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(OPEN_IN_APP_ATTEMPT_KEY, attempt);
  } catch {
    // No storage: the attempt still ties this page's events together.
  }
  return attempt;
}

/** The attempt of the Open that sent this page to open.raft.build, taken once. */
function takeAttempt(): string | null {
  try {
    const attempt = window.sessionStorage.getItem(OPEN_IN_APP_ATTEMPT_KEY);
    window.sessionStorage.removeItem(OPEN_IN_APP_ATTEMPT_KEY);
    return attempt;
  } catch {
    return null;
  }
}

/**
 * A step reported once for one offer on screen (the row's or the banner's `offered`, the sheet's `app_missing`),
 * counted as reported only when it was actually sent. Signed out nothing is sent (the file's header), and on a cold
 * start the signed-in person's account loads after the offer first shows: the call made then reports it, not the
 * earlier one that sent nothing. One per offer (the component keeps it for the landed page).
 */
export function reportOncePerOffer(report: (context: OpenInAppContext) => void): (context: OpenInAppContext) => void {
  let sent = false;
  return (context) => {
    if (sent || !context.signedIn) return;
    sent = true;
    report(context);
  };
}

export function reportOpenInAppOffered(context: OpenInAppContext): void {
  emit("offered", context);
}

export function reportOpenInAppStay(context: OpenInAppContext): void {
  emit("stay", context, context.surface === "desktop_banner" ? { remembered: false } : {});
}

export function reportOpenInAppMissing(context: OpenInAppContext): void {
  const attempt = typeof window === "undefined" ? null : takeAttempt();
  emit("app_missing", context, attempt ? { attempt } : {});
}

export function reportOpenInAppDownload(context: OpenInAppContext, phase: "offer" | "opening"): void {
  emit("download", context, { phase });
}

/** The one hand-over being watched: a later Open replaces it, without a word for the earlier one. */
let stopWatching: (() => void) | null = null;

/** Test seam: drop a hand-over still being watched. */
export function __resetOpenInAppWatchForTest(): void {
  stopWatching?.();
}

/**
 * `open`, then whether the app took over: `handed_over` as soon as the page
 * loses focus or is hidden within HAND_OVER_MS, else `not_handed`. Exactly one
 * of the two, once, for the latest Open only; the listeners go either way.
 * Both `open` and `handed_over` are sent at once: the page may be leaving.
 */
export function reportOpenInAppOpen(context: OpenInAppContext): void {
  // `remembered` is always false since nothing is remembered (2026-11-17); kept for the report's fields.
  const remembered = context.surface === "desktop_banner" ? { remembered: false } : {};
  if (!context.signedIn || typeof window === "undefined" || typeof document === "undefined") {
    emit("open", context, remembered, true);
    return;
  }
  const attempt = newAttempt();
  emit("open", context, { attempt, ...remembered }, true);
  stopWatching?.();
  let settled = false;
  const stop = () => {
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    if (stopWatching === stop) stopWatching = null;
  };
  const settle = (step: "handed_over" | "not_handed") => {
    if (settled) return;
    stop();
    emit(step, context, { attempt }, step === "handed_over");
  };
  const onBlur = () => settle("handed_over");
  const onVisibility = () => {
    if (document.visibilityState === "hidden") settle("handed_over");
  };
  const timer = window.setTimeout(() => settle("not_handed"), HAND_OVER_MS);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  stopWatching = stop;
}

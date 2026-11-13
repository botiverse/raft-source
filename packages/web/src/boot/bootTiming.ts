/**
 * slock.web.boot_timing — how long a page load took to each boot milestone,
 * one event per load (task #3 in #proj-frontend; consumer: AndyLok's daily app
 * report, registered in packages/shared traceFamilyRegistry).
 *
 * Fields (closed sets or milliseconds since navigation start; a milestone not
 * reached is null, never 0):
 *   landing            channel / dm / thread / message / root / other — what the URL opened
 *   bundle_ms          the app's script started running (after the HTML and the startup chunks)
 *   auth_sent_ms       GET /auth/me went out (after a token refresh, when there was one)
 *   auth_ms            the signed-in user loaded
 *   servers_ms         the server list loaded
 *   frame_ms           the server's layout (MainLayout) mounted
 *   messages_sent_ms   the page load's first conversation window was asked for (latest
 *                      page, remembered scroll position or linked message)
 *   messages_ms        that window loaded (or failed), before it is put on screen
 *   content_ms         the landed conversation's messages showed (frame_ms for other landings)
 *   fcp_ms             first contentful paint (the boot shell)
 *   token_refreshed_first  the stored token had expired and was refreshed before /auth/me
 *   nav_type           navigate / reload / back_forward / prerender
 *   outcome            rendered / hidden (the tab went to the background first) /
 *                      unloaded (left first) / timeout (60 s without content);
 *                      hidden and unloaded go out on the urgent path, the page
 *                      may be going away
 *   started_hidden     the load began in a background tab (throttled timings)
 *   browser_family     coarse UA bucket (shared with the auth boot trace)
 *   form_factor        phone (a viewport under 768 px wide, the app's phone layout) / computer
 *   platform           desktop_app / pwa / browser (as X-Raft-Client-Platform)
 *   ui_locale          the UI language code the app resolved
 * releaseSha and the tab id come with every web event.
 *
 * content_ms is the first conversation page that settles, whichever channel it
 * is (a switch before the landing page arrives measures the new one) and
 * also when that load failed; for root and other landings it is frame_ms, so
 * those rows are not comparable to conversation landings.
 *
 * Deliberately NOT recorded: URLs, ids of servers, channels or messages.
 */

import { authBootBrowserBucketFromUserAgent, emitWebEvent, emitWebEventAndFlushBeforeUnload } from "../utils/webAuthTrace";
import type { BootTimingTraceEventName } from "../utils/webAuthTrace";
import { clientPlatformHint } from "../utils/clientPlatformHint";

const BOOT_TIMING: BootTimingTraceEventName = "slock.web.boot_timing";
const BOOT_TIMEOUT_MS = 60_000;

export type BootLanding = "channel" | "dm" | "thread" | "message" | "root" | "other";
export type BootMilestone = "auth_sent" | "auth" | "servers" | "frame" | "messages_sent" | "messages" | "content";
type BootOutcome = "rendered" | "hidden" | "unloaded" | "timeout";

type Emitter = (name: BootTimingTraceEventName, attrs: Record<string, unknown>, urgent: boolean) => void;

const defaultEmitter: Emitter = (name, attrs, urgent) => {
  if (urgent) void emitWebEventAndFlushBeforeUnload(name, attrs);
  else emitWebEvent(name, attrs);
};

let emitter: Emitter = defaultEmitter;
let startedHidden = false;
let detachListeners: () => void = () => {};
let landing: BootLanding = "other";
let milestones: Partial<Record<BootMilestone, number>> = {};
let bundleMs: number | null = null;
let tokenRefreshedFirst = false;
let reported = false;
let started = false;

/** What a URL opens, as the boot sees it. */
export function bootLandingOf(pathname: string, search: string): BootLanding {
  if (pathname === "/") return "root";
  const match = /^\/s\/[^/]+\/(channel|dm)\/[^/?#]+\/?$/.exec(pathname);
  if (!match) return "other";
  const params = new URLSearchParams(search);
  if (params.has("thread")) return "thread";
  if (params.has("msg")) return "message";
  return match[1] === "dm" ? "dm" : "channel";
}

function landsOnConversation(): boolean {
  return landing === "channel" || landing === "dm" || landing === "thread" || landing === "message";
}

function now(): number {
  return Math.round(performance.now());
}

function navType(): string | null {
  const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type ?? null;
}

/** The app's phone layout starts below 768 px (hooks/useMobileNav). */
function formFactor(): "phone" | "computer" {
  return window.matchMedia?.("(max-width: 767px)").matches ? "phone" : "computer";
}

function fcp(): number | null {
  const entry = performance.getEntriesByName?.("first-contentful-paint")[0];
  return entry ? Math.round(entry.startTime) : null;
}

function report(outcome: BootOutcome): void {
  if (reported) return;
  reported = true;
  detachListeners();
  try {
    emitter(BOOT_TIMING, {
      landing,
      bundle_ms: bundleMs,
      auth_sent_ms: milestones.auth_sent ?? null,
      auth_ms: milestones.auth ?? null,
      servers_ms: milestones.servers ?? null,
      frame_ms: milestones.frame ?? null,
      messages_sent_ms: milestones.messages_sent ?? null,
      messages_ms: milestones.messages ?? null,
      content_ms: milestones.content ?? null,
      fcp_ms: fcp(),
      token_refreshed_first: tokenRefreshedFirst,
      nav_type: navType(),
      outcome,
      browser_family: authBootBrowserBucketFromUserAgent(typeof navigator === "undefined" ? null : navigator.userAgent),
      form_factor: formFactor(),
      platform: clientPlatformHint(),
      ui_locale: document.documentElement.lang || null,
      started_hidden: startedHidden,
    }, outcome === "hidden" || outcome === "unloaded");
  } catch {
    // Telemetry must never affect the boot.
  }
}

/** At module start (main.tsx): what this load opens, and the reports for leaving before content. */
export function startBootTiming(location: Pick<Location, "pathname" | "search"> = window.location): void {
  if (started) return;
  started = true;
  bundleMs = now();
  landing = bootLandingOf(location.pathname, location.search);
  startedHidden = document.visibilityState === "hidden";
  // Every change, not only the first: a tab opened in the background turns
  // visible first, and may still go back before its content.
  const onVisibility = () => {
    if (document.visibilityState === "hidden") report("hidden");
  };
  const onPageHide = () => report("unloaded");
  const timer = setTimeout(() => report("timeout"), BOOT_TIMEOUT_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  detachListeners = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    clearTimeout(timer);
  };
}

/** A boot milestone was reached; the first time counts. Content reports the load. */
export function markBootMilestone(milestone: BootMilestone): void {
  if (!started || reported || milestones[milestone] !== undefined) return;
  milestones[milestone] = now();
  if (milestone === "frame" && !landsOnConversation()) milestones.content = milestones.frame;
  if (milestones.content !== undefined) report("rendered");
}

/** Whether this load's event has gone out (main.tsx stops watching for content then). */
export function isBootTimingReported(): boolean {
  return reported;
}

/** The stored token had expired and was refreshed before /auth/me (authStore). */
export function markBootTokenRefreshedFirst(): void {
  tokenRefreshedFirst = true;
}

/** Test seam. */
export function __resetBootTimingForTest(next: Emitter | null = null): void {
  detachListeners();
  detachListeners = () => {};
  emitter = next ?? defaultEmitter;
  startedHidden = false;
  landing = "other";
  milestones = {};
  bundleMs = null;
  tokenRefreshedFirst = false;
  reported = false;
  started = false;
}

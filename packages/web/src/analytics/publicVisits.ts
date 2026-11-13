// Public Server visit counts (RFC-067 registry: public_page_viewed,
// public_page_channel_opened, public_page_thread_opened). Not a product-event batch: the server records these
// for logged-out visitors too and decides who the visitor is
// (packages/server/src/services/publicVisitCounts.ts). Fire-and-forget; the
// endpoint always answers 204 and nothing here is retried.

import { campaignToken, referrerHostname } from "@botiverse/raft-shared";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import { publicVisitorId } from "./publicVisitorConsent";
import { createPrivacyHold } from "../utils/webTelemetryPrivacyHold";

const TOKEN_KEY = "slock_access_token";

export type PublicVisitEvent = "public_page_viewed" | "public_page_channel_opened" | "public_page_thread_opened";

type FetchLike = (input: string, init?: RequestInit) => Promise<unknown>;
let fetchOverride: FetchLike | null = null;

interface LandingPage {
  pathname: string;
  search: string;
  referrer: string;
}

// How this tab arrived, read once at startup before the router moves the URL.
// document.referrer never changes on in-app navigation, so it only describes
// the page the tab opened on.
let landingPage: LandingPage | null = null;
let landingViewRecorded = false;

/** Call once from main.tsx, before the first render. */
export function captureLandingPage(): void {
  if (landingPage || typeof window === "undefined") return;
  landingPage = {
    pathname: window.location.pathname,
    search: window.location.search,
    referrer: globalThis.document?.referrer ?? "",
  };
}

type VisitSource = Record<string, string>;

/**
 * Where a view came from (cindyz, 2026-10-14). Only the first view of the
 * server the tab opened on is a `landing` and carries the referring host name
 * and utm_* of the link; any other view was reached inside the app. Nothing
 * at all when the landing page is unknown (not captured, e.g. in tests).
 */
function viewSource(slug: string): VisitSource {
  if (!landingPage) return {};
  const landedSlug = /^\/s\/([^/]+)/.exec(landingPage.pathname)?.[1];
  let landedHere = false;
  try {
    landedHere = !landingViewRecorded && landedSlug !== undefined && decodeURIComponent(landedSlug) === slug;
  } catch {
    landedHere = false;
  }
  if (!landedHere) return { entry: "in_app" };
  landingViewRecorded = true;
  const params = new URLSearchParams(landingPage.search);
  const source: VisitSource = { entry: "landing" };
  const host = referrerHostname(landingPage.referrer);
  if (host) source.referrer_domain = host;
  for (const key of ["utm_source", "utm_medium", "utm_campaign"]) {
    const token = campaignToken(params.get(key));
    if (token) source[key] = token;
  }
  return source;
}

/**
 * Call once per successfully shown page (`public_page_viewed`), channel the
 * visitor picked (`public_page_channel_opened`) or thread they opened
 * (`public_page_thread_opened`, with its parent channel), never per API request.
 * Nothing under RAFT_PRIVACY_MODE; held in memory until the client config
 * says whether it is on (store/privacyMode.ts), then sent or dropped.
 */
export function recordPublicVisit(
  slug: string,
  event: PublicVisitEvent,
  channelId?: string,
  threadChannelId?: string,
): void {
  // A signed-in visitor's token lets the server tell members from
  // non-members; the client never claims either.
  const token = globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  const send = fetchOverride ?? ((input: string, init?: RequestInit) => fetch(input, init));
  // Built now, in call order: only the first view can be the landing.
  const source = event === "public_page_viewed" ? viewSource(slug) : {};
  // Logged out and after cookie consent only (publicVisitorConsent.ts); a
  // signed-in visitor is linked to an account only by joining.
  const anonymousId = token ? null : publicVisitorId();
  const post = () => void Promise.resolve()
    .then(() => send(`${RUNTIME_API_BASE}/public-visits/${encodeURIComponent(slug)}`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        uuid: crypto.randomUUID(),
        event,
        ...(channelId ? { channel_id: channelId } : {}),
        ...(threadChannelId ? { thread_channel_id: threadChannelId } : {}),
        ...source,
        ...(anonymousId ? { anonymous_id: anonymousId } : {}),
      }),
    }))
    .catch(() => undefined);
  void visitHold.send(post);
}

// Visits recorded before the privacy-mode answer (up to 20): built then, so a
// landing keeps its referrer; sent on "off", dropped on "on".
const visitHold = createPrivacyHold(20, (post: () => void) => post());

/** Test-only: capture visits instead of sending them. */
export function setPublicVisitFetchForTest(fetchImpl: FetchLike | null): void {
  fetchOverride = fetchImpl;
}

/** Test-only: pretend the tab opened on this page (null: unknown). */
export function setLandingPageForTest(page: LandingPage | null): void {
  landingPage = page;
  landingViewRecorded = false;
}

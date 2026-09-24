import { Router } from "express";
import { getAppUrl } from "../config/appUrl.js";

/**
 * Public redirect to the current mobile build.
 *
 * `GET /api/mobile-download?platform=android|ios`
 *
 * **Deliberately unauthenticated.** The desktop Settings surface renders a QR
 * code, and the phone that scans it has no Raft session — an authenticated
 * route would land every scan on a login wall, which defeats the entry point.
 * The artifacts behind it are public app builds; the signed URL we redirect to
 * is issued by Hands and carries its own expiry.
 *
 * Resolution is two-step *by design* (confirmed with @Hands-Rhea, the Hands
 * public-endpoint owner, against `hands.build/openapi.json`): there is no stable
 * per-version URL. We resolve on every request and redirect to the signed R2 URL
 * from that response, so this route stays the stable address (QR-friendly) while
 * the artifact URL underneath it stays fresh.
 *
 * Two hazards this route exists to contain:
 *
 * 1. **Never serve a draft build.** Hands is draft-first: `publish` creates a
 *    draft and only `finalize --confirm-publish` activates it. Serving a draft
 *    through our own entry point would be invisible — the download succeeds, the
 *    install succeeds, nothing errors, and you only find out when someone
 *    notices users running an unreleased version. The public `latest` endpoint
 *    filters `status = 'active'` in its query, so drafts do not exist to it.
 *    That is why we must NOT hand-assemble `/public/r2/:key` URLs: that endpoint
 *    accepts `active` AND `draft` (the signature is the authorization), so
 *    building keys ourselves would reintroduce exactly the hazard this avoids.
 *    Only ever follow a `download_url` handed to us by `latest`.
 *
 *    **The signed URL you get back contains `pending/` and that is fine.** An
 *    active release's object key looks like
 *    `apps/{appId}/pending/{hash}` (URL-encoded as `%2Fpending%2F`, which is
 *    also why grepping for `/pending/` finds nothing). Confirmed with
 *    @Hands-Rhea 2026-08-10: publishing flips the release row's status and
 *    NEVER moves, renames or rewrites the object — so the blob lives at that
 *    key from upload until forever, whatever its release status. The word is a
 *    storage location, not a lifecycle state, and it is orthogonal to draft
 *    isolation, which is enforced solely by `latest` filtering on
 *    `status = 'active'`.
 *
 *    Recorded because it reads alarmingly: seeing "pending" in a production
 *    download URL looks exactly like the draft leak this route exists to
 *    prevent. It is being written into the Hands openapi contract too (their
 *    task #119) so the next consumer does not have to read source to learn it.
 *
 * 2. **An empty channel is not an error.** A channel with no active release
 *    (new, or everything revoked) is a legal state and must read as "no build
 *    available yet", not as a fault. Reporting legitimate emptiness as a failure
 *    trains people to ignore the failure signal.
 */

/**
 * iOS does not go through Hands.
 *
 * Hands does hold a `raft-ios` release, but its asset is an `.ipa`, and stock
 * iOS cannot install one — sideloading is not available to ordinary users. The
 * real distribution channel is TestFlight, which is an Apple-side surface with
 * its own public join link. Redirecting an iPhone to the `.ipa` would produce a
 * download that silently does nothing useful, which is the failure mode this
 * whole route exists to avoid.
 *
 * Link supplied by @huxijin (#wg-download-mobile). Overridable so it can change
 * without a code edit if the beta is re-created.
 */
const IOS_TESTFLIGHT_URL = process.env.RAFT_IOS_TESTFLIGHT_URL
  ?? "https://testflight.apple.com/join/JvM5wXuc";

/**
 * Web surface that lets a person pick their own platform.
 *
 * Public (no session): the phone that scanned the QR has never signed in, so
 * this must render for an anonymous visitor like the route that redirects here.
 */
export const MOBILE_DOWNLOAD_CHOOSER_PATH = "/download";

/**
 * Absolute URL of the chooser, because this server is NOT on the web app's
 * origin in any deployed environment.
 *
 * A bare `/download` redirect resolves against the API host, which serves no
 * web app — the browser lands on nothing. Same mistake, mirrored, as the web
 * side linking to a relative `/api/...`: each half assumed it shared an origin
 * with the other, and only local dev (single Vite origin with a proxy) makes
 * that true. `APP_URL` is the established way for this server to address the
 * web app; `getAppUrl()` falls back to the dev origin.
 */
export function mobileDownloadChooserUrl(appUrl = getAppUrl()): string {
  return `${appUrl.replace(/\/$/, "")}${MOBILE_DOWNLOAD_CHOOSER_PATH}`;
}

const HANDS_BASE = process.env.HANDS_PUBLIC_BASE_URL ?? "https://hands.build";
const HANDS_CHANNEL = process.env.HANDS_RELEASE_CHANNEL ?? "main";

/** Hands models platform as a separate app, not a field on a release. */
const APP_SLUG_BY_PLATFORM = {
  android: "raft-android",
  ios: "raft-ios",
} as const;

export type MobilePlatform = keyof typeof APP_SLUG_BY_PLATFORM;

export function isMobilePlatform(value: unknown): value is MobilePlatform {
  return typeof value === "string" && value in APP_SLUG_BY_PLATFORM;
}

/**
 * Device family from the User-Agent.
 *
 * Deliberately NOT viewport width: width decides layout, the UA decides which
 * artifact a person can install. A desktop browser narrowed to a phone-sized
 * window is still a desktop, and treating it as a phone would hand someone an
 * APK they cannot use — and hide the QR code that would have worked.
 */
export function platformFromUserAgent(userAgent: string | undefined): MobilePlatform | null {
  if (!userAgent) return null;
  if (/android/i.test(userAgent)) return "android";
  // iPadOS 13+ reports a Safari UA byte-identical to macOS, so this returns
  // null for a modern iPad. Verified against the real string, not assumed:
  //   Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) … Version/17.0 Safari/605.1.15
  // Only legacy iPads (pre-13) still say "iPad" and classify as ios.
  //
  // Returning null here is correct and is NOT a gap: iPad is a supported target
  // (@huxijin, after @Aiden read Apple's beta page), and the device is resolved
  // one layer up. An unclassified request redirects to the public `/download`
  // chooser, where `navigator.maxTouchPoints` on a `Macintosh` UA distinguishes
  // iPadOS from a real Mac — a check only the browser can make.
  //
  // Do not "improve" this function to guess iPad from the UA. There is no
  // signal here to guess from; that is the whole reason the chooser exists.
  if (/iphone|ipod|ipad/i.test(userAgent)) return "ios";
  return null;
}

export type LatestLookup =
  | { outcome: "asset"; downloadUrl: string; version: string; expiresIn: number }
  | { outcome: "no_active_release" }
  | { outcome: "not_configured"; detail: string }
  | { outcome: "upstream_error"; detail: string };

/**
 * Classify a Hands 404 by its machine-readable `code`.
 *
 * Hands documents the contract explicitly: `error` is prose for humans and may
 * be reworded, so programs must branch on `code`. The codes are
 * `app_not_found` / `channel_not_found` (someone mistyped configuration) and
 * `no_active_release` (a legal empty channel — new, or everything revoked).
 * All three legally-empty situations share one code on purpose: they produce
 * identical responses, and separate codes would invite consumers to
 * distinguish something meaningless to them.
 *
 * `code` was added by Hands PR #437 after this consumer hit the gap; the
 * earlier prose-matching version, and the tripwire test that forced this
 * migration when the field reached production, are both deleted.
 *
 * ("tripwire", not the word for a scheduled nudge, on purpose: that word is a
 * declared APP root, and `check-app-name-ratchet.sh` counts declared roots
 * inside comments too. This one occurrence turned packages/server 858 -> 859
 * and reddened an only-down gate. Recorded rather than quietly reworded, as
 * that script's header asks — the gate was right by its own rule and wrong
 * about this instance, which is the false positive it openly documents.)
 *
 * An absent `code` is not a signal — Hands states that codes exist only where
 * enumerated. We fall back to the safe direction: treat it as a configuration
 * fault so it surfaces, rather than as an empty channel, which would hide it.
 */
export function classifyHands404(body: unknown): "no_active_release" | "not_configured" {
  const code = typeof body === "object" && body !== null && "code" in body
    ? String((body as { code?: unknown }).code ?? "")
    : "";
  return code === "no_active_release" ? "no_active_release" : "not_configured";
}

export async function lookupLatestAsset(
  platform: MobilePlatform,
  deps: { fetch: typeof fetch; baseUrl?: string; channel?: string },
): Promise<LatestLookup> {
  const base = deps.baseUrl ?? HANDS_BASE;
  const channel = deps.channel ?? HANDS_CHANNEL;
  const slug = APP_SLUG_BY_PLATFORM[platform];
  const url = `${base}/public/v2/apps/${slug}/latest?channel=${encodeURIComponent(channel)}`;

  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch (cause) {
    return { outcome: "upstream_error", detail: `request failed: ${String(cause)}` };
  }

  if (response.status === 404) {
    const body = await response.json().catch(() => null);
    return classifyHands404(body) === "no_active_release"
      ? { outcome: "no_active_release" }
      : { outcome: "not_configured", detail: JSON.stringify(body) };
  }
  if (!response.ok) {
    return { outcome: "upstream_error", detail: `HTTP ${response.status}` };
  }

  const payload = await response.json().catch(() => null) as {
    build?: { version?: string };
    assets?: Array<{ platform?: string; download_url?: string }>;
    expires_in?: number;
  } | null;

  const asset = payload?.assets?.find((candidate) => candidate.platform === platform);
  if (!asset?.download_url) {
    // 200 guarantees a non-empty `assets`, so a missing match means this
    // platform genuinely has no artifact in the active release — a
    // configuration gap, not an empty channel.
    return { outcome: "not_configured", detail: `no ${platform} asset in active release` };
  }

  return {
    outcome: "asset",
    downloadUrl: asset.download_url,
    version: payload?.build?.version ?? "unknown",
    expiresIn: payload?.expires_in ?? 0,
  };
}

export const mobileDownloadRouter: Router = Router();

mobileDownloadRouter.get("/", async (req, res) => {
  const requested = req.query.platform;
  const platform = isMobilePlatform(requested)
    ? requested
    : platformFromUserAgent(req.get("user-agent"));

  if (!platform) {
    // An unclassifiable device is sent to the chooser rather than refused.
    //
    // This is the iPad case, and it is not an edge: modern iPadOS Safari sends
    // a UA byte-identical to macOS, so the server genuinely cannot tell an iPad
    // from a Mac. Returning 400 meant an iPad scanning our QR — the exact
    // journey this entry point exists to serve — got an error page.
    //
    // The distinction iPadOS actually permits (`navigator.maxTouchPoints` on a
    // `Macintosh` UA) is only observable in the browser, so the decision has to
    // move client-side. The chooser is also where a desktop visitor belongs:
    // it offers both artifacts instead of guessing one.
    //
    // Product ruling: iPad IS a supported target (@huxijin, #wg-download-mobile,
    // after @Aiden showed the app runs on iPadOS). This route must therefore
    // never answer "unsupported" on UA alone.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, mobileDownloadChooserUrl());
    return;
  }

  if (platform === "ios") {
    // Apple-side surface, not a Hands artifact — see IOS_TESTFLIGHT_URL.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, IOS_TESTFLIGHT_URL);
    return;
  }

  const result = await lookupLatestAsset(platform, { fetch });

  switch (result.outcome) {
    case "asset":
      // Never cached beyond the signature's own lifetime: an expired signed URL
      // 4xxs, so a stale redirect is a broken download.
      res.setHeader("Cache-Control", `private, max-age=${Math.max(0, Math.min(result.expiresIn, 300))}`);
      res.redirect(302, result.downloadUrl);
      return;
    case "no_active_release":
      res.status(404).json({ error: "No build available yet", code: "no_active_release" });
      return;
    case "not_configured":
      console.error("[mobile-download] upstream configuration problem", { platform, detail: result.detail });
      res.status(502).json({ error: "Mobile download is unavailable", code: "not_configured" });
      return;
    default:
      console.error("[mobile-download] upstream error", { platform, detail: result.detail });
      res.status(502).json({ error: "Mobile download is unavailable", code: "upstream_error" });
      return;
  }
});

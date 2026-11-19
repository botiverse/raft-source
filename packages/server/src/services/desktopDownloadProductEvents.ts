// `desktop_download_requested` (Nova, 2026-11-15, #proj-analytics:e9009f38):
// a request to GET /api/desktop-download that was answered with the redirect
// to an installer. A server fact: best effort, never throws, never delays the
// redirect. No person, no server, no device on the row.

import type { Request } from "express";
import type { DesktopDownloadTarget } from "@botiverse/raft-shared";
import { likelyBotUserAgent } from "./externalInviteProductEvents";
import { getProductEventSink } from "./productEventIngest";
import { recordServerProductEvent } from "./serverProductEvents";
import { parseSignupCampaign } from "./signupCampaign";

/**
 * One row per request the route redirected to an installer: a count of
 * requests, not of downloads and not of people. Two clicks are two rows, and a
 * prefetcher or a crawler following the link is a row too (`likely_bot`, a
 * rough judgment from the User-Agent, which is never kept or logged). No
 * dedupe, no IP, no identifier.
 *
 * Where the visitor came from is read from the link's own query
 * (`utm_source`, `utm_medium`, `utm_campaign`, and the landing site's
 * `ref_domain`) by the rules `account_created` uses (`parseSignupCampaign`): a
 * value that does not pass is left out, never recorded as sent. A repeated or
 * nested query parameter (an array or an object) is not a plain string and is
 * left out too.
 */
export function recordDesktopDownloadRequested(req: Request, target: DesktopDownloadTarget): void {
  try {
    const sink = getProductEventSink(req.app);
    const properties = {
      target,
      likely_bot: likelyBotUserAgent(req.get("user-agent")),
      ...parseSignupCampaign({
        utm_source: req.query.utm_source,
        utm_medium: req.query.utm_medium,
        utm_campaign: req.query.utm_campaign,
        referrer_domain: req.query.ref_domain,
      }),
    };
    void recordServerProductEvent(sink, {
      event: "desktop_download_requested",
      userId: null,
      serverId: null,
      properties,
      now: Date.now(),
    }).catch((err: unknown) => {
      console.warn("[product-events] desktop_download_requested not recorded:", err instanceof Error ? err.name : "unknown");
    });
  } catch (err) {
    console.warn("[product-events] desktop_download_requested not recorded:", err instanceof Error ? err.name : "unknown");
  }
}

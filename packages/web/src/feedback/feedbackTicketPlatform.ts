// Which Hands app a feedback ticket lives in, when it is not the web's.
//
// A ticket filed in a mobile App lives in that App's Hands app. The web learns
// that from the ticket's `source` on a merged list page or a detail response
// (`?sources=all`, server #14722), or from its link:
// `.../settings/feedback/ticket/<id>?platform=android`. The web remembers it
// per ticket, so every call about the ticket (detail, reply, close,
// attachment) asks the same app (`?platform=`, server
// routes/productFeedback.ts). Memory only: the list and the link are the
// durable records.
//
// No feedback SDK import here: the settings panel and the transport share it.

import type { ProductFeedbackAppSource } from "@botiverse/raft-shared";

export type FeedbackTicketPlatform = Exclude<ProductFeedbackAppSource, "web">;
const MOBILE_PLATFORMS: readonly FeedbackTicketPlatform[] = ["ios", "android", "ohos"];

const platformByTicket = new Map<string, FeedbackTicketPlatform>();

/** The mobile App a ticket's `source` names, else null: the web's own app (or a value this build doesn't know). */
export function feedbackTicketPlatformOf(source: unknown): FeedbackTicketPlatform | null {
  return (MOBILE_PLATFORMS as readonly unknown[]).includes(source) ? (source as FeedbackTicketPlatform) : null;
}

/** The mobile App a link's query names, else null: the web's own app. */
export function feedbackTicketPlatformFromSearch(search: string): FeedbackTicketPlatform | null {
  return feedbackTicketPlatformOf(new URLSearchParams(search).get("platform"));
}

/** Records the App a ticket lives in. Null (the web's own app) changes nothing. */
export function rememberFeedbackTicketPlatform(ticketId: string, platform: FeedbackTicketPlatform | null): void {
  if (platform !== null) platformByTicket.set(ticketId, platform);
}

/** Request params that send a ticket call to the ticket's app; empty for a web ticket. */
export function feedbackTicketPlatformParams(ticketId: string): { platform?: FeedbackTicketPlatform } {
  const platform = platformByTicket.get(ticketId);
  return platform === undefined ? {} : { platform };
}

export function resetFeedbackTicketPlatformsForTest(): void {
  platformByTicket.clear();
}

// Which Hands app a feedback ticket lives in, when it is not the web's.
//
// A ticket filed in a mobile App lives in that App's Hands app, and its link
// says so: `.../settings/feedback/ticket/<id>?platform=android`. The web
// remembers that per ticket, so every call about the ticket (detail, reply,
// close, attachment) asks the same app (`?platform=`, server
// routes/productFeedback.ts). Memory only: the link is the durable record.
//
// No feedback SDK import here: the settings panel and the transport share it.

import type { ProductFeedbackAppSource } from "@botiverse/raft-shared";

export type FeedbackTicketPlatform = Exclude<ProductFeedbackAppSource, "web">;
const MOBILE_PLATFORMS: readonly FeedbackTicketPlatform[] = ["ios", "android", "ohos"];

const platformByTicket = new Map<string, FeedbackTicketPlatform>();

/** The mobile App a link's query names, else null: the web's own app. */
export function feedbackTicketPlatformFromSearch(search: string): FeedbackTicketPlatform | null {
  const value = new URLSearchParams(search).get("platform");
  return (MOBILE_PLATFORMS as readonly string[]).includes(value ?? "") ? (value as FeedbackTicketPlatform) : null;
}

/** Records the App a ticket's link named. A link without one changes nothing. */
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

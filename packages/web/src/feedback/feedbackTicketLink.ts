// A feedback ticket's own address: Settings › Feedback › the ticket, plus
// `?platform=` when it lives in a mobile App's Hands app (feedbackTicketPlatform.ts).
// The same link the mobile App copies (botiverse/mobile #4546):
// `https://app.raft.build/s/<server>/settings/feedback/ticket/<id>?platform=android`.

import { feedbackTicketPath } from "./feedbackPaths";
import { feedbackTicketPlatformParams } from "./feedbackTicketPlatform";
import { shareableWebOrigin } from "../utils/desktopShell";

/** `?platform=<app>` for a mobile App's ticket; "" for a web ticket. */
export function feedbackTicketSearch(ticketId: string): string {
  const { platform } = feedbackTicketPlatformParams(ticketId);
  return platform ? `?${new URLSearchParams({ platform }).toString()}` : "";
}

/** The ticket's browser-openable URL (origin, path, platform query); null without a server slug. */
export function feedbackTicketUrl(
  serverSlug: string | null | undefined,
  ticketId: string,
  origin: string = shareableWebOrigin(),
): string | null {
  const path = feedbackTicketPath(serverSlug, ticketId, feedbackTicketPlatformParams(ticketId).platform);
  return path === null ? null : `${origin}${path}`;
}

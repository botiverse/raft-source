import type { FeedbackWorkspaceRoute } from "@botiverse/hands-feedback-react";
import type { ProductFeedbackAppSource } from "@botiverse/raft-shared";

// Settings › Feedback routes, kept out of the lazily loaded feedback panel so
// light callers (action cards, Report Issue) can link to a ticket without
// pulling the Hands feedback bundle into the main chunk.

export function feedbackWorkspacePath(
  basePath: string,
  route: FeedbackWorkspaceRoute,
): string {
  if (route.view === "new") return `${basePath}/new`;
  if (route.view === "ticket" && route.ticketId)
    return `${basePath}/ticket/${encodeURIComponent(route.ticketId)}`;
  return basePath;
}

// The ids the server's ticket route takes (isCanonicalUuid,
// productFeedbackConversationService.ts); it answers 404 to any other.
const TICKET_ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The ticket id when its route can open it (a canonical UUID), else null: the feedback list. */
export function feedbackTicketRouteId(ticketId: string | null): string | null {
  return ticketId !== null && TICKET_ROUTE_ID.test(ticketId) ? ticketId : null;
}

/**
 * A ticket in Settings › Feedback, or the feedback list when the ticket is
 * unknown; null without a server slug, since settings only live under /s/<slug>.
 * A ticket filed in a mobile App (`source`) gets the App's own link form,
 * `?platform=<source>`, which is how the web reads it from that App's Hands
 * app (feedbackTicketPlatform.ts).
 */
export function feedbackTicketPath(
  serverSlug: string | null | undefined,
  ticketId: string | null,
  source: ProductFeedbackAppSource = "web",
): string | null {
  if (!serverSlug) return null;
  const base = `/s/${serverSlug}/settings/feedback`;
  if (!ticketId) return base;
  const path = feedbackWorkspacePath(base, { view: "ticket", ticketId });
  return source === "web" ? path : `${path}?platform=${source}`;
}

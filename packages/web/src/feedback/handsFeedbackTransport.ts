import type { FeedbackClient } from "@botiverse/hands-feedback-react";
import api from "../api/client";
import { isElectronDesktopShell } from "../utils/desktopShell";
import { captureFeedbackUnreadListRead, captureFeedbackUnreadUpdate } from "./feedbackUnreadState";
import { desktopFeedbackMetadata } from "./agentIssueTicket";
import { createHandsFeedbackTransport } from "./createHandsFeedbackTransport";
import { setFeedbackListDegraded } from "./feedbackListDegradedState";

export { desktopFeedbackMetadata };
export { feedbackTransportError } from "./createHandsFeedbackTransport";
export const handsFeedbackTransport = createHandsFeedbackTransport(api, {
  metadata: desktopFeedbackMetadata,
  // Web and Raft Desktop share the web's Hands app; the list merges every
  // client's tickets (createHandsFeedbackTransport.ts).
  allSources: true,
  captureUnread: captureFeedbackUnreadUpdate,
  // The panel's list read on opening is the unread read it owes (feedbackUnreadState.ts).
  captureListUnread: captureFeedbackUnreadListRead,
  onListDegradedChange: setFeedbackListDegraded,
});

/**
 * The Raft client this page runs as (FeedbackProvider `currentClient`): a
 * ticket filed on any other names that client on its first message. Raft
 * Desktop is told apart as desktopFeedbackMetadata does.
 */
export function feedbackCurrentClient(): FeedbackClient {
  return isElectronDesktopShell() ? "desktop" : "web";
}

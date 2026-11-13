import api from "../api/client";
import { captureFeedbackUnreadListRead, captureFeedbackUnreadUpdate } from "./feedbackUnreadState";
import { desktopFeedbackMetadata } from "./agentIssueTicket";
import { createHandsFeedbackTransport } from "./createHandsFeedbackTransport";
import { setFeedbackListDegraded } from "./feedbackListDegradedState";

export { desktopFeedbackMetadata };
export { feedbackTransportError } from "./createHandsFeedbackTransport";
export const handsFeedbackTransport = createHandsFeedbackTransport(api, {
  metadata: desktopFeedbackMetadata,
  captureUnread: captureFeedbackUnreadUpdate,
  // The panel's list read on opening is the unread read it owes (feedbackUnreadState.ts).
  captureListUnread: captureFeedbackUnreadListRead,
  onListDegradedChange: setFeedbackListDegraded,
});

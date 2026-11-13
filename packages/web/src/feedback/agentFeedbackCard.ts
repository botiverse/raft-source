import type { AxiosInstance } from "axios";
import type { ActionCardMetadata, FeedbackSubmitType } from "@botiverse/raft-shared";
import { productFeedbackForm } from "./productFeedbackForm";

/** The card the server completed from the Hands receipt. */
export type FeedbackCardCompletion = { messageId: string; metadata: ActionCardMetadata };

// Sends a `feedback:submit` action card's (possibly edited) draft as the
// sender's own product feedback: the in-app form's request (same fields and
// client facts), plus the card it came from. The server checks the card
// before Hands and completes it from the Hands receipt; the response carries
// the completed card when that worked. Errors propagate as-is; the form
// retries with the same submission id. The app sends through its api client
// (which adds X-Server-Id) with the desktop facts; the mobile feedback page
// through the native client, with the host's facts and the card's server.
export async function sendFeedbackCard(client: AxiosInstance, input: {
  messageId: string;
  confirmationVersion?: number;
  type: FeedbackSubmitType;
  message: string;
  submissionId: string;
  /** Client facts for the form's `metadata` field; omitted when null. */
  metadata: Record<string, string> | null;
  headers?: Record<string, string>;
}): Promise<{ id: string; actionCard: FeedbackCardCompletion | null }> {
  const form = productFeedbackForm({
    type: input.type,
    message: input.message,
    submissionId: input.submissionId,
    metadata: input.metadata,
  });
  form.set("action_card_message_id", input.messageId);
  if (input.confirmationVersion !== undefined) {
    form.set("expected_confirmation_version", String(input.confirmationVersion));
  }
  const { data } = await client.post<{
    id: string;
    action_card?: { message_id: string; metadata: ActionCardMetadata };
  }>("/product-feedback", form, input.headers ? { headers: input.headers } : undefined);
  return {
    id: data.id,
    actionCard: data.action_card ? { messageId: data.action_card.message_id, metadata: data.action_card.metadata } : null,
  };
}

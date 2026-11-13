import { isMessageCardMetadata } from "@botiverse/raft-shared";

export type OrdinaryMessageExternalProjectionDecision =
  | { eligible: true }
  | {
    eligible: false;
    reason: "action_metadata" | "task" | "non_chat" | "unsupported_sender";
  };

/**
 * Closed, provider-neutral classification for the only message class that may
 * later enter an external delivery outbox. Transport/provider authority is a
 * separate decision; this function only prevents non-ordinary producers from
 * being silently widened into chat projection.
 *
 * Any action_metadata keeps a message out, except a message card's (RFC 082
 * §4.3): its `content` is the card's first fallback, plain text, and that is
 * what the mirror carries (the outbox snapshots the text at send; the card is
 * never rendered there). An update never enqueues a delivery: it rewrites the
 * message in place (messageCardService.applyMessageCardUpdate) and records the
 * revision the existing Slack copy should show; the card edit worker edits that
 * copy (RFC 082 §4.6, slackCardEditWorkerService.ts), never posting a new one.
 */
export function classifyOrdinaryMessageExternalProjection(input: {
  senderType: string;
  messageType: string;
  asTask?: boolean;
  actionMetadata?: unknown | null;
}): OrdinaryMessageExternalProjectionDecision {
  if (input.senderType !== "user" && input.senderType !== "agent") {
    return { eligible: false, reason: "unsupported_sender" };
  }
  if (input.messageType !== "chat") {
    return { eligible: false, reason: "non_chat" };
  }
  if (input.asTask === true) {
    return { eligible: false, reason: "task" };
  }
  if (input.actionMetadata != null && !isMessageCardMetadata(input.actionMetadata)) {
    return { eligible: false, reason: "action_metadata" };
  }
  return { eligible: true };
}

export type OrdinaryMessageProducerClassification =
  | "eligible"
  | "conditional_task"
  | "excluded_action_metadata";

/**
 * Every production caller of broadcastAndDeliver must have one adjacent
 * `slack-bridge-ordinary-message-producer` marker and one entry here. The
 * source inventory test fails if a caller is added, removed, duplicated, or
 * changes its declared exclusion boundary.
 */
export const ORDINARY_MESSAGE_PRODUCER_CLASSIFICATION = {
  "attachment_comment.text": "eligible",
  "internal_agent.send": "eligible",
  "onboarding.owner_opener": "eligible",
  "onboarding.owner_artifact_reply": "eligible",
  "messages.forward_bundle": "excluded_action_metadata",
  "messages.create": "conditional_task",
  "channels.first_thread_reply": "eligible",
  // A card message (RFC 082) too: classify() lets a message card's metadata
  // through, so the mirror carries its first fallback text, never an update.
  "agent_api.send": "eligible",
  // RFC 077: sent as the owner by their assistant; bridged conversations are refused before the send.
  "assistant.send_as_owner": "eligible",
  // RFC 077 step 2: Raft's DM from the assistant to its owner (an agent DM, never bridged).
  "assistant.notify": "eligible",
  // A first-party app's message as the signed-in person (Artifacts' share: a note and a link), as if they sent it.
  "first_party_app.post_as_reader": "eligible",
  // The owner's WeChat text, posted as the owner into their DM with their assistant (wechatBridgeWorker); a DM, never bridged.
  "wechat_bridge.inbound": "eligible",
  // A person's seat request card to an owner (seatRequestService.postPersonCard): an action card.
  "seat_request.person_card": "excluded_action_metadata",
  // The owner's card to create the agent a seat request was for (seatRequestService.sendCreateAgentCard).
  "seat_request.create_agent_card": "excluded_action_metadata",
  // The ordinary message a person's New task posts as the task's source (routes/tasks.ts, task v2); it carries no task fields.
  "tasks.create_source": "eligible",
} as const satisfies Record<string, OrdinaryMessageProducerClassification>;

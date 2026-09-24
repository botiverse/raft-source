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
  if (input.actionMetadata != null) {
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
  "onboarding.all_channel_intro": "eligible",
  "messages.forward_bundle": "excluded_action_metadata",
  "messages.create": "conditional_task",
  "channels.first_thread_reply": "eligible",
  "agent_api.send": "eligible",
} as const satisfies Record<string, OrdinaryMessageProducerClassification>;

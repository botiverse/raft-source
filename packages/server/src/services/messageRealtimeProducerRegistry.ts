import type { messages } from "../db/schema.js";
import * as messageService from "./messageService.js";

/**
 * Closed registry of every `message:new` / `message:updated` producer surface
 * (slock#4593). Each entry pins event / audience / authority / applyTarget /
 * presence and the post-projection payload key set. The registry test
 * (messageRealtimeEvents.test.ts) enforces marker<->callsite bijection against
 * source; the canonical manifest producer test (canonicalMessageManifest.
 * producer.test.ts) enforces G6 reverse closure: every payload key must be
 * canonical or explicitly excluded in the manifest ledger.
 */
export type ProducerRegistryEntry = {
  id: string;
  event: "message:new" | "message:updated";
  audience: string;
  authority: string;
  applyTarget: string;
  presence: string;
  payloadKeys: readonly string[];
};

type TypeEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;
type ArrayKeys<T extends readonly string[]> = T[number];
type MessageRowKeys = Extract<keyof typeof messages.$inferSelect, string>;
type StorageOnlyMessageSocketKey = "agentSendKey" | "searchText" | "searchVector" | "senderHandle";
type HydratedMessageContextPayload =
  Omit<NonNullable<Awaited<ReturnType<typeof messageService.getMessageContext>>>["messages"][number], StorageOnlyMessageSocketKey>;
type HydratedMessageContextKeys = Extract<keyof HydratedMessageContextPayload, string>;

export const messageServiceBasePayloadKeys = [
  "actionMetadata",
  "attachments",
  "channelId",
  "commentRef",
  "content",
  "createdAt",
  "externalAuthor",
  "id",
  "mentions",
  "messageType",
  "randomId",
  "reactions",
  "senderDescription",
  "senderId",
  "senderMembershipStatus",
  "senderName",
  "senderType",
  "seq",
  "taskAssigneeId",
  "taskAssigneeName",
  "taskAssigneeType",
  "taskClaimedAt",
  "taskCompletedAt",
  "taskNumber",
  "taskStatus",
  "taskCurrentProjection",
  "threadId",
  "updatedAt",
] as const;
export const enrichedMessagePayloadKeys = [
  ...messageServiceBasePayloadKeys,
  "conversationContext",
] as const;
export const hydratedMessageUpdatePayloadKeys = messageServiceBasePayloadKeys;
type _HydratedMessageUpdateKeysAreActualPayloadKeys = AssertTrue<
  TypeEqual<ArrayKeys<typeof hydratedMessageUpdatePayloadKeys>, HydratedMessageContextKeys>
>;
type _EnrichedMessageKeysAreHydratedPlusConversationContext = AssertTrue<
  TypeEqual<ArrayKeys<typeof enrichedMessagePayloadKeys>, HydratedMessageContextKeys | "conversationContext">
>;
type _MessageServicePayloadIncludesAllMessageRowColumns = AssertTrue<
  TypeEqual<
    Extract<MessageRowKeys, ArrayKeys<typeof messageServiceBasePayloadKeys>>,
    Exclude<MessageRowKeys, StorageOnlyMessageSocketKey>
  >
>;
export const attachmentCommentPrivacyScrubPayloadKeys = ["channelId", "commentRef", "id"] as const;
export const messageSocketPayloadKeys = [
  "actionMetadata",
  "channelId",
  "content",
  "createdAt",
  "id",
  "messageType",
  "randomId",
  "senderId",
  "senderName",
  "senderType",
  "seq",
  "taskAssigneeId",
  "taskAssigneeName",
  "taskAssigneeType",
  "taskClaimedAt",
  "taskCompletedAt",
  "taskNumber",
  "taskStatus",
  "threadId",
  "updatedAt",
] as const;


export const MESSAGE_REALTIME_PRODUCER_REGISTRY: ProducerRegistryEntry[] = [
  {
    id: "routes/internal.ts#route-internal.reaction-remove.updated#message:updated",
    event: "message:updated",
    audience: "agent-visible message channel room",
    authority: "internal agent reaction removal route after agent/message/channel access checks",
    applyTarget: "hydrated message context update; viewer-scoped attachment comment metadata stripped",
    presence: "channel room only",
    payloadKeys: hydratedMessageUpdatePayloadKeys,
  },
  {
    id: "routes/internal.ts#route-internal.reaction-add.updated#message:updated",
    event: "message:updated",
    audience: "agent-visible message channel room",
    authority: "internal agent reaction add route after agent/message/channel access checks",
    applyTarget: "hydrated message context update; viewer-scoped attachment comment metadata stripped",
    presence: "channel room only",
    payloadKeys: hydratedMessageUpdatePayloadKeys,
  },
  {
    id: "routes/internal.ts#task-route.new.internal-agent#message:new",
    event: "message:new",
    audience: "task target channel room",
    authority: "internal agent task create route after agent scope and channel context checks",
    applyTarget: "canonical task message row for chat flow; task* fields are task-domain projection; messageFold=excluded",
    presence: "channel room only",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "routes/internalAgentApi.ts#task-route.new.agent-api#message:new",
    event: "message:new",
    audience: "task target channel room",
    authority: "agent API taskCreate after request validation and channel context checks",
    applyTarget: "canonical task message row for chat flow; task* fields are task-domain projection; messageFold=excluded",
    presence: "channel room only",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "routes/internalAgentApi.ts#route-agent-api.reaction.updated#message:updated",
    event: "message:updated",
    audience: "agent-visible message channel room",
    authority: "agent API reaction handler after visible-message and actor checks",
    applyTarget: "hydrated message context update; viewer-scoped attachment comment metadata stripped",
    presence: "channel room only",
    payloadKeys: hydratedMessageUpdatePayloadKeys,
  },
  {
    id: "routes/messages.ts#route-message.updated.projected#message:updated",
    event: "message:updated",
    audience: "local channel projection room",
    authority: "user message edit/reaction route after message/channel access checks",
    applyTarget: "hydrated projected message context update; viewer-scoped attachment comment metadata stripped",
    presence: "channel room only, projected for joint targets",
    payloadKeys: hydratedMessageUpdatePayloadKeys,
  },
  {
    id: "routes/tasks.ts#task-route.new.user#message:new",
    event: "message:new",
    audience: "task target channel room",
    authority: "authenticated channel task create route after channel access checks",
    applyTarget: "canonical task message row for chat flow; task* fields are task-domain projection; messageFold=excluded",
    presence: "channel room only",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.external-reaction.updated#message:updated",
    event: "message:updated",
    audience: "local channel projection room",
    authority: "durably committed external reaction observation on an active Slack message link",
    applyTarget: "hydrated projected message context update; viewer-scoped attachment comment metadata stripped",
    presence: "channel room only, projected for joint targets",
    payloadKeys: hydratedMessageUpdatePayloadKeys,
  },
  {
    id: "services/actionCardsService.ts#action-card.updated.channel#message:updated",
    event: "message:updated",
    audience: "action-card message channel room",
    authority: "action card service after app/target access checks and persisted message update",
    applyTarget: "canonical action-card message/actionMetadata projection",
    presence: "channel room for non-thread target",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/actionCardsService.ts#action-card.updated.thread-follower#message:updated",
    event: "message:updated",
    audience: "thread follower user room",
    authority: "action card service after app/target access checks and persisted message update",
    applyTarget: "canonical action-card message/actionMetadata projection",
    presence: "per-follower user room for thread target",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/actionCardsService.ts#action-card.new.channel#message:new",
    event: "message:new",
    audience: "action-card target channel room",
    authority: "action card service after app/target access checks and persisted carrier message insert",
    applyTarget: "canonical action-card carrier message/actionMetadata projection",
    presence: "channel room for non-thread target",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/actionCardsService.ts#action-card.new.thread-follower#message:new",
    event: "message:new",
    audience: "thread follower user room",
    authority: "action card service after app/target access checks and persisted carrier message insert",
    applyTarget: "canonical action-card carrier message/actionMetadata projection",
    presence: "per-follower user room for thread target",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/attachmentCommentService.ts#attachment-comment.privacy-scrub#message:updated",
    event: "message:updated",
    audience: "review channel room",
    authority: "attachment comment creation path after attachment/comment access checks",
    applyTarget: "shared privacy-scrub notification only; no canonical or overlay apply",
    presence: "channel room only",
    payloadKeys: attachmentCommentPrivacyScrubPayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.system.thread-private-follower#message:new",
    event: "message:new",
    audience: "DM/thread follower user room",
    authority: "system message producer after caller authorization and persistence",
    applyTarget: "canonical system message row enriched for frontend conversation context",
    presence: "per-user room for private thread or DM projections",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.system.thread-public#message:new",
    event: "message:new",
    audience: "channel room",
    authority: "system message producer after caller authorization and persistence",
    applyTarget: "canonical system message row enriched for frontend conversation context",
    presence: "channel room for public thread parent",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.system.joint-thread-follower#message:new",
    event: "message:new",
    audience: "joint local thread follower user room",
    authority: "system message producer after caller authorization and canonical persistence",
    applyTarget: "canonical system message row projected to joint local thread",
    presence: "per-follower user room for joint thread projection",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.system.channel#message:new",
    event: "message:new",
    audience: "channel room",
    authority: "system message producer after caller authorization and persistence",
    applyTarget: "canonical system message row enriched for frontend conversation context",
    presence: "channel room for non-thread target",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.persisted.thread-public#message:new",
    event: "message:new",
    audience: "canonical thread channel room",
    authority: "message send pipeline after channel membership/producer checks and persistence",
    applyTarget: "canonical persisted message row enriched for frontend conversation context",
    presence: "channel room for public thread parent",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.persisted.channel#message:new",
    event: "message:new",
    audience: "message channel room",
    authority: "message send pipeline after channel membership/producer checks and persistence",
    applyTarget: "canonical persisted message row enriched for frontend conversation context",
    presence: "channel room for non-thread target",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.persisted.joint-channel-projection#message:new",
    event: "message:new",
    audience: "joint local channel projection room",
    authority: "message send pipeline after channel membership/producer checks and persistence",
    applyTarget: "canonical persisted message row projected to joint local channel",
    presence: "projected local channel room",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.persisted.thread-private-follower#message:new",
    event: "message:new",
    audience: "private thread follower user room",
    authority: "message send pipeline after channel membership/producer checks and persistence",
    applyTarget: "canonical persisted message row enriched for frontend conversation context",
    presence: "per-follower user room for private thread parent",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/messageService.ts#message-service.persisted.joint-thread-follower#message:new",
    event: "message:new",
    audience: "joint local thread follower user room",
    authority: "message send pipeline after channel membership/producer checks and persistence",
    applyTarget: "canonical persisted message row projected to joint local thread",
    presence: "per-follower user room for joint thread projection",
    payloadKeys: enrichedMessagePayloadKeys,
  },
  {
    id: "services/taskRealtimeEvents.ts#task-message.new.projector#message:new",
    event: "message:new",
    audience: "task target channel room",
    authority: "helper caller owns route-level authorization and task persistence",
    applyTarget: "allowlisted task message row for chat flow; task* fields are task-domain projection; messageFold=excluded",
    presence: "channel room only",
    payloadKeys: messageSocketPayloadKeys,
  },
  {
    id: "services/taskRealtimeEvents.ts#task-message.updated.projector#message:updated",
    event: "message:updated",
    audience: "task message channel room",
    authority: "helper caller owns route-level authorization and task mutation persistence",
    applyTarget: "allowlisted task message row for chat flow; task* fields are task-domain projection; messageFold=excluded",
    presence: "channel room only",
    payloadKeys: messageSocketPayloadKeys,
  },
];

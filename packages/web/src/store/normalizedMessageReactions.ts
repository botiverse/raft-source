import type {
  CanonicalReactionFact,
  LegacyReactionRosterDto,
  SyncScopeKey,
} from "@botiverse/raft-shared";
import {
  CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
  CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
  isCanonicalMessageV2SoleApplyEligible,
} from "@botiverse/raft-shared";

import type { LegacyMessageReaction, Message, MessageReaction } from "./messageStore";
import {
  reactionReadModelStore,
} from "./reactionReadModels";
import type {
  StagedLegacyReactionIngress,
} from "./reactionReadModels";

export type MessageReactionIngressSource = "channel-room" | "receiver-private";

export class InvalidNormalizedMessageReactionsError extends Error {
  constructor(readonly messageId: string) {
    super(`Message ${messageId} is not eligible for normalized V2 apply`);
  }
}

export interface MessageReactionNormalizationContext {
  serverId: string;
  principalId: string;
  source: MessageReactionIngressSource;
  viewerUserId?: string | null;
  parentScopeKey?: SyncScopeKey;
}

export interface StagedNormalizedMessageBatch {
  sourceMessages: readonly Message[];
  messages: Message[];
  reactionIngress: StagedLegacyReactionIngress[];
  soleApplyEligibility: readonly boolean[];
}

export function isLegacyMessageReaction(
  reaction: MessageReaction,
): reaction is LegacyMessageReaction {
  return Array.isArray((reaction as Partial<LegacyReactionRosterDto>).reactorIds)
    && Array.isArray((reaction as Partial<LegacyReactionRosterDto>).reactorNames);
}

export function isCanonicalMessageReaction(
  reaction: MessageReaction,
): reaction is CanonicalReactionFact {
  return Array.isArray((reaction as Partial<CanonicalReactionFact>).previewK)
    && !("reactorIds" in reaction)
    && !("reactorNames" in reaction);
}

export function messageReactionParentScopeKey(
  serverId: string,
  message: Message,
): SyncScopeKey {
  return {
    serverId,
    scopeKind: message.conversationContext?.channelType === "thread" ? "thread" : "channel",
    scopeId: message.channelId,
  };
}

function stageMessageReactionsForV2(
  message: Message,
  context: MessageReactionNormalizationContext,
): { message: Message; reactionIngress?: StagedLegacyReactionIngress; soleApplyEligible: boolean } | null {
  if (message.reactions === undefined) {
    return { message, soleApplyEligible: false };
  }
  const reactions = message.reactions;
  if (reactions.every(isCanonicalMessageReaction)) {
    return isMessageV2SoleApplyEligible(message)
      ? { message, soleApplyEligible: true }
      : null;
  }
  if (!reactions.every(isLegacyMessageReaction)) return null;

  const staged = reactionReadModelStore.getState().stageLegacyIngress({
    principalId: context.principalId,
    serverId: context.serverId,
    parentScopeKey: context.parentScopeKey
      ?? messageReactionParentScopeKey(context.serverId, message),
    messageId: message.id,
    source: context.source,
    viewerUserId: context.viewerUserId,
    reactions,
  });
  const normalizedMessage = { ...message, reactions: [...staged.sharedFact] };
  return isMessageV2SoleApplyEligible(normalizedMessage)
    ? { message: normalizedMessage, reactionIngress: staged.staged, soleApplyEligible: false }
    : null;
}

export function stageMessagesReactionsForV2(
  messages: readonly Message[],
  context: MessageReactionNormalizationContext,
): StagedNormalizedMessageBatch {
  const stagedMessages: Message[] = [];
  const reactionIngress: StagedLegacyReactionIngress[] = [];
  const soleApplyEligibility: boolean[] = [];
  for (const message of messages) {
    const staged = stageMessageReactionsForV2(message, context);
    if (!staged) throw new InvalidNormalizedMessageReactionsError(message.id);
    stagedMessages.push(staged.message);
    soleApplyEligibility.push(staged.soleApplyEligible);
    if (staged.reactionIngress) reactionIngress.push(staged.reactionIngress);
  }
  return {
    sourceMessages: messages,
    messages: stagedMessages,
    reactionIngress,
    soleApplyEligibility,
  };
}

export function commitStagedMessageReactionsForV2(
  staged: StagedNormalizedMessageBatch,
): Message[] {
  reactionReadModelStore.getState().applyStagedLegacyIngressBatch(staged.reactionIngress);
  return staged.messages;
}

export function normalizeMessageReactionsForV2(
  message: Message,
  context: MessageReactionNormalizationContext,
): Message {
  return normalizeMessagesReactionsForV2([message], context)[0]!;
}

/**
 * Single-flag ingress projection. Raw V1 rosters may feed the bounded shadow
 * read models, but only an already-canonical, strict-tripwire input may replace
 * the message fact. Malformed normalized candidates fail open to the existing
 * V1 lane with zero partial shadow commit.
 */
export function applyMessagesReactionsForV2Ingress(
  messages: readonly Message[],
  context: MessageReactionNormalizationContext,
): Message[] {
  let staged: StagedNormalizedMessageBatch;
  try {
    staged = stageMessagesReactionsForV2(messages, context);
  } catch {
    return [...messages];
  }
  reactionReadModelStore.getState().applyStagedLegacyIngressBatch(staged.reactionIngress);
  return staged.messages.map((message, index) => (
    staged.soleApplyEligibility[index] ? message : staged.sourceMessages[index]!
  ));
}

export function applyMessageReactionsForV2Ingress(
  message: Message,
  context: MessageReactionNormalizationContext,
): Message {
  return applyMessagesReactionsForV2Ingress([message], context)[0]!;
}

export function isMessageV2IngressSoleApplyEligible(message: Message): boolean {
  return message.reactions !== undefined
    && message.reactions.every(isCanonicalMessageReaction)
    && isMessageV2SoleApplyEligible(message);
}

export function isMessageV2IngressAdmissible(message: Message): boolean {
  if (message.reactions === undefined) return true;
  if (message.reactions.every(isLegacyMessageReaction)) return true;
  return isMessageV2IngressSoleApplyEligible(message);
}

export function isMessageV2SoleApplyEligible(message: Message): boolean {
  return isCanonicalMessageV2SoleApplyEligible({
    schemaVersion: CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
    kind: CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
    fact: { reactions: message.reactions ?? [] },
  });
}

export function normalizeMessagesReactionsForV2(
  messages: readonly Message[],
  context: MessageReactionNormalizationContext,
): Message[] {
  return commitStagedMessageReactionsForV2(stageMessagesReactionsForV2(messages, context));
}

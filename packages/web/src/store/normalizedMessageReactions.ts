import type { CanonicalReactionFact, LegacyReactionRosterDto, SyncScopeKey } from "@botiverse/raft-shared";
import type { LegacyMessageReaction, Message, MessageReaction } from "./messageStore";

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
    // A task conversation (task v2) is a sub-conversation like a thread.
    scopeKind: message.conversationContext?.channelType === "thread" || message.conversationContext?.channelType === "task" ? "thread" : "channel",
    scopeId: message.channelId,
  };
}

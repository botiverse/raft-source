// RFC 082: the conversation a card message is updated through, for the card
// update route (internalAgentApi.ts checkMessageCardUpdate) and the Slack edit
// worker (slackCardEditWorkerService.ts) only.
//
// A Joint Channel's messages are stored once, in its canonical channel on the
// hidden joint_storage Server; each Server holds the joint through its own
// projection (a `joint` channel, and lazily a local face per thread or task
// conversation). A card message sent in an ordinary channel that was later
// converted to a joint lives in canonical storage too. Its sender still
// updates it, through ITS OWN Server's side of the joint: the projection of
// the Server its credential belongs to. Never another Server's projection,
// never "any projection under the canonical": no projection of that Server
// (it disconnected, the joint closed, the projection was deleted) means the
// message is not the sender's to update from there, the same answer as a
// message on another Server.
//
// The generic by-id resolver (messageResourceAccess.ts) keeps refusing an
// agent a joint message's canonical channel; this mapping is not a general
// agent access rule.

import { isSubConversationType } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import { getServerHistoryWindowForRead, isBehindHistoryWindow } from "./historyWindow";

type ChannelRow = NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;
type CardMessage = Extract<Awaited<ReturnType<typeof messageService.resolveMessageIdVisibleToAgent>>, { ok: true }>["message"];

/** Where a card message is updated from, as one Server holds it. */
export type CardMessageConversation = {
  /**
   * The conversation every check runs on (posting authority, archive, plan
   * read-only, a historical joint task): the message's own channel, or that
   * Server's projection of a Joint one (its local face for a thread or task
   * conversation).
   */
  conversationId: string;
  /** Its row, as read. */
  conversation: ChannelRow;
  /** Null for a conversation of the Server itself; for a Joint one, that Server's side of it. */
  joint: {
    role: "host" | "participant";
    /**
     * The local channel whose Joint membership admits a post: the projection,
     * or a thread's or task conversation's local parent (its local face has no
     * parent pointer to walk). What lockJointPostingAuthority takes, as on send.
     */
    postingAuthorityChannelId: string;
  } | null;
};

/**
 * `storageChannelId` (a message's `channel_id`) as `serverId` holds it: its own
 * conversation, or its own ACTIVE projection of a Joint Channel's canonical
 * channel or canonical thread / task conversation. Null for anything else.
 */
export async function resolveCardMessageConversation(storageChannelId: string, serverId: string): Promise<CardMessageConversation | null> {
  const storage = await channelService.getChannel(storageChannelId);
  if (!storage) return null;
  if (storage.serverId === serverId) return { conversationId: storage.id, conversation: storage, joint: null };
  if (isSubConversationType(storage.type)) {
    // Active rows only, under an active joint and an active local parent projection.
    const local = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(storageChannelId))
      .find((projection) => projection.localServerId === serverId && projection.canonicalThreadChannelId === storageChannelId);
    if (!local || local.threadChannel.serverId !== serverId) return null;
    return {
      conversationId: local.localThreadChannelId,
      conversation: local.threadChannel,
      joint: { role: local.role, postingAuthorityChannelId: local.localParentChannelId },
    };
  }
  // The canonical channel itself (a projection is never a message's storage).
  const local = (await channelService.getActiveJointChannelProjectionsByLocalChannel(storageChannelId))
    .find((projection) => projection.serverId === serverId && projection.canonicalChannelId === storageChannelId);
  if (!local || local.channel.serverId !== serverId) return null;
  return {
    conversationId: local.localChannelId,
    conversation: local.channel,
    joint: { role: local.role, postingAuthorityChannelId: local.localChannelId },
  };
}

/**
 * The card update's access step: the message by id (full or short) as the
 * sending agent's Server sees it, the conversation it is updated through
 * (resolveCardMessageConversation, for the credential's Server), the agent's
 * access to that conversation and the route's extra condition on it, then the
 * Server's history window. Null for every miss: the route answers each with
 * the same 404.
 */
export async function resolveCardMessageForSender(input: {
  messageId: string;
  /** The acting agent's credential Server. */
  serverId: string;
  agentId: string;
  /** A route's extra condition on the conversation (the agent API's assistant confinement). */
  alsoRequire?: (conversationId: string) => Promise<boolean>;
}): Promise<{ message: CardMessage; conversation: CardMessageConversation } | null> {
  const resolved = await messageService.resolveMessageIdVisibleToAgent(input.serverId, input.agentId, input.messageId);
  if (!resolved.ok) return null;
  const conversation = await resolveCardMessageConversation(resolved.message.channelId, input.serverId);
  if (!conversation) return null;
  if (!await channelService.canAgentAccessChannel(conversation.conversationId, input.agentId)) return null;
  if (input.alsoRequire && !await input.alsoRequire(conversation.conversationId)) return null;
  if (isBehindHistoryWindow(resolved.message.createdAt, await getServerHistoryWindowForRead(input.serverId))) return null;
  return { message: resolved.message, conversation };
}

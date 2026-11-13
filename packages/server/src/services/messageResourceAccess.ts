import { isSubConversationType, type ServerId } from "@botiverse/raft-shared";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import { getServerHistoryWindowForRead, isBehindHistoryWindow, type HistoryWindow } from "./historyWindow";

// One message, by id, as a resource someone acts on (reactions now; files,
// task conversion, forwards, translations next): readable, not theirs to
// see, or behind the reading server's history window. The order is fixed:
// access first, then the window, so a message the actor may not read is
// never said to exist or to be old. Each route keeps its own error shape.
//
// This wraps the access checks the routes already ran; it does not unify
// them (people and agents still resolve visibility their own way). The
// message row is the one the id lookup matched, returned as read.
//
// Not every by-id route uses it, because their access rules differ:
// - The agent API's `messageResolve` (and the legacy daemon's resolve)
//   checks visibility with the id lookup alone, which finds a Joint Channel
//   message through the agent's local projection.
// - The card update (RFC 082) reaches a Joint Channel's card through the
//   sender's own Server's projection with its own mapping
//   (messageCardConversation.ts); the agent branch here does not.
// - Files go through their authority context (RFC 049).
// - Action cards, task conversion and the feedback card each have their own
//   surface rule.
// Line them up when people and agents move to one visibility entry (canView).

export type MessageResourceActor =
  | { type: "user"; id: string }
  | {
    type: "agent";
    id: string;
    /** A route's extra condition on the message's channel, checked with access (the agent API's assistant confinement). */
    alsoRequire?: (channelId: string) => Promise<boolean>;
  };

type ResourceMessage = NonNullable<Awaited<ReturnType<typeof messageService.getMessage>>>;

export type MessageResourceAccess =
  | {
    kind: "readable";
    message: ResourceMessage;
    /** The channel the actor holds the message through: its server's local projection of a Joint Channel. */
    localChannelId: string;
    historyWindow: HistoryWindow;
  }
  | {
    kind: "no_access";
    /**
     * `id_invalid`: not a usable id (400, the resolver's own words);
     * `channel_not_found`: an agent's message whose channel is gone or that
     * its server holds no copy of; `not_found`: anything else the actor can't read.
     */
    reason: "id_invalid" | "not_found" | "channel_not_found";
    status: 400 | 404;
    error: string;
  }
  | { kind: "history_limited"; historyWindow: HistoryWindow };

const NOT_FOUND = { kind: "no_access", reason: "not_found", status: 404, error: "Message not found" } as const;

export async function resolveMessageResourceAccess(input: {
  /** A full id or an 8-character short id. */
  messageId: string;
  /** The reading server: its access rules and its plan's window. */
  serverId: string;
  actor: MessageResourceActor;
}): Promise<MessageResourceAccess> {
  const { messageId, serverId, actor } = input;
  const resolved = actor.type === "user"
    ? await messageService.resolveMessageIdVisibleToUser(serverId, actor.id, messageId)
    : await messageService.resolveMessageIdVisibleToAgent(serverId, actor.id, messageId);
  if (!resolved.ok) {
    return resolved.status === 404
      ? { ...NOT_FOUND, error: resolved.error }
      : { kind: "no_access", reason: "id_invalid", status: 400, error: resolved.error };
  }
  const { message } = resolved;
  const channel = await channelService.getChannel(message.channelId);

  let localChannelId: string;
  if (actor.type === "user") {
    if (!channel) return NOT_FOUND;
    localChannelId = await personLocalConversationId(channel, serverId);
    if (!localChannelId || !await channelService.canUserAccessChannel(localChannelId, actor.id, serverId as ServerId)) {
      return NOT_FOUND;
    }
  } else {
    localChannelId = channel ? await personLocalConversationId(channel, serverId) : "";
    if (!localChannelId) {
      return { kind: "no_access", reason: "channel_not_found", status: 404, error: "Message not found" };
    }
    if (!await channelService.canAgentAccessChannel(localChannelId, actor.id)) return NOT_FOUND;
    if (actor.alsoRequire && !await actor.alsoRequire(localChannelId)) return NOT_FOUND;
  }

  const historyWindow = await getServerHistoryWindowForRead(serverId);
  if (isBehindHistoryWindow(message.createdAt, historyWindow)) return { kind: "history_limited", historyWindow };
  return { kind: "readable", message, localChannelId, historyWindow };
}

/**
 * The conversation someone on `serverId` holds a message's channel through:
 * the channel itself when it is that server's, else that server's active
 * projection of the Joint Channel or thread it stores ("" when none). Both
 * branches above, and the card revisions read (routes/messages.ts).
 */
export async function personLocalConversationId(channel: { id: string; serverId: string; type: string }, serverId: string): Promise<string> {
  return channel.serverId === serverId
    ? channel.id
    : localJointProjectionId(channel.id, isSubConversationType(channel.type), serverId);
}

/**
 * Joint-channel messages live in canonical storage; a person's authority is
 * their server's local projection of that channel or thread ("" when their
 * server has none).
 */
async function localJointProjectionId(canonicalChannelId: string, isThread: boolean, serverId: string): Promise<string> {
  if (isThread) {
    const thread = (await channelService.getActiveJointThreadProjectionsByCanonicalThread(canonicalChannelId))
      .find((projection) => projection.localServerId === serverId);
    return thread?.localThreadChannelId ?? "";
  }
  const channel = (await channelService.getActiveJointChannelProjectionsByLocalChannel(canonicalChannelId))
    .find((projection) => projection.serverId === serverId);
  return channel?.localChannelId ?? "";
}

// Platform entry point: messages, for an app that names one (where an object
// came from) and shows where it is to a viewer.
//
// Core's own rule for one message by id (services/messageResourceAccess,
// what the message resource routes use): the viewer can read the message's
// conversation, as the viewer's server shows it (a joint message by the
// viewer's local projection), then the plan's history window of the viewer's
// server (a Free server's 30 days). A retracted message (`deleted_at`) is
// gone. Anything else is null, one answer for "no such message", "not yours
// to see" and "behind the window".
import { isSubConversationType } from "@botiverse/raft-shared";
import { UUID_RE } from "../lib/messageId";
import { getChannel, resolveThreadParent } from "../services/channelService";
import { resolveMessageResourceAccess } from "../services/messageResourceAccess";
import { assertNeverViewActor, type ViewActor } from "../services/visibilityService";

/** Where a message the viewer can read is, as the viewer's server has it. */
export interface MessageSource {
  messageId: string;
  /** The top-level conversation: the message's own, a thread's (or task conversation's) parent; a joint by the viewer's projection. */
  conversationId: string;
  /** For a reply in a thread: the message the thread hangs off. Null otherwise. */
  threadRootId: string | null;
}

/**
 * Where a message is, when the viewer can read it now (null otherwise, for a
 * retracted one, or when its top-level conversation can't be resolved: a
 * thread whose root message is gone). An assistant acting for its owner
 * (`delegated`) reads none.
 */
export async function messageSource(viewer: ViewActor, messageId: string): Promise<MessageSource | null> {
  if (!UUID_RE.test(messageId)) return null;
  let actor: { type: "user" | "agent"; id: string };
  switch (viewer.type) {
    case "user":
    case "agent":
      actor = { type: viewer.type, id: viewer.id };
      break;
    case "delegated":
      return null;
    default:
      return assertNeverViewActor(viewer);
  }
  const access = await resolveMessageResourceAccess({ messageId, serverId: viewer.serverId, actor });
  if (access.kind !== "readable" || access.message.deletedAt !== null) return null;
  const channel = await getChannel(access.localChannelId);
  if (!channel) return null;
  if (channel.type === "task") return channel.parentChannelId ? { messageId: access.message.id, conversationId: channel.parentChannelId, threadRootId: null } : null;
  if (!isSubConversationType(channel.type)) return { messageId: access.message.id, conversationId: channel.id, threadRootId: null };
  const parent = await resolveThreadParent(channel);
  return parent ? { messageId: access.message.id, conversationId: parent.parentChannelId, threadRootId: parent.parentMessageId } : null;
}

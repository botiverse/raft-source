import type { Channel } from "../../store/channelStore";
import type { ConversationContext } from "../../store/messageStore";
import type { useAppNavigate } from "../../hooks/useAppNavigate";
import { isConversationTarget } from "./forwardComposerModel";
import type { ForwardSearchTarget } from "./forwardComposerModel";

type AppNavigate = ReturnType<typeof useAppNavigate>;

/** One posted forward, as its outcome toast names it and "View in chat" opens it. */
export type ForwardViewDelivery = {
  destination: Channel;
  messageId: string;
  /** The posted message's conversation, as the server answered it (a thread's or a task's). */
  context?: ConversationContext;
  /** The row it was chosen from, when it was a search or recent-conversations row. */
  target?: ForwardSearchTarget;
};

function conversationRow(delivery: ForwardViewDelivery): ForwardSearchTarget | null {
  return delivery.target && isConversationTarget(delivery.target) ? delivery.target : null;
}

/** The toast's name for the destination: a DM, `#channel`, or a thread / task row's own title. */
export function forwardDeliveryLabel(delivery: ForwardViewDelivery): string {
  const row = conversationRow(delivery);
  if (row) return row.title;
  return delivery.destination.type === "dm" ? "DM" : `#${delivery.destination.name}`;
}

/**
 * "View in chat" for one posted forward: the message in its channel or DM;
 * in a thread, the thread open on it; in a task discussion, the task's
 * conversation. A thread or task is located only by the conversation the
 * server answered for the posted message (a row's own id is its conversation
 * channel's, not a parent message's or a task's): without it the toast has no
 * action rather than a guessed one.
 */
export function forwardDeliveryOpener(nav: AppNavigate, delivery: ForwardViewDelivery): (() => void) | null {
  const { destination, messageId, context } = delivery;
  if (context?.channelType === "task") {
    const { parentChannelId, taskId } = context;
    if (!parentChannelId || !taskId) return null;
    const routeKind = context.parentChannelType === "dm" ? "dm" : "channel";
    return () => nav.toTaskConversation(parentChannelId, taskId, routeKind);
  }
  if (context?.channelType === "thread") {
    const { parentChannelId, parentMessageId } = context;
    if (!parentChannelId || !parentMessageId) return null;
    const routeKind = context.parentChannelType === "dm" ? "dm" : "channel";
    return () => nav.toThreadMessage(parentChannelId, parentMessageId, messageId, routeKind);
  }
  if (conversationRow(delivery) || destination.type === "thread") return null;
  if (destination.type === "dm") return () => nav.toDmMessage(destination.id, messageId);
  return () => nav.toMessage(destination.id, messageId);
}

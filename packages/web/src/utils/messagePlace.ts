// Where a message is read, from only its conversation id.
//
// A message knows the conversation it was posted in (`message.channelId`).
// For a channel or DM message that conversation is the place to open; for a
// thread reply it is the thread's own sub-conversation, and for a message in a
// task's discussion the task's (task v2, `channels.type = 'task'`). Neither
// is a page of its own: opening `/channel/<thread conversation>` showed the
// bare sub-conversation, titled by its internal name ("thread-fc8d488f";
// cindyz, #triage:#107). A thread reply opens in its parent channel with the
// thread open at the reply, as its Copy Link does; a task message opens the
// task's own conversation over its channel, at the message (Noel, Task v2).
//
// Surfaces that already carry the parent (Activity inbox rows, Saved, search
// results with parent fields) open those directly; this is for the ones that
// only hold a conversation id and a message id, such as an agent's activity.

import api from "../api/client";
import { useChannelStore } from "../store/channelStore";
import { findStoredChannel } from "../store/storedChannel";
import { useThreadStore } from "../store/threadStore";
import { syncRightPanelStoresFromSearch } from "../components/layout/rightPanelUrlSync";

export type MessagePlace =
  | { kind: "channel"; channelId: string; messageId: string }
  | { kind: "dm"; channelId: string; messageId: string }
  | {
      kind: "thread";
      parentChannelId: string;
      parentMessageId: string;
      parentRouteKind: "channel" | "dm";
      messageId: string;
    }
  | {
      kind: "task";
      taskId: string;
      parentChannelId: string;
      parentRouteKind: "channel" | "dm";
      /** Null for a joint channel's task: the dialog resolves this server's conversation itself. */
      conversationChannelId: string | null;
      messageId: string;
    };

/** The fields of `GET /channels/:id` this needs: a sub-conversation names its parent. */
export interface ConversationIdentity {
  type?: string | null;
  parentChannelId?: string | null;
  parentMessageId?: string | null;
  taskId?: string | null;
}

export type LoadConversationIdentity = (channelId: string) => Promise<ConversationIdentity | null>;

/** `GET /channels/:id`: what a conversation is and, for a sub-conversation, its parent. */
export const loadConversationIdentity: LoadConversationIdentity = async (channelId) => {
  const { data } = await api.get<ConversationIdentity>(`/channels/${encodeURIComponent(channelId)}`);
  return data ?? null;
};

function knownConversationType(channelId: string): string | null {
  const state = useChannelStore.getState();
  if (state.dmChannels.some((channel) => channel.id === channelId)) return "dm";
  return findStoredChannel(state, channelId)?.type ?? null;
}

function routeKindOf(channelId: string): "channel" | "dm" {
  return knownConversationType(channelId) === "dm" ? "dm" : "channel";
}

/**
 * The place to open a message posted in `channelId`. A channel or DM in the
 * sidebar answers at once; anything else (a thread or task conversation, or
 * a channel this tab has not loaded) asks the server what the conversation
 * is. When that fails the message opens where it was posted, as before.
 */
export async function resolveMessagePlace(
  channelId: string,
  messageId: string,
  load: LoadConversationIdentity = loadConversationIdentity,
): Promise<MessagePlace> {
  const known = knownConversationType(channelId);
  if (known === "dm") return { kind: "dm", channelId, messageId };
  if (known && known !== "thread" && known !== "task") return { kind: "channel", channelId, messageId };

  let conversation: ConversationIdentity | null = null;
  try {
    conversation = await load(channelId);
  } catch {
    conversation = null;
  }
  if (conversation?.type === "thread" && conversation.parentChannelId && conversation.parentMessageId) {
    return {
      kind: "thread",
      parentChannelId: conversation.parentChannelId,
      parentMessageId: conversation.parentMessageId,
      parentRouteKind: routeKindOf(conversation.parentChannelId),
      messageId,
    };
  }
  if (conversation?.type === "task" && conversation.parentChannelId && conversation.taskId) {
    return {
      kind: "task",
      taskId: conversation.taskId,
      parentChannelId: conversation.parentChannelId,
      parentRouteKind: routeKindOf(conversation.parentChannelId),
      // As search opens a task hit (directTaskConversationChannelId): a joint
      // channel's task conversation is resolved by the dialog, not passed in.
      conversationChannelId: knownConversationType(conversation.parentChannelId) === "joint" ? null : channelId,
      messageId,
    };
  }
  if (conversation?.type === "dm") return { kind: "dm", channelId, messageId };
  return { kind: "channel", channelId, messageId };
}

/** The routes a place opens through (useAppNavigate). */
export interface MessagePlaceNav {
  toMessage: (channelId: string, messageId: string) => void;
  toDmMessage: (dmChannelId: string, messageId: string) => void;
  toThreadMessage: (channelId: string, parentMessageId: string, messageId: string, routeKind?: "channel" | "dm") => void;
  toTaskConversation: (parentChannelId: string, taskId: string, routeKind?: "channel" | "dm", onNavigated?: () => void) => void;
}

/** Open a resolved place: one route per kind, never a sub-conversation as a page. */
export function openMessagePlace(place: MessagePlace, nav: MessagePlaceNav): void {
  switch (place.kind) {
    case "dm":
      nav.toDmMessage(place.channelId, place.messageId);
      return;
    case "thread":
      nav.toThreadMessage(place.parentChannelId, place.parentMessageId, place.messageId, place.parentRouteKind);
      return;
    case "task":
      // The task's own conversation over its channel, then the message in it:
      // the route carries the conversation (task=…:task:<id>), and the focus is
      // set once the route has moved, so the URL projection keeps it.
      nav.toTaskConversation(place.parentChannelId, place.taskId, place.parentRouteKind, () => {
        // The route has moved but React has not applied it yet: bring the side
        // panels in line with the new URL first. Otherwise the store→URL sync
        // that openTaskConversation triggers writes the old ones back onto it
        // (the agent's profile panel the click came from, a side thread from
        // another channel) and pushes a second history entry.
        if (typeof window !== "undefined") syncRightPanelStoresFromSearch(window.location.search);
        useThreadStore.getState().openTaskConversation({
          taskId: place.taskId,
          parentChannelId: place.parentChannelId,
          conversationChannelId: place.conversationChannelId,
          focusedMessageId: place.messageId,
        });
      });
      return;
    default:
      nav.toMessage(place.channelId, place.messageId);
  }
}

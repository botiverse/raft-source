import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import type { IntlShape } from "react-intl";
import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { Message } from "../../store/messageStore";
import type { ServerMember } from "../../store/serverStore";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { resolveThreadHeaderOriginal } from "./threadHeaderTitle";
import { openThreadParentInConversation } from "./threadParentConversation";
import { useThreadParentOutOfView } from "./useThreadParentOutOfView";
import type { ThreadParentGlimpse } from "./useThreadParent";

/**
 * The thread head's title and place name (#proj-chat:#31 v3; raft-design conversation.md, Threads): what the title
 * can say about the message the thread started from, whether that message has scrolled out of view (the title then
 * names it), and the place name's and View in channel's command, which locates it in its conversation.
 */
export function useThreadHeaderTitle({
  parentMessage,
  parentHistoryGlimpse,
  parentUnavailable,
  hideParentMessage,
  showHeader,
  conversationKey,
  replyRegionRef,
  agentById,
  memberById,
  currentUser,
  formatMessage,
  isDesktop,
  presentation,
  pathname,
  parentChannelId,
  parentMessageId,
  parentRouteKind,
  serverSlug,
  navigate,
}: {
  /** The parent as the panel shows it (null where it hides it). */
  parentMessage: Message | null;
  /** The parent behind the plan's history window, as far as it is known (useThreadParent). */
  parentHistoryGlimpse: ThreadParentGlimpse | null;
  parentUnavailable: boolean;
  hideParentMessage: boolean;
  showHeader: boolean;
  conversationKey: string | null;
  replyRegionRef: RefObject<HTMLDivElement | null>;
  agentById: Map<string, Agent>;
  memberById: Map<string, ServerMember>;
  currentUser: User | null;
  formatMessage: IntlShape["formatMessage"];
  isDesktop: boolean;
  presentation: "side" | "modal" | "mobile-modal";
  pathname: string;
  parentChannelId: string | null;
  parentMessageId: string | null;
  parentRouteKind: "dm" | "channel" | null;
  serverSlug: string | undefined;
  navigate: Parameters<typeof openThreadParentInConversation>[0]["navigate"];
}) {
  const glimpse = hideParentMessage ? null : parentHistoryGlimpse;
  const sender = parentMessage ?? (glimpse?.senderType && glimpse.senderId ? { senderType: glimpse.senderType, senderId: glimpse.senderId } : null);
  const senderAgent = sender?.senderType === "agent" ? agentById.get(sender.senderId) : undefined;
  const senderMember = sender ? resolveMessageSenderMember(sender, memberById, currentUser) : undefined;
  const senderName = senderAgent?.displayName || senderAgent?.name || senderMember?.displayName || senderMember?.name || null;
  const headerOriginal = useMemo(
    () => resolveThreadHeaderOriginal({ parentMessage, glimpse, unavailable: !hideParentMessage && parentUnavailable, senderName, formatMessage }),
    [formatMessage, glimpse, hideParentMessage, parentMessage, parentUnavailable, senderName],
  );
  const parentRowOutOfView = useThreadParentOutOfView(replyRegionRef, showHeader && !hideParentMessage && !!parentMessage, conversationKey);
  // Behind the plan's window the parent is never a row of the list (the history paywall leads it): never in view.
  const parentOutOfView = parentMessage ? parentRowOutOfView : !!glimpse;
  const handleOpenParentChannelAction = useCallback(() => {
    if (!parentMessageId || !parentChannelId) return;
    // Reserves the canonical ?msg= URL before navigating, then clears the store
    // synchronously (rightPanelUrlSync); beside its own conversation on a
    // desktop it locates the parent in place and the thread stays open.
    openThreadParentInConversation({
      original: headerOriginal,
      isDesktop,
      presentation,
      currentPathname: pathname,
      parentRouteKind: parentRouteKind === "dm" ? "dm" : "channel",
      parentChannelId,
      parentMessageId,
      serverSlug,
      navigate,
    });
  }, [headerOriginal, isDesktop, navigate, parentChannelId, parentMessageId, parentRouteKind, pathname, presentation, serverSlug]);
  return { headerOriginal, parentOutOfView, handleOpenParentChannelAction };
}

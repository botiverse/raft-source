import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { ConversationLoading } from "../../boot/bootSkeletons";
import { isThreadMismatch } from "../../utils/messageLinkLanding";
import { conversationPathOf, serverPathOf, useLandedMessageLink } from "./deepLinksFlag";
import MessageLinkUnavailable from "./MessageLinkUnavailable";

/**
 * Deep links v1 (item d): what a message link this page landed on shows
 * instead of the conversation, or null to show the conversation. A `thread`
 * naming another conversation rejects the whole link (waiting for the flag
 * rather than opening it first); a conversation that can't be read shows the
 * same "Message not found" as a missing message. Flag off: null, as before.
 */
export function useMessageLinkLandingBlock(channelId: string, conversationMissing: boolean): ReactNode | null {
  const location = useLocation();
  const { formatMessage } = useIntl();
  const link = useLandedMessageLink(location.pathname, location.search);
  const target = link.target?.channelId === channelId ? link.target : null;
  if (!target) return null;
  if (isThreadMismatch(target)) {
    if (!link.resolved) return <ConversationLoading label={formatMessage({ id: "layout.main.loadingChannel" })} />;
    return link.enabled ? <MessageLinkUnavailable backTo={conversationPathOf(target)} /> : null;
  }
  if (conversationMissing && link.enabled) return <MessageLinkUnavailable backTo={serverPathOf(target)} />;
  return null;
}

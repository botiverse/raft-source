import { useCallback, useMemo } from "react";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { useAgentStore } from "../../store/agentStore";
import type { useAuthStore } from "../../store/authStore";
import type { useChannelStore } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import type { useServerStore } from "../../store/serverStore";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import QuotedMessageCard from "../ui/cards/QuotedMessageCard";
import { delegatedByOf, isRetractedMessage } from "./delegatedMessage";
import { buildQuotedMessageAttachmentLabel } from "./quotedMessagePermalink";

export function QuoteCardContent({
  target,
  channelArchived,
  channel,
  permalink,
  agents,
  members,
  currentUser,
  onOpen,
}: {
  target: Message;
  channelArchived: boolean;
  channel: ReturnType<typeof useChannelStore.getState>["channels"][number] | undefined;
  permalink: ParsedRaftPermalink;
  agents: ReturnType<typeof useAgentStore.getState>["agents"];
  members: ReturnType<typeof useServerStore.getState>["members"];
  currentUser: ReturnType<typeof useAuthStore.getState>["user"];
  onOpen: (permalink: ParsedRaftPermalink) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const agent = target.senderType === "agent" ? agents.find((entry) => entry.id === target.senderId) : null;
  const member = resolveMessageSenderMemberFromList(target, members, currentUser) ?? null;
  const attachmentLabel = buildQuotedMessageAttachmentLabel(target.attachments, formatMessage);
  const isArchived = channelArchived || (channel ? !!channel.archivedAt : false);

  const delegatedByRaw = (target as { delegatedBy?: unknown }).delegatedBy;
  const delegatedByLabel = useMemo(() => {
    const delegatedBy = target.senderType === "user" ? delegatedByOf({ delegatedBy: delegatedByRaw }) : null;
    if (!delegatedBy) return undefined;
    return delegatedBy.deleted
      ? formatMessage({ id: "message.delegated.sentByDeletedInBody" })
      : formatMessage({ id: "message.delegated.sentByInBody" }, { name: delegatedBy.name });
  }, [delegatedByRaw, formatMessage, target.senderType]);

  const quoteAuthor = useMemo(() => ({
    name: target.senderName || (target.senderType === "agent"
      ? formatMessage({ id: "message.author.agentFallback" })
      : target.senderType === "external_projection"
        ? formatMessage({ id: "message.author.externalFallback" })
        : formatMessage({ id: "message.author.userFallback" })),
    kind: target.senderType,
    avatar: target.senderType === "agent"
      ? (agent?.avatarUrl ?? undefined)
      : target.senderType === "external_projection"
        ? (target.externalAuthor?.avatarUrl ?? undefined)
        : (member?.avatarUrl ?? undefined),
    subtitle: target.senderType === "agent"
      ? (agent?.description ?? undefined)
      : target.senderType === "external_projection"
        ? target.externalAuthor?.provider
        : (member?.description || member?.role || undefined),
    delegatedByLabel,
  }), [target.senderName, target.senderType, target.externalAuthor, formatMessage, agent, member, delegatedByLabel]);
  const quoteAttachments = useMemo(
    () => (attachmentLabel ? [{ label: attachmentLabel }] : undefined),
    [attachmentLabel],
  );
  const handleOpenQuote = useCallback(() => onOpen(permalink), [onOpen, permalink]);

  return (
    <QuotedMessageCard
      channelName={
        channel
          ? channel.type === "dm"
            ? (channel.peerDisplayName || channel.peerName || channel.name)
            : channel.name
          : (permalink.routeKind === "dm"
            ? formatMessage({ id: "message.quote.directMessage" })
            : formatMessage({ id: "message.quote.channelFallback" }))
      }
      channelKind={permalink.routeKind}
      isThread={Boolean(permalink.threadParentMessageId)}
      isArchived={isArchived}
      timestamp={formatShortDateTime(target.createdAt).replace(",", " ·")}
      author={quoteAuthor}
      content={target.content}
      attachments={quoteAttachments}
      onClick={handleOpenQuote}
      // RFC 077: a retracted message is quoted as one muted line, like an
      // unavailable one, never with its old words.
      unavailable={isRetractedMessage(target)}
      unavailableText={formatMessage({ id: "message.delegated.retracted" })}
    />
  );
}

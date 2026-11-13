import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import { Card, Skeleton } from "@botiverse/raft-ui";
import api from "../../api/client";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { buildQuotedMessageContextRequest } from "./messageContextRequest";
import { QuoteCardContent } from "./QuoteCardContent";
import QuotedMessageCard from "../ui/cards/QuotedMessageCard";
import { readHistoryLimitedError } from "../../store/hiddenHistoryStore";
import type { HiddenHistoryMessage } from "../../store/hiddenHistoryStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { OlderMessageNotice } from "./HistoryWindowNotices";

type PreviewState =
  | { status: "loading" }
  | { status: "loaded"; target: Message; channelArchived: boolean }
  | { status: "unavailable" }
  /** Behind the plan's history window: who sent it and when, not what. */
  | { status: "older"; target: HiddenHistoryMessage };

export default function QuotedMessagePermalinkPreview({
  permalink,
  onOpen,
  onUnavailable,
}: {
  permalink: ParsedRaftPermalink;
  onOpen: (permalink: ParsedRaftPermalink) => void;
  onUnavailable?: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  // Async-loader: re-fetch message context when `permalink` changes. The
  // reset-to-loading + async-fetch is intended — a different permalink is a
  // different message to preview. Same family as PR #2530's async-loader FPs.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setState({ status: "loading" });

    void api.get(`/messages/context/${permalink.messageId}`, buildQuotedMessageContextRequest(permalink.channelId))
      .then(({ data }) => {
        if (cancelled) return;
        const payload = data as { messages?: Message[]; channelArchived?: boolean; targetMessageId?: string };
        const messages = payload.messages ?? [];
        const targetMessageId = payload.targetMessageId ?? permalink.messageId;
        const target = messages.find((message) => message.id === targetMessageId);
        if (target) {
          setState({ status: "loaded", target, channelArchived: !!payload.channelArchived });
        } else {
          setState({ status: "unavailable" });
          onUnavailable?.();
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Older than the plan's history window: the quote keeps its header and
        // says so, with the upgrade (the link stays a link, not "unavailable").
        const older = readHistoryLimitedError(error)?.hiddenTarget?.target;
        if (older) {
          setState({ status: "older", target: older });
          return;
        }
        setState({ status: "unavailable" });
        onUnavailable?.();
      });

    return () => {
      cancelled = true;
    };
  }, [onUnavailable, permalink.channelId, permalink.messageId, permalink.threadParentMessageId]);

  const channel = useMemo(
    () => findStoredChannel({ channels, dmChannels, loungeChannels }, permalink.channelId),
    [channels, dmChannels, loungeChannels, permalink.channelId],
  );

  if (state.status === "loading") {
    return (
      <Card className="w-full">
        <div className="h-[34px] border-b border-line-hairline" />
        <div className="flex gap-3 px-3 py-2.5">
          <Skeleton className="size-7 shrink-0" />
          <div className="flex-1 stack-y-2">
            <Skeleton variant="line" className="w-32" />
            <Skeleton variant="line" className="w-full" />
            <Skeleton variant="line" className="w-3/4" />
          </div>
        </div>
      </Card>
    );
  }

  if (state.status === "unavailable") {
    return null;
  }

  if (state.status === "older") {
    return <OlderQuoteCard target={state.target} channel={channel} permalink={permalink} />;
  }

  return (
    <QuoteCardContent
      target={state.target}
      channelArchived={state.channelArchived}
      channel={channel}
      permalink={permalink}
      agents={agents}
      members={members}
      currentUser={currentUser}
      onOpen={onOpen}
    />
  );
}

/** A quoted message behind the plan's history window: its header, then the line that says so. */
function OlderQuoteCard({ target, channel, permalink }: {
  target: HiddenHistoryMessage;
  channel: Channel | undefined;
  permalink: ParsedRaftPermalink;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const author = useMemo(() => ({
    name: target.senderName || formatMessage({ id: "message.historyPaywall.unknownSender" }),
    kind: target.senderType,
    avatar: target.senderAvatarUrl ?? undefined,
  }), [formatMessage, target.senderAvatarUrl, target.senderName, target.senderType]);
  return (
    <QuotedMessageCard
      channelName={
        channel
          ? channel.type === "dm"
            ? (channel.peerDisplayName || channel.peerName || channel.name)
            : channel.name
          : formatMessage({ id: permalink.routeKind === "dm" ? "message.quote.directMessage" : "message.quote.channelFallback" })
      }
      channelKind={permalink.routeKind}
      isThread={Boolean(permalink.threadParentMessageId)}
      timestamp={formatShortDateTime(target.createdAt).replace(",", " ·")}
      author={author}
      content=""
      notice={<OlderMessageNotice surface="quoted_message" testId="quoted-message-older" />}
    />
  );
}

import { useCallback, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { History } from "lucide-react";
import { PLAN_CONFIG } from "@botiverse/raft-shared";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardLeading,
  CardTitle,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemSender,
  MessageItemTime,
  MessageListDateDivider,
  MessageListNotice,
  MessageReplies,
  MessageRepliesItem,
  MessageRepliesItemContent,
  MessageRepliesItemSender,
  MessageRepliesItemTime,
  MessageRepliesSummary,
  MessageRepliesSummaryItem,
} from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { usePaywallShown } from "../../analytics/paywall";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useHiddenHistory, useHiddenTarget } from "../../store/hiddenHistoryStore";
import type { HiddenHistory, HiddenHistoryMessage, HiddenTarget } from "../../store/hiddenHistoryStore";
import type { HistoryLimitContext } from "../../store/upgradeDialogStore";
import { hiddenMessageDateFormat } from "./historyPaywallLabels";
import InlineMarkdownPreview from "../markdown/InlineMarkdownPreview";
import AvatarSlot from "../ui/AvatarSlot";

/**
 * Where the paywall sits: a channel, a DM, a thread (whose first message lives
 * in the parent channel) or a task's own conversation. The words differ by
 * where the count sits in the zh sentence, so each has its own keys rather
 * than a spliced {noun} argument (as in HistoryTopState).
 */
export type HistoryPaywallScope = "channel" | "dm" | "thread" | "task";

type TitleArgs = { scope: HistoryPaywallScope; hidden: HiddenHistory | null; allHidden: boolean };

function titleFor({ scope, hidden, allHidden }: TitleArgs): { id: MessageId; count?: number } {
  const replies = scope === "thread";
  if (!hidden || (hidden.hiddenCount === 0 && !hidden.parentHidden)) {
    return { id: replies ? "message.historyPaywall.repliesTitleUncounted" : "message.historyPaywall.messagesTitleUncounted" };
  }
  const count = hidden.hiddenCount;
  const capped = hidden.hiddenCountCapped;
  if (replies && hidden.parentHidden) {
    if (count === 0) return { id: "message.historyPaywall.threadParentOnlyTitle" };
    if (allHidden) return { id: capped ? "message.historyPaywall.threadParentAllTitleCapped" : "message.historyPaywall.threadParentAllTitle", count };
    return { id: capped ? "message.historyPaywall.threadParentTitleCapped" : "message.historyPaywall.threadParentTitle", count };
  }
  if (replies) return { id: capped ? "message.historyPaywall.repliesTitleCapped" : "message.historyPaywall.repliesTitle", count };
  if (allHidden) {
    const keys: Record<Exclude<HistoryPaywallScope, "thread">, [MessageId, MessageId]> = {
      channel: ["message.historyPaywall.channelAllTitle", "message.historyPaywall.channelAllTitleCapped"],
      dm: ["message.historyPaywall.dmAllTitle", "message.historyPaywall.dmAllTitleCapped"],
      task: ["message.historyPaywall.taskAllTitle", "message.historyPaywall.taskAllTitleCapped"],
    };
    return { id: keys[scope][capped ? 1 : 0], count };
  }
  return { id: capped ? "message.historyPaywall.messagesTitleCapped" : "message.historyPaywall.messagesTitle", count };
}

/** Only the Free plan cuts history; this paywall is only shown there. */
const FREE_HISTORY_DAYS = PLAN_CONFIG.free.limits.messageHistoryDays;

function HiddenAvatar({ message, size = "message-row" }: { message: HiddenHistoryMessage; size?: "message-row" | "preview-mini" }) {
  if (message.senderType === "external_projection") {
    return <AvatarSlot context={size} type="app" appInitials={(message.senderName || "?").slice(0, 1).toUpperCase()} />;
  }
  return (
    <AvatarSlot
      context={size}
      type={message.senderType === "agent" ? "agent" : "human"}
      agentAvatarUrl={message.senderType === "agent" ? message.senderAvatarUrl : undefined}
      humanAvatarUrl={message.senderType === "user" ? message.senderAvatarUrl : undefined}
    />
  );
}

/** One hidden message as a message row: sender, time, its cut text (two lines at most). */
function HiddenMessageRow({ message, className, children }: { message: HiddenHistoryMessage; className?: string; children?: ReactNode }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  return (
    <MessageItem className={className} data-testid="history-paywall-row">
      <MessageItemGutter>
        <MessageItemAvatarSlot className="flex items-start"><HiddenAvatar message={message} /></MessageItemAvatarSlot>
      </MessageItemGutter>
      <MessageItemContent>
        <MessageItemHeader>
          <MessageItemSender>{message.senderName || formatMessage({ id: "message.historyPaywall.unknownSender" })}</MessageItemSender>
          <MessageItemTime render={<time dateTime={message.createdAt} />}>{formatShortDateTime(message.createdAt)}</MessageItemTime>
        </MessageItemHeader>
        <MessageItemBody className="mt-1 line-clamp-2 select-none">
          {message.preview
            ? <InlineMarkdownPreview markdown={message.preview} />
            : formatMessage({ id: "message.historyPaywall.noText" })}
        </MessageItemBody>
        {children}
      </MessageItemContent>
    </MessageItem>
  );
}

/**
 * Hidden messages as a glimpse, not a read: faded out toward the top (the
 * newest hidden, above the card) or toward the bottom (those after a jump's
 * target, under the card). `light`: the neighbors of a target, lighter than
 * it so it reads as the one in focus. Not interactive.
 */
function HiddenHistoryPreviewRows({ messages, fade = "up", light = false, testId = "history-paywall-preview" }: {
  messages: readonly HiddenHistoryMessage[];
  fade?: "up" | "down";
  light?: boolean;
  testId?: string;
}) {
  if (messages.length === 0) return null;
  // raft-ui Edges fade (spacing.md): a glimpse of hidden history fades over
  // the content length, 48px, as a mask.
  const mask = fade === "up" ? "mask-fade-t" : "mask-fade-b";
  return (
    <div aria-hidden className={`pointer-events-none select-none ${light ? "opacity-40" : "opacity-70"} ${mask}`} data-testid={testId}>
      {messages.map((message) => <HiddenMessageRow key={message.id} message={message} />)}
    </div>
  );
}

/**
 * The message a jump pointed at, behind the window: evenly muted, its first
 * 80 characters, between lighter neighbors (cindyz, task #8, frame 4‴). When
 * it starts a thread that goes on inside the window, its reply box stays: in
 * the channel it is the only way into that thread (frame 6b).
 */
function HiddenTargetRow({ target, onOpenReplies }: { target: HiddenTarget; onOpenReplies?: () => void }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const replies = target.replies;
  return (
    <div data-testid="history-paywall-target">
      <HiddenMessageRow message={target.target} className="opacity-60">
        {replies && onOpenReplies ? (
          <MessageReplies onClick={onOpenReplies} data-testid="history-paywall-target-replies">
            <MessageRepliesSummary>
              <MessageRepliesSummaryItem>{formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: replies.count })}</MessageRepliesSummaryItem>
            </MessageRepliesSummary>
            <MessageRepliesItem>
              <HiddenAvatar message={replies.latest} size="preview-mini" />
              <MessageRepliesItemSender>{replies.latest.senderName || formatMessage({ id: "message.historyPaywall.unknownSender" })}</MessageRepliesItemSender>
              <MessageRepliesItemContent>{replies.latest.preview ?? formatMessage({ id: "message.historyPaywall.noText" })}</MessageRepliesItemContent>
              <MessageRepliesItemTime>{formatShortDateTime(replies.latest.createdAt)}</MessageRepliesItemTime>
            </MessageRepliesItem>
          </MessageReplies>
        ) : null}
      </HiddenMessageRow>
    </div>
  );
}

/**
 * What the dialog's line says about this paywall: the message a link opened,
 * or how many older messages the conversation has (a named channel by its
 * name). Nothing when the count is unknown or only a thread's first message hides.
 */
function historyContextFor({ scope, hidden, target, channelName }: {
  scope: HistoryPaywallScope;
  hidden: HiddenHistory | null;
  target: HiddenTarget | null;
  channelName?: string;
}): HistoryLimitContext | undefined {
  if (target) return { kind: "target", sentAt: target.target.createdAt };
  if (!hidden || hidden.hiddenCount === 0) return undefined;
  const counted = { count: hidden.hiddenCount, capped: hidden.hiddenCountCapped };
  if (scope === "channel" && channelName) return { kind: "channel", channel: channelName, ...counted };
  return { kind: scope === "thread" ? "thread" : "conversation", ...counted };
}

/**
 * The card itself: what the 30-day window hides here, and Upgrade to Pro (the
 * upgrade dialog, gate `history_30d`, told what hides here). Lists that leave
 * old items out (search, Saved, a channel's files) say so in a Banner instead
 * (HistoryWindowNotices).
 */
function HistoryPaywallCard({ titleId, title, description, context }: {
  titleId: string;
  title: string;
  description: string;
  context?: HistoryLimitContext;
}) {
  const { formatMessage } = useIntl();
  const upgrade = usePaywallUpgrade();
  const openUpgrade = useCallback(() => upgrade("history_30d", "conversation", context), [context, upgrade]);
  usePaywallShown("history_30d", "conversation");
  return (
    <Card>
      <CardHeader>
        {/* History, not a lock: in the Raft DS a lock is a private channel. */}
        <CardLeading>
          <History size={20} aria-hidden />
        </CardLeading>
        <CardTitle id={titleId} render={<h3>{title}</h3>} />
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="primary" size="md" onClick={openUpgrade} data-testid="history-paywall-upgrade">
          {formatMessage({ id: "billing.upgradeToPro" })}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The history paywall at the start of what a Free server shows of a channel,
 * DM, thread or task conversation: a faded glimpse of the newest hidden
 * messages (a thread's hidden first message leads), then a card that says how
 * many the 30-day window hides, with Upgrade to Pro (the upgrade dialog). It
 * takes the place of the history notice at the top of the list, and of the
 * empty state when every message is hidden (`allHidden`). When only system
 * lines hide, there is no glimpse, only the card (cindyz, task #8).
 */
export default function HistoryPaywall({ channelId, scope, channelName, allHidden = false, recentDivider = false, mode = "start", onOpenReplies }: {
  /** The channel or thread whose message page carried `hiddenHistory`, or whose jump answered `history_limited`. */
  channelId: string;
  scope: HistoryPaywallScope;
  /** A named channel's name as people read it (`#roadmap`), for the upgrade dialog's line. */
  channelName?: string;
  /** Nothing in the window: say so under the card. */
  allHidden?: boolean;
  /** Visible messages follow and no date divider carries "last 30 days" (threads have none): a divider of its own. */
  recentDivider?: boolean;
  /** `target`: a jump pointed at a message behind the window; the paywall centers on it (frames 4, 5, 6b, 8, 9). */
  mode?: "start" | "target";
  /** The target starts a thread that goes on: its reply box opens it. */
  onOpenReplies?: () => void;
}) {
  const { formatMessage } = useIntl();
  const { options } = useTimeFormatter();
  const hidden = useHiddenHistory(channelId);
  const hiddenTarget = useHiddenTarget(channelId);
  const target = mode === "target" ? hiddenTarget : null;
  const titleId = useId();
  const days = FREE_HISTORY_DAYS;
  let title: string;
  let description: string;
  if (target) {
    const date = new Date(target.target.createdAt).toLocaleDateString(options.locale, hiddenMessageDateFormat(target.target.createdAt, options.timeZone));
    if (scope === "thread") {
      title = formatMessage({ id: "message.historyPaywall.targetReplyTitle" }, { days });
      const counts = target.thread;
      description = formatMessage({
        id: counts?.parentHidden
          ? counts.hiddenReplyCountCapped ? "message.historyPaywall.targetReplyDescriptionParentCapped" : "message.historyPaywall.targetReplyDescriptionParent"
          : counts?.hiddenReplyCountCapped ? "message.historyPaywall.targetReplyDescriptionCapped" : "message.historyPaywall.targetReplyDescription",
      }, { date, days, count: counts?.hiddenReplyCount ?? 1 });
    } else {
      title = formatMessage({ id: target.replies ? "message.historyPaywall.targetThreadTitle" : "message.historyPaywall.targetTitle" }, { days });
      description = formatMessage({ id: "message.historyPaywall.targetDescription" }, { date, days });
    }
  } else {
    const { id, count } = titleFor({ scope, hidden, allHidden });
    title = formatMessage({ id }, { count, days });
    description = formatMessage({ id: "message.historyPaywall.description" }, { days });
  }
  const context = useMemo(() => historyContextFor({ scope, hidden, target, channelName }), [channelName, hidden, scope, target]);

  return (
    <section aria-labelledby={titleId} className="mb-3 flex flex-col gap-2" data-testid="history-paywall" data-mode={target ? "target" : "start"}>
      {target ? (
        <div>
          <HiddenHistoryPreviewRows messages={target.before} light />
          <HiddenTargetRow target={target} onOpenReplies={onOpenReplies} />
        </div>
      ) : hidden ? <HiddenHistoryPreviewRows messages={hidden.latest} /> : null}
      <HistoryPaywallCard titleId={titleId} title={title} description={description} context={context} />
      {target ? <HiddenHistoryPreviewRows messages={target.after} fade="down" light testId="history-paywall-after" /> : null}
      {allHidden ? (
        <MessageListNotice tone="muted" className="pt-3" data-testid="history-paywall-none-recent">
          {formatMessage({ id: scope === "thread" ? "message.historyPaywall.noRecentReplies" : "message.historyPaywall.noRecentMessages" }, { days })}
        </MessageListNotice>
      ) : recentDivider ? (
        <MessageListDateDivider data-testid="history-paywall-recent-divider">
          {formatMessage({ id: "message.historyPaywall.recentDivider" }, { days })}
        </MessageListDateDivider>
      ) : null}
    </section>
  );
}

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { DropdownMenuItem, PanelAction, PanelMeta, PanelTitle, TextLink } from "@botiverse/raft-ui";
import type { SideSectionHead } from "../../components/task/sideSectionDrag";
import Tooltip from "../../components/ui/Tooltip";
import PanelHeader from "../../components/ui/PanelHeader";
import ThreadOverflowMenu from "../../components/message/ThreadOverflowMenu";
import { RowExpandAction } from "../../components/layout/RowExpandAction";
import ThreadAgentFollowers from "../../components/thread/ThreadAgentFollowers";
import { RowTabs } from "../../components/layout/RowTabs";
import { useRowExpand, useRowPlanStore, useRowTabs } from "../../components/layout/rowPlanStore";
import { useThreadRowState } from "../../components/layout/threadRowState";
import { FOLLOWERS_HEAD_WIDTH, shownOwnActions, useHeadWidth } from "../../components/layout/headFit";
import { useThreadAgentFollowerStore } from "../../store/threadAgentFollowerStore";
import type { Channel } from "../../store/channelStore";
import { LoungeAvatar } from "../../components/agent/LoungeAvatar";
import type { HiddenHistory } from "../../store/hiddenHistoryStore";
import type { Message } from "../../store/messageStore";
import type { ThreadSummary } from "../../store/threadStore";
import { THREAD_HEADER_CONTAINER_CLASS_NAME, THREAD_HEADER_SUBTITLE_CLASS_NAME, THREAD_MOBILE_BACK_PROPS } from "./threadPanelChrome";
import { ColumnMoveMenuItems } from "../../components/layout/ColumnMoveMenu";
import { useMessageOutlineStore } from "../../store/messageOutlineStore";
import { hasOutline, openOutlineList } from "../conversation-outline/outlineListStore";

/** The subtitle's channel name: its own width, at most the subtitle's, ellipsized there. */
const THREAD_SUBTITLE_LEAD_CLASS_NAME = "max-w-full shrink-0 truncate";

/**
 * The thread panel's head: its title (a jump to the first reply), the parent
 * channel and reply count, the agents following it, the thread menu, and
 * Back / Close as the presentation calls for.
 */
export function ThreadPanelHeader({
  headerLeading,
  headerDrag,
  presentation,
  mobileBackHandler,
  handleClose,
  closeButtonClassName,
  jumpToThreadStart,
  parentChannelId,
  parentMessageId,
  threadChannelId,
  parentChannel,
  parentLoungeTitle,
  messages,
  historyLimited,
  hiddenThreadHistory,
  displayedParentThreadSummary,
  loading,
  repliesLoadFailed,
  handleOpenParentChannelAction,
  handleOpenThreadSearch,
  allowExpand,
}: {
  headerLeading: ReactNode;
  headerDrag: SideSectionHead | undefined;
  presentation: "side" | "modal" | "mobile-modal";
  mobileBackHandler: () => void;
  handleClose: () => void;
  closeButtonClassName: string;
  jumpToThreadStart: () => Promise<void>;
  parentChannelId: string | null;
  parentMessageId: string | null;
  threadChannelId: string | null;
  /** The parent conversation's stored row, from any slice (useThreadParentChannel). */
  parentChannel: Channel | null;
  /** "{Name}'s Lounge" when the parent is a Lounge. */
  parentLoungeTitle?: string;
  messages: Message[];
  historyLimited: boolean;
  hiddenThreadHistory: HiddenHistory | null;
  displayedParentThreadSummary: ThreadSummary | undefined;
  loading: boolean;
  repliesLoadFailed: boolean;
  handleOpenParentChannelAction: () => void;
  handleOpenThreadSearch: () => void;
  allowExpand: boolean;
}) {
  const { formatMessage } = useIntl();
  // Its column holds the columns the row couldn't give 160 (#189 rule 4): their tabs in place of its title.
  const rowTabs = useRowTabs("thread");
  // The head always fits (#189 rule 6): its own action, the followers, folds into ⋯ where it doesn't; ⋯, Expand and
  // Close never fold. Folded over the conversation it has Back at its start and no Close.
  const [measure, headWidth, headElement] = useHeadWidth();
  const roster = useThreadAgentFollowerStore((state) => (threadChannelId ? state.rosters[threadChannelId] : undefined));
  const hasFollowers = !!threadChannelId && !!roster && (roster.error || (roster.loaded && roster.agents.length > 0));
  const folded = useRowPlanStore((s) => !!s.plan?.fold);
  const expand = useRowExpand("thread");
  // Its Expand is Focus Mode, which the row applies only to a thread beside its own conversation, the one open
  // (useThreadRowState): shown exactly where pressing it works, as every other head's (#189 rule 5).
  const focusApplies = useThreadRowState().focusApplies;
  const expandShown = presentation === "side" && allowExpand && expand.shown && focusApplies;
  const followersShown = shownOwnActions({
    width: presentation === "side" ? headWidth : 0,
    lead: (folded ? 1 : 0) + (headerLeading ? 1 : 0),
    own: hasFollowers ? [FOLLOWERS_HEAD_WIDTH] : [],
    controls: (expandShown ? 1 : 0) + (folded ? 0 : 1),
    menuItems: 1,
    tabs: !!rowTabs,
  }) > 0;
  const [followersOpen, setFollowersOpen] = useState(false);
  const openFollowers = useCallback(() => setFollowersOpen(true), []);
  const foldedFollowers = useMemo(
    () => (followersShown ? undefined : { open: followersOpen, onOpenChange: setFollowersOpen, anchor: headElement }),
    [followersOpen, followersShown, headElement],
  );
  // Timeline: the outline as a list, on every device, once the thread has one (ConversationOutline).
  const timelineShown = useMessageOutlineStore((s) => !!threadChannelId && hasOutline(s.byChannel[threadChannelId]?.items ?? [], parentMessageId));
  const openTimeline = useCallback((trigger: HTMLElement | null) => {
    if (threadChannelId) openOutlineList(threadChannelId, trigger ?? headElement);
  }, [headElement, threadChannelId]);
  const threadContainerProps = useMemo(() => (headerDrag
    ? { ...headerDrag.props, ref: measure, className: `${THREAD_HEADER_CONTAINER_CLASS_NAME} ${headerDrag.props.className ?? ""}` }
    : { ref: measure, className: THREAD_HEADER_CONTAINER_CLASS_NAME }), [headerDrag, measure]);

  // Stryker disable all: header action wiring is browser-smoke verified.
  // Thread commands live in the menu; structural Back and Close stay in the header.
  const openParentChannelLabel = formatMessage({ id: "message.threadPanel.viewInChannel" });

  const threadContextActions = (
    <>
    <ThreadOverflowMenu
      threadChannelId={threadChannelId}
      parentMessageId={parentMessageId}
      viewInChannelLabel={openParentChannelLabel}
      onViewInChannel={handleOpenParentChannelAction}
      onSearch={handleOpenThreadSearch}
      onTimeline={timelineShown ? openTimeline : undefined}
      leadingItems={hasFollowers && !followersShown ? (
        <DropdownMenuItem onClick={openFollowers} data-testid="thread-overflow-followers">
          {formatMessage({ id: "thread.followers.title" })}
        </DropdownMenuItem>
      ) : undefined}
      // Move Left / Move Right where it stands in the row and can move (#189 rule 7).
      trailingItems={presentation === "side" ? <ColumnMoveMenuItems region="thread" /> : undefined}
    />
    {/* Its Expand (Focus Mode; #189 rule 5), a window control right before Close, after ⋯ and never in it (stdrc, 2026-11-03).
        Shown where the row's plan shows it (RowExpandAction) and Focus Mode applies, whatever the channel lists hold
        (an Agent Lounge's thread, one still loading) or the route (stdrc, 2026-11-04). `allowExpand`: the panel is the
        row's thread column. */}
    {expandShown ? <RowExpandAction region="thread" testId="thread-focus-mode" /> : null}
    </>
  );
  const showCloseButton = presentation !== "mobile-modal";
  // Stryker restore all

  return (
    <PanelHeader
      leading={headerLeading}
      onMobileBack={mobileBackHandler}
      mobileBackProps={THREAD_MOBILE_BACK_PROPS}
      containerProps={threadContainerProps}
      // In modal presentation the back chevron is the close affordance, so
      // it should hide once the Rail kicks in (md+, centered card). In side
      // presentation the chevron stays through to lg- (mobile full-screen).
      mobileBreakpoint={presentation === "side" ? "lg" : "md"}
      titleSlot={rowTabs ? <><RowTabs region="thread" />{headerDrag?.grip}</> : (
        // One line from 768px, with a mouse or by touch, as every head (raft-ui
        // PanelHeaderContent, 0.80): "Thread  #all · 2 replies", the subtitle
        // giving up its room first; two lines on a phone.
        <div className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-2">
          {/* Absolute along the head's top edge (task v2's side columns): not one of the head's first or last controls. */}
          {headerDrag?.grip}
          <Tooltip content={formatMessage({ id: "message.threadPanel.scrollToFirst" })}>
          <PanelTitle
            render={(
              <button
                type="button"
                onClick={() => { void jumpToThreadStart(); }}
                aria-label={formatMessage({ id: "message.threadPanel.scrollThreadToFirst" })}
                data-testid="thread-scroll-to-top"
              />
            )}
            // A text-only control outside prose: no underline at rest, the
            // underline on hover (clickable-affordance contract). It hugs its
            // word, so the head's empty room isn't hovering it (Expand moves
            // the head's buttons out from under the pointer; #189 rule 5).
            className="block min-w-0 max-w-full self-start md:pointer-fine:shrink-0 md:pointer-fine:self-auto truncate rounded-sticker text-left decoration-[1.5px] underline-offset-[3px] outline-none hover:underline focus-visible:shadow-focus"
          >
            {formatMessage({ id: "message.threadPanel.thread" })}
          </PanelTitle>
          </Tooltip>
          {parentChannelId && (() => {
            // Stryker disable all: pre-existing parent label resolution is outside the workspace mutation corpus.
            const ch = parentChannel;
            if (!ch) return null;
            const label = ch.type === "dm"
              ? `@${ch.peerDisplayName || ch.peerName || ch.name}`
              : ch.loungeAgentId && parentLoungeTitle
                ? parentLoungeTitle
                : formatMessage({ id: "message.threadPanel.channelContext" }, { name: ch.name });
            // Stryker restore all
            const replyCount = Math.max(messages.length + (historyLimited ? hiddenThreadHistory?.hiddenCount ?? 0 : 0), displayedParentThreadSummary?.replyCount ?? 0);
            // Until the replies are read, a count we don't know isn't "0 replies".
            const replyCountUnknown = replyCount === 0 && (loading || repliesLoadFailed);
            return (
              // A row whose end ellipsizes, as a title does (#189 rule 6): the channel name first, a link (a
              // button, which a line's ellipsis can't cut into), ellipsizing itself where it is all there is room for;
              // the count after it in what is left.
              <PanelMeta render={<p />} className={`${THREAD_HEADER_SUBTITLE_CLASS_NAME} flex`} data-testid="thread-header-subtitle">
                {/* A Lounge's thread names its place with the Lounge's face too (LoungeAvatar). */}
                {/* Decorative: the name after it says which Lounge (an agent's image carries alt text). */}
                {ch.loungeAgentId ? (
                  <span aria-hidden="true" className="mr-1.5 inline-flex shrink-0 self-center" data-testid="thread-header-lounge-face">
                    <LoungeAvatar agentId={ch.loungeAgentId} context="sidebar-list" />
                  </span>
                ) : null}
                {/* The channel name does what View in Channel does. */}
                {/* Not in a sentence: the channel name underlines on hover only,
                    like the forwarded "from #channel" source and the sender name. */}
                {parentMessageId ? (
                  <Tooltip content={openParentChannelLabel}>
                    <TextLink onClick={handleOpenParentChannelAction} className={THREAD_SUBTITLE_LEAD_CLASS_NAME} data-testid="thread-header-channel-link">
                      {label}
                    </TextLink>
                  </Tooltip>
                ) : <span className={THREAD_SUBTITLE_LEAD_CLASS_NAME}>{label}</span>}
                {/* Every reply, the ones behind the history window too, so it agrees with the paywall's count. */}
                {replyCountUnknown ? null : (
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre" data-testid="thread-header-reply-count">
                    {" · "}
                    {formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: replyCount })}
                  </span>
                )}
              </PanelMeta>
            );
          })()}
        </div>
      )}
      actions={
        <>
          {threadChannelId && (
            <ThreadAgentFollowers
              threadChannelId={threadChannelId}
              variant="header"
              folded={foldedFollowers}
            />
          )}
          {threadContextActions}
          {/*
            X close button.
            - modal (centered card): X is the standard dialog close.
            - mobile-modal (full-screen overlay): NO X — back chevron is
              the close affordance.
            - side: X on desktop (lg+), back chevron on mobile.
            Per stdrc 2026-05-21 #proj-task:287f18ce msg=804c045d.
          */}
          {showCloseButton && (
            <Tooltip content={formatMessage({ id: "message.threadPanel.closeThread" })}>
            <PanelAction
              onClick={handleClose}
              className={closeButtonClassName}
              aria-label={formatMessage({ id: "common.close" })}
              data-testid="thread-close"
            >
              <X />
            </PanelAction>
            </Tooltip>
          )}
        </>
      }
    />
  );
}

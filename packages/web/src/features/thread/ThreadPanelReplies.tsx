import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { ArrowDown } from "lucide-react";
import { MessageListEndFade, ScrollArea, ThreadPanelBody } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import { MessageListJumpPill } from "@botiverse/raft-ui/wip";
import type { SyncScopeKey } from "@botiverse/raft-shared";
import { END_FADE_ABOVE_COMPOSER } from "../../components/message/composerHost";
import { MessageForwardContext } from "../../components/message/messageForwardContext";
import { AgentTypingLine, END_FADE_UNDER_AGENT_TYPING_LINE_CLASS } from "../../components/message/AgentTypingLine";
import type { Agent } from "../../store/agentStore";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import type { ServerMember } from "../../store/serverStore";
import type { Task } from "../../store/taskStore";
import type { ThreadSummary } from "../../store/threadStore";
import HistoryLimitBanner from "../../components/message/HistoryLimitBanner";
import HistoryPaywall from "../../components/message/HistoryPaywall";
import MessageItem from "../../components/message/MessageItem";
import type { MentionEntry } from "../../components/message/MessageItem";
import { ConversationOutline } from "../conversation-outline/ConversationOutline";
import { OpenThreadContext } from "../../components/message/threadUnreadHold";
import type { OpenThreadIdentity } from "../../components/message/threadUnreadHold";
import EmptyState from "../../components/ui/EmptyState";
import { SELECT_MODE_LIST_RESERVE_CLASS } from "../../components/message/SelectModeToolbar";
import { useSelectToHere } from "../../components/message/useSelectToHere";
import { BottomJumpControls } from "../../components/message/BottomJumpControls";
import MessageTimeline from "../../components/message/MessageTimeline";
import type { MessageTimelineHandle, MessageTimelineLeadingRow, MessageTimelineProps, MessageTimelineSource } from "../../components/message/MessageTimeline";
import type { VisibleMessageWindowStore } from "../../components/message/VisibleMessageTranslations";
import { ThreadRepliesLoadFailed, ThreadRepliesLoading } from "../../components/message/ThreadRepliesLoading";
import { ParentSlotMount } from "./ParentSlotMount";
import { THREAD_PANEL_PARENT_CLASS_NAME } from "./threadPanelChrome";

/**
 * The replies' region: the parent and a placeholder while they load, the
 * empty (or history-limited) state, or the replies' MessageTimeline, with the
 * agent typing line, the list's end fade and the jump back to the bottom.
 */
export function ThreadPanelReplies({
  replyRegionRef,
  threadContentLayerClassName,
  selectModeListEnd,
  selectableIds,
  showForwardAction,
  forwardSingleMessage,
  openThread,
  parentSlot,
  parentSlotHost,
  loading,
  messages,
  displayedParentMessageWithThreadId,
  mentionMap,
  channels,
  displayedParentThreadSummary,
  displayedParentTask,
  parentSourceTasks,
  getPreviewSenderAgent,
  getPreviewSenderMember,
  threadMentionComposerChannelId,
  parentReactionParentScopeKey,
  canReactToThread,
  onOpenProfile,
  activeThreadSearchMessageId,
  threadSearchQuery,
  repliesLoadingSince,
  repliesLoadFailed,
  handleRetryRepliesLoad,
  historyLimited,
  threadChannelId,
  focusTargetMissing,
  showsHiddenTarget,
  threadPaywallScope,
  emptyState,
  timelineRef,
  threadSource,
  renderThreadItem,
  threadFoldedMessageIds,
  threadLeadingRows,
  renderThreadLeadingRow,
  threadFooter,
  handleAtBottomStateChange,
  translationWindow,
  showComposer,
  typingChannelId,
  parentMessageId,
  showBottomButton,
  handleBottomButton,
  newMessageCount,
  outlineRail,
  focusTargetId,
}: {
  replyRegionRef: RefObject<HTMLDivElement | null>;
  threadContentLayerClassName: string;
  selectModeListEnd: boolean;
  /** What a range takes in this thread (its select-all's ids): Select to here's skip rules. */
  selectableIds: readonly string[];
  showForwardAction: boolean;
  forwardSingleMessage: (message: Message) => void;
  openThread: OpenThreadIdentity;
  parentSlot: ReactNode;
  parentSlotHost: HTMLDivElement;
  loading: boolean;
  messages: Message[];
  displayedParentMessageWithThreadId: Message | null;
  mentionMap: Map<string, MentionEntry>;
  channels: Channel[];
  displayedParentThreadSummary: ThreadSummary | undefined;
  displayedParentTask: Task | null;
  parentSourceTasks: Task[];
  getPreviewSenderAgent: (message: Message) => Agent | undefined;
  getPreviewSenderMember: (message: Message) => ServerMember | undefined;
  threadMentionComposerChannelId: string | undefined;
  parentReactionParentScopeKey: SyncScopeKey | undefined;
  canReactToThread: boolean;
  onOpenProfile: ((kind: "agent" | "human", id: string) => void) | undefined;
  activeThreadSearchMessageId: string | null;
  threadSearchQuery: string;
  repliesLoadingSince: number;
  repliesLoadFailed: boolean;
  handleRetryRepliesLoad: () => void;
  historyLimited: boolean;
  threadChannelId: string | null;
  focusTargetMissing: boolean;
  showsHiddenTarget: boolean;
  threadPaywallScope: "thread" | "task";
  emptyState: ReactNode;
  timelineRef: RefObject<MessageTimelineHandle | null>;
  threadSource: MessageTimelineSource;
  renderThreadItem: MessageTimelineProps["renderItem"];
  threadFoldedMessageIds: MessageTimelineProps["foldedMessageIds"];
  threadLeadingRows: MessageTimelineLeadingRow[];
  renderThreadLeadingRow: MessageTimelineProps["renderLeadingRow"];
  threadFooter: ReactNode;
  handleAtBottomStateChange: (atBottom: boolean) => void;
  translationWindow: VisibleMessageWindowStore;
  showComposer: boolean;
  typingChannelId: string | null;
  parentMessageId: string | null;
  showBottomButton: boolean;
  handleBottomButton: () => void | Promise<void>;
  newMessageCount: number;
  outlineRail: { onJump: (messageId: string) => void; hrefFor: (messageId: string) => string; leadingMessageId: string | null };
  focusTargetId: string | null;
}) {
  const { formatMessage } = useIntl();
  // Select to here: its pill is first on the bottom controls' line while the selection's anchor is out of view.
  const selectToHere = useSelectToHere({ timelineRef, active: selectModeListEnd, selectableIds });
  return (
    <ThreadPanelBody
      ref={replyRegionRef}
      tabIndex={-1}
      aria-busy={loading || undefined}
      className={`${threadContentLayerClassName} outline-none ${selectModeListEnd ? SELECT_MODE_LIST_RESERVE_CLASS : ""}`}
    >
      <MessageForwardContext.Provider value={showForwardAction ? forwardSingleMessage : null}>
      <OpenThreadContext.Provider value={openThread}>
      {parentSlot ? createPortal(parentSlot, parentSlotHost) : null}
      {loading ? (
        // Before the replies' timeline mounts, the parent and the placeholder scroll in
        // a raft-ui ScrollArea (vertical, as the timeline); its gutters layer is the
        // column's zero-height first row.
        <ScrollArea className="flex h-full flex-col" data-testid="thread-replies-placeholder-scroll">
          {parentSlot ? <ParentSlotMount host={parentSlotHost} /> : null}
          {displayedParentMessageWithThreadId && (
            <div data-testid="thread-panel-parent" className={THREAD_PANEL_PARENT_CLASS_NAME}>
              <MessageItem
                message={displayedParentMessageWithThreadId}
                mentionMap={mentionMap}
                channels={channels}
                threadSummary={displayedParentThreadSummary}
                linkedTask={displayedParentTask ?? (parentSourceTasks.length === 1 ? parentSourceTasks[0] : undefined)}
          linkedTasks={parentSourceTasks}
                previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
                previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
                mentionComposerChannelId={threadMentionComposerChannelId}
                reactionParentScopeKey={parentReactionParentScopeKey}
                canReact={canReactToThread}
                hideThreadActions
                showThreadFollowAction
                senderAvatarTestId="thread-parent-avatar"
                onOpenProfile={onOpenProfile}
                threadSearchHighlightQuery={
                  displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
                }
              />
            </div>
          )}
          {/* Keyed by whether the parent is in: when the parent message
              lands above the placeholder, a new placeholder takes the
              rows under it, rather than the old one being pushed down
              and off the screen (a layout shift of the whole panel). */}
          <div key={displayedParentMessageWithThreadId ? "under-parent" : "alone"} className="relative flex-1">
            <ThreadRepliesLoading key={repliesLoadingSince} since={repliesLoadingSince} />
          </div>
        </ScrollArea>
      ) : messages.length === 0 ? (
        // No replies (or none in the plan's window): the parent and what stands in for
        // them scroll in a raft-ui ScrollArea, as while loading.
        <ScrollArea className="flex h-full flex-col" data-testid="thread-replies-placeholder-scroll">
          {parentSlot ? <ParentSlotMount host={parentSlotHost} /> : null}
          {displayedParentMessageWithThreadId && (
            <div data-testid="thread-panel-parent" className={THREAD_PANEL_PARENT_CLASS_NAME}>
              <MessageItem
                message={displayedParentMessageWithThreadId}
                mentionMap={mentionMap}
                channels={channels}
                threadSummary={displayedParentThreadSummary}
                linkedTask={displayedParentTask ?? (parentSourceTasks.length === 1 ? parentSourceTasks[0] : undefined)}
          linkedTasks={parentSourceTasks}
                previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
                previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
                mentionComposerChannelId={threadMentionComposerChannelId}
                reactionParentScopeKey={parentReactionParentScopeKey}
                canReact={canReactToThread}
                hideThreadActions
                showThreadFollowAction
                senderAvatarTestId="thread-parent-avatar"
                onOpenProfile={onOpenProfile}
                threadSearchHighlightQuery={
                  displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
                }
              />
            </div>
          )}
          {repliesLoadFailed ? (
            <ThreadRepliesLoadFailed onRetry={handleRetryRepliesLoad} retryTestId="thread-replies-retry" />
          ) : historyLimited ? (
            // Every reply sits behind the plan history cutoff: the thread is
            // not empty, it is hidden. Say so instead of "No replies yet":
            // the reply that was opened is gone, or the history paywall.
            !threadChannelId ? (
              <div className="flex flex-1 flex-col items-center justify-center p-4">
                <HistoryLimitBanner target={focusTargetMissing} />
              </div>
            ) : showsHiddenTarget ? (
              <div className="flex flex-1 flex-col px-3 pt-3" data-testid="thread-history-limited-empty">
                <HistoryPaywall channelId={threadChannelId} scope={threadPaywallScope} mode="target" allHidden />
              </div>
            ) : (
              // Where the replies would start, the width of the timeline.
              <div className="flex flex-1 flex-col px-3 pt-3" data-testid="thread-history-limited-empty">
                <HistoryPaywall channelId={threadChannelId} scope={threadPaywallScope} allHidden />
              </div>
            )
          ) : emptyState ?? (
            <EmptyState
              className="flex flex-1 flex-col items-center justify-center"
              icon={<ThreadIcon width={36} height={36} />}
              title={formatMessage({ id: "message.threadPanel.noRepliesTitle" })}
            />
          )}
        </ScrollArea>
      ) : (
        <MessageTimeline
          key={threadChannelId}
          ref={timelineRef}
          source={threadSource}
          renderItem={renderThreadItem}
          foldedMessageIds={threadFoldedMessageIds}
          leadingRows={threadLeadingRows}
          renderLeadingRow={renderThreadLeadingRow}
          footer={threadFooter}
          onAtBottomChange={handleAtBottomStateChange}
          onVisibleMessageWindowChange={translationWindow.set}
          onViewportChange={selectToHere.onViewportChange}
          persistKey={`thread:${threadChannelId}`}
          className="h-full"
          testId="thread-message-scroller"
          // Narrowed or widened (a seam, the window, a fold, a restored row; #189), the replies rewrap: at their end
          // they stay at their end, else the message first in view keeps its place.
          keepTopOnWidthChange
        />
      )}
      {/* The list's bottom edge fades over the composer (raft-ui
          MessageListEndFade): a message scrolled under it softens instead of
          being cut. At the end of the list it lies over the list's empty end. */}
      {showComposer ? <AgentTypingLine channelId={typingChannelId} parentMessageId={parentMessageId ?? null} /> : null}
      {showComposer ? <MessageListEndFade className={`${END_FADE_ABOVE_COMPOSER} ${END_FADE_UNDER_AGENT_TYPING_LINE_CLASS}`} /> : null}
      {/* Always mounted, shown with `hidden`: WebKit restyles the whole
          timeline subtree when its parent's child list changes beside it,
          so leaving or reaching the live tail must not add or remove a
          sibling here. */}
      <BottomJumpControls
        data-testid="thread-bottom-controls"
        selectToHere={selectToHere}
        hidden={!showBottomButton}
      >
        {showBottomButton && (
          <MessageListJumpPill onClick={handleBottomButton}>
            <ArrowDown aria-hidden />
            {/* Stryker disable all: pre-existing scroll-status copy is outside the workspace mutation corpus. */}
            {newMessageCount > 0 ? formatMessage({ id: "message.threadPanel.newCount" }, { count: newMessageCount }) : formatMessage({ id: "message.chatPanel.backToBottom" })}
            {/* Stryker restore all */}
          </MessageListJumpPill>
        )}
      </BottomJumpControls>
      <ConversationOutline
        channelId={threadChannelId}
        messages={messages}
        visibleWindow={translationWindow}
        jumpTargetId={focusTargetId}
        onJump={outlineRail.onJump}
        leadingMessageId={outlineRail.leadingMessageId}
        hrefFor={outlineRail.hrefFor}
      />
      </OpenThreadContext.Provider>
      </MessageForwardContext.Provider>
    </ThreadPanelBody>
  );
}

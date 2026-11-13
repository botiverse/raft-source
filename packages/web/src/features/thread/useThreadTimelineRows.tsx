import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import type { SyncScopeKey } from "@botiverse/raft-shared";
import { TIMELINE_END_ABOVE_COMPOSER, TIMELINE_START_ABOVE_ROW, TIMELINE_ROW_INSET } from "../../components/message/composerHost";
import { AgentTypingListEnd } from "../../components/message/AgentTypingLine";
import type { Agent } from "../../store/agentStore";
import type { User } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import type { Server, ServerMember } from "../../store/serverStore";
import type { Task } from "../../store/taskStore";
import type { ThreadSummary } from "../../store/threadStore";
import type { ChannelExternalMember } from "../../hooks/useChannelMembers";
import HistoryTopState from "../../components/message/HistoryTopState";
import HistoryPaywall from "../../components/message/HistoryPaywall";
import MessageItem from "../../components/message/MessageItem";
import type { MentionEntry } from "../../components/message/MessageItem";
import { SelectModeListEnd } from "../../components/message/SelectModeToolbar";
import type { MessageTimelineLeadingRow } from "../../components/message/MessageTimeline";
import { getHistoryTopState, historyBoundaryVariant } from "../../utils/historyTopState";
import ThreadPanelSystemMessageGroupDisclosure from "../../components/message/ThreadPanelSystemMessageGroupDisclosure";
import { buildSystemMessageRenderStates, foldedSystemMessageIds } from "../../components/message/systemMessageGrouping";
import { taskHandoffReturns } from "../../components/task/taskHandoffNotice";
import { followedByFor, useStableMessageGrouping } from "../../components/message/messageGrouping";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAgentReadProgress } from "../../hooks/useAgentReadProgress";
import { AgentReadSystemRow } from "../../components/message/AgentReadFaces";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { ParentSlotMount } from "./ParentSlotMount";
import { THREAD_PANEL_PARENT_CLASS_NAME } from "./threadPanelChrome";

/** Discriminator for HistoryTopState catalog keys — keep out of JSX string attrs. */
const THREAD_HISTORY_NOUN = "replies" as const;

/**
 * What the replies' MessageTimeline renders: each reply (a system-message
 * group as one row), the rows above them (the parent and the history
 * boundary) and the list's end, plus the per-message lookups the panel's
 * parent preview shares with them.
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadTimelineRows({
  messages,
  formatMessage,
  agentById,
  memberById,
  currentUser,
  currentServer,
  threadChannelId,
  parentChannelId,
  parentMessageId,
  parentRouteKind,
  hasMore,
  hasNewer,
  historyLimited,
  loadingOlder,
  loadingNewer,
  showsHiddenTarget,
  activeThreadSearchMessageId,
  threadSearchQuery,
  canReactToThread,
  channels,
  externalById,
  mentionMap,
  locatedReplyId,
  onOpenProfile,
  parentSlot,
  parentSlotHost,
  displayedParentMessageWithThreadId,
  displayedParentTask,
  parentSourceTasks,
  displayedParentThreadSummary,
  showComposer,
  typingChannelId,
  threadSelectScopedHere,
}: {
  messages: Message[];
  formatMessage: IntlShape["formatMessage"];
  agentById: Map<string, Agent>;
  memberById: Map<string, ServerMember>;
  currentUser: User | null;
  currentServer: Server | null;
  threadChannelId: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  parentRouteKind: "dm" | "channel" | null;
  hasMore: boolean;
  hasNewer: boolean;
  historyLimited: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  showsHiddenTarget: boolean;
  activeThreadSearchMessageId: string | null;
  threadSearchQuery: string;
  canReactToThread: boolean;
  channels: Channel[];
  externalById: Map<string, ChannelExternalMember>;
  mentionMap: Map<string, MentionEntry>;
  locatedReplyId: string | null;
  onOpenProfile: ((kind: "agent" | "human", id: string) => void) | undefined;
  parentSlot: ReactNode;
  parentSlotHost: HTMLDivElement;
  displayedParentMessageWithThreadId: Message | null;
  displayedParentTask: Task | null;
  parentSourceTasks: Task[];
  displayedParentThreadSummary: ThreadSummary | undefined;
  showComposer: boolean;
  typingChannelId: string | null;
  threadSelectScopedHere: boolean;
}) {
  const [expandedSystemMessageGroups, setExpandedSystemMessageGroups] = useState<Set<string>>(() => new Set());
  // A task's own conversation has no first message to name; a thread does.
  const threadPaywallScope: "thread" | "task" = parentMessageId ? "thread" : "task";

  // Stryker disable next-line all: this unchanged memo falls into the diff gate's shifted range; system grouping has its own focused behavior suite.
  const systemMessageRenderStates = useMemo(
    () => buildSystemMessageRenderStates(messages, formatMessage),
    [messages, formatMessage],
  );
  // Task hand-off cards: when each came back to whoever handed it off.
  const handoffReturns = useMemo(() => taskHandoffReturns(messages), [messages]);
  // A system-message group is one row of the timeline (its summary renders
  // the whole group): its hidden messages are not rows.
  const threadFoldedMessageIds = useMemo(
    () => foldedSystemMessageIds(messages, systemMessageRenderStates),
    [messages, systemMessageRenderStates],
  );

  const toggleSystemMessageGroup = useCallback((groupId: string) => {
    setExpandedSystemMessageGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const getPreviewSenderAgent = useCallback((message: Message) => (
      message.senderType === "agent" ? agentById.get(message.senderId) : undefined
  ), [agentById]);
  const getPreviewSenderMember = useCallback((message: Message) => (
      message.senderType === "user"
        ? resolveMessageSenderMember(message, memberById, currentUser) ?? undefined
        : undefined
  ), [currentUser, memberById]);

  // task #44 (stdrc): merge consecutive same-sender replies inside a thread too.
  // Threads still break the run on a day boundary ("按天合并") but DON'T render a
  // date divider — so we compute the same grouping and just never emit a
  // DateDivider here. Reply messages never carry their own reply/task chrome, so
  // there are no standalone ids to exclude.
  const { options: threadTimeFormatOptions } = useTimeFormatter();
  const messageGrouping = useStableMessageGrouping(
    messages,
    threadTimeFormatOptions.timeZone ?? undefined,
  );
  // Stryker disable next-line ConditionalExpression,LogicalOperator: thread composer routing is covered through MessageItem behavior; this normalizes the mounted thread id for duplicated render branches.
  const threadMentionComposerChannelId = threadChannelId || undefined;
  const threadReactionParentScopeKey = useMemo<SyncScopeKey | undefined>(() => (
    currentServer?.id && threadChannelId
      ? { serverId: currentServer.id, scopeKind: "thread", scopeId: threadChannelId }
      : undefined
  ), [currentServer?.id, threadChannelId]);
  const parentReactionParentScopeKey = useMemo<SyncScopeKey | undefined>(() => (
    currentServer?.id && parentChannelId
      ? { serverId: currentServer.id, scopeKind: "channel", scopeId: parentChannelId }
      : undefined
  ), [currentServer?.id, parentChannelId]);

  // Same rule as ChatPanel: in a DM thread, one read status line under the
  // last reply, and only at the live edge.
  const dmThreadReadStatusMessageId = parentRouteKind === "dm" && !hasNewer
    ? messages[messages.length - 1]?.id ?? null
    : null;

  // Agent read progress (agent_read_progress_v0), as in a channel: a thread is
  // its own read scope, so the faces are the agents' positions among the
  // replies (the parent row belongs to the channel and carries none, but
  // keeps the column so its right edge lines up with the replies). A thread
  // under a DM keeps its "Read" line instead; until the parent is known
  // (`parentRouteKind` null) it could be one, so nothing yet.
  const agentReadScope = useMemo(() => (
    threadChannelId && parentRouteKind === "channel"
      ? { id: threadChannelId, name: "", type: "thread" as const }
      : null
  ), [parentRouteKind, threadChannelId]);
  const { model: agentReadProgress, statusMessageId: agentReadStatusMessageId } = useAgentReadProgress({
    scope: agentReadScope,
    parentChannelId,
    messages,
    hasNewer,
    foldedMessageIds: threadFoldedMessageIds,
    typingChannelId,
    typingParentMessageId: parentMessageId,
    agentById,
  });
  const agentReadActive = agentReadProgress !== null;

  // Stryker disable all: focused sender-name mention behavior is covered through MessageItem/MessageInput; this memo only duplicates thread render pass-through and dependency invalidation.
  const renderThreadItem = useCallback((msg: Message, index: number) => {
    const systemMessageState = systemMessageRenderStates[index];
    if (systemMessageState?.kind === "hide") return null;
    const getThreadSearchHighlightQuery = (messageId: string) => (
      messageId === activeThreadSearchMessageId ? threadSearchQuery : undefined
    );

    if (systemMessageState?.kind === "summary") {
      const expanded = expandedSystemMessageGroups.has(systemMessageState.groupId);
      return (
        <div className={TIMELINE_ROW_INSET} style={{ overflow: "clip visible" }}>
          <AgentReadSystemRow messageId={msg.id}>
            <ThreadPanelSystemMessageGroupDisclosure
              groupId={systemMessageState.groupId}
              summary={systemMessageState.content}
              expanded={expanded}
              onToggleGroup={toggleSystemMessageGroup}
            >
              {systemMessageState.messageIndexes.map((messageIndex) => {
                const originalMessage = messages[messageIndex];
                if (!originalMessage) return null;
                return (
                  <MessageItem
                    key={originalMessage.id}
                    message={originalMessage}
                    mentionMap={mentionMap}
                    channels={channels}
                    parentChannelId={parentChannelId || undefined}
                    parentMessageId={parentMessageId || undefined}
                    previewSenderAgent={getPreviewSenderAgent(originalMessage)}
                    previewSenderMember={getPreviewSenderMember(originalMessage)}
                    channelParticipantExternalsById={externalById}
                    mentionComposerChannelId={threadMentionComposerChannelId}
                    reactionParentScopeKey={threadReactionParentScopeKey}
                    canReact={canReactToThread}
                    hideThreadActions
                    onOpenProfile={onOpenProfile}
                    threadSearchHighlightQuery={getThreadSearchHighlightQuery(originalMessage.id)}
                    threadSearchActive={originalMessage.id === activeThreadSearchMessageId}
                    located={originalMessage.id === locatedReplyId}
                  />
                );
              })}
            </ThreadPanelSystemMessageGroupDisclosure>
          </AgentReadSystemRow>
        </div>
      );
    }

    return (
      // `overflow: clip visible` (not `overflow-hidden`) so the hover toolbar can
      // ride on top of the message border without being clipped — matches
      // ChatPanel. Horizontal clipping is preserved.
      <div className={TIMELINE_ROW_INSET} style={{ overflow: "clip visible" }}>
        <MessageItem
          key={msg.id}
          message={msg}
          mentionMap={mentionMap}
          channels={channels}
          parentChannelId={parentChannelId || undefined}
          parentMessageId={parentMessageId || undefined}
          previewSenderAgent={getPreviewSenderAgent(msg)}
          previewSenderMember={getPreviewSenderMember(msg)}
          channelParticipantExternalsById={externalById}
          mentionComposerChannelId={threadMentionComposerChannelId}
          reactionParentScopeKey={threadReactionParentScopeKey}
          canReact={canReactToThread}
          hideThreadActions
          onOpenProfile={onOpenProfile}
          groupState={messageGrouping.get(msg.id)}
          followedBy={followedByFor(messages, index, messageGrouping)}
          threadSearchHighlightQuery={getThreadSearchHighlightQuery(msg.id)}
          threadSearchActive={msg.id === activeThreadSearchMessageId}
          located={msg.id === locatedReplyId}
          showDmReadStatus={msg.id === dmThreadReadStatusMessageId}
          showAgentReadStatus={msg.id === agentReadStatusMessageId}
          agentReadFaces={agentReadActive}
          taskHandoffReturn={handoffReturns.get(msg.id) ?? null}
        />
      </div>
    );
  }, [activeThreadSearchMessageId, agentReadActive, agentReadStatusMessageId, canReactToThread, channels, dmThreadReadStatusMessageId, expandedSystemMessageGroups, externalById, getPreviewSenderAgent, getPreviewSenderMember, handoffReturns, locatedReplyId, mentionMap, messageGrouping, messages, onOpenProfile, parentChannelId, parentMessageId, systemMessageRenderStates, threadMentionComposerChannelId, threadReactionParentScopeKey, threadSearchQuery, toggleSystemMessageGroup]);
  // Stryker restore all

  // Stryker disable all: focused sender-name mention behavior is covered through MessageItem/MessageInput; this memo only duplicates thread parent pass-through and dependency invalidation.
  // The rows above the replies: the parent (with the task head's parent slot)
  // and the history boundary. Rows of the timeline like the replies, so a tall
  // parent is measured and virtualized like any row.
  const threadLeadingRows = useMemo<MessageTimelineLeadingRow[]>(() => {
    const rows: MessageTimelineLeadingRow[] = [];
    if (parentSlot || displayedParentMessageWithThreadId) {
      rows.push({ kind: "parent", message: displayedParentMessageWithThreadId });
    }
    rows.push({ kind: "boundary", variant: historyBoundaryVariant(getHistoryTopState({ hasMore, historyLimited }), "replies-start") });
    return rows;
  }, [displayedParentMessageWithThreadId, hasMore, historyLimited, parentSlot]);
  const renderThreadLeadingRow = useCallback((row: MessageTimelineLeadingRow) => row.kind === "boundary" ? (
    // The rule under the root is a boundary: the replies start a section
    // step below it, as the root ends a section step above it. The history
    // notice brings a row's lead, so the step holds when it renders nothing.
    // At the start of what the plan shows: the history paywall, not a line.
    <div className={`${TIMELINE_ROW_INSET} ${TIMELINE_START_ABOVE_ROW}`}>
      {threadChannelId && showsHiddenTarget ? (
        // A jump to a reply behind the window: the paywall centers on it.
        <HistoryPaywall channelId={threadChannelId} scope={threadPaywallScope} mode="target" recentDivider={messages.length > 0} />
      ) : threadChannelId && getHistoryTopState({ hasMore, historyLimited }) === "history_limited" ? (
        // Threads draw no date dividers, so "last 30 days" is a line of its own.
        <HistoryPaywall channelId={threadChannelId} scope={threadPaywallScope} recentDivider={messages.length > 0} />
      ) : (
        <HistoryTopState
          hasMore={hasMore}
          historyLimited={historyLimited}
          loadingOlder={loadingOlder}
          noun={THREAD_HISTORY_NOUN}
        />
      )}
    </div>
  ) : (
    <>
      {parentSlot ? <ParentSlotMount host={parentSlotHost} /> : null}
      {displayedParentMessageWithThreadId && (
        // The root is a leading row of MessageTimeline: same anchor/reveal
        // item contract as the replies.
        <div
          data-testid="thread-panel-parent"
          data-message-id={displayedParentMessageWithThreadId.id}
          data-timeline-message-id={displayedParentMessageWithThreadId.id}
          className={THREAD_PANEL_PARENT_CLASS_NAME}
        >
          <MessageItem
            message={displayedParentMessageWithThreadId}
            mentionMap={mentionMap}
            channels={channels}
            threadSummary={displayedParentThreadSummary}
            linkedTask={displayedParentTask ?? (parentSourceTasks.length === 1 ? parentSourceTasks[0] : undefined)}
            linkedTasks={parentSourceTasks}
            previewSenderAgent={getPreviewSenderAgent(displayedParentMessageWithThreadId)}
            previewSenderMember={getPreviewSenderMember(displayedParentMessageWithThreadId)}
            channelParticipantExternalsById={externalById}
            mentionComposerChannelId={threadMentionComposerChannelId}
            reactionParentScopeKey={parentReactionParentScopeKey}
            canReact={canReactToThread}
            hideThreadActions
            showThreadFollowAction
            located={displayedParentMessageWithThreadId.id === locatedReplyId}
            senderAvatarTestId="thread-parent-avatar"
            onOpenProfile={onOpenProfile}
            threadSearchHighlightQuery={
              displayedParentMessageWithThreadId.id === activeThreadSearchMessageId ? threadSearchQuery : undefined
            }
            threadSearchActive={displayedParentMessageWithThreadId.id === activeThreadSearchMessageId}
            agentReadFaces={agentReadActive}
          />
        </div>
      )}
    </>
  ), [activeThreadSearchMessageId, agentReadActive, canReactToThread, channels, displayedParentMessageWithThreadId, locatedReplyId, displayedParentTask, parentSourceTasks, externalById, getPreviewSenderAgent, getPreviewSenderMember, hasMore, historyLimited, loadingOlder, mentionMap, onOpenProfile, displayedParentThreadSummary, parentReactionParentScopeKey, parentSlot, parentSlotHost, threadChannelId, threadPaywallScope, showsHiddenTarget, messages.length, threadMentionComposerChannelId, threadSearchQuery]);
  // Stryker restore all

  // With a composer, the list ends right on it (only the composer's own 8px
  // above its card). While an agent is replying here, the typing line floats
  // over the list's bottom and AgentTypingListEnd adds its height, so the
  // last reply stays whole above it (task #120). In select mode the toolbar
  // floats over the list's bottom where the composer was, so the list ends a
  // section step above the toolbar instead (SelectModeListEnd).
  const selectModeListEnd = showComposer && threadSelectScopedHere;
  const threadFooter = useMemo(() => (
    <div className={showComposer && !selectModeListEnd ? `${TIMELINE_ROW_INSET} ${TIMELINE_END_ABOVE_COMPOSER}` : `${TIMELINE_ROW_INSET} pb-timeline-end`}>
      {loadingNewer && (
        <div
          data-testid="thread-loading-newer"
          className="py-2 text-center font-mono text-mono-meta text-foreground-hint"
        >
          {formatMessage({ id: "message.threadPanel.loadingNewerReplies" })}
        </div>
      )}
      {showComposer ? <AgentTypingListEnd channelId={typingChannelId} parentMessageId={parentMessageId ?? null} /> : null}
      {selectModeListEnd ? <SelectModeListEnd /> : null}
    </div>
  ), [formatMessage, loadingNewer, showComposer, typingChannelId, parentMessageId, selectModeListEnd]);

  return {
    agentReadProgress,
    threadPaywallScope,
    threadFoldedMessageIds,
    getPreviewSenderAgent,
    getPreviewSenderMember,
    threadMentionComposerChannelId,
    parentReactionParentScopeKey,
    renderThreadItem,
    threadLeadingRows,
    renderThreadLeadingRow,
    selectModeListEnd,
    threadFooter,
  };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler

import { TIMELINE_START_ABOVE_ROW } from "../../components/message/composerHost";
import Tooltip from "../../components/ui/Tooltip";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { PanelAction, PanelMeta, PanelTitle, ScrollArea, ThreadPanelBody, ThreadPanelContent, ThreadPanelRoot } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import type { Message } from "../../store/messageStore";
import MessageItem from "../../components/message/MessageItem";
import { taskHandoffReturns } from "../../components/task/taskHandoffNotice";
import type { MentionEntry } from "../../components/message/MessageItem";
import PanelHeader from "../../components/ui/PanelHeader";
import EmptyState from "../../components/ui/EmptyState";
import Banner from "../../components/ui/Banner";
import MessageTimeline from "../../components/message/MessageTimeline";
import type { MessageTimelineLeadingRow, MessageTimelineSource } from "../../components/message/MessageTimeline";
import type { ReadOnlyThreadData, ThreadPanelProps } from "./threadPanelTypes";
import { THREAD_HEADER_CONTAINER_CLASS_NAME, THREAD_HEADER_SUBTITLE_CLASS_NAME, THREAD_MOBILE_BACK_PROPS, THREAD_PANEL_PARENT_CLASS_NAME } from "./threadPanelChrome";

// The read-only panel is framed with the same rui parts and the same surface,
// chrome-layer and content-layer classes as AuthenticatedThreadPanel below
// (panelClassName, threadChromeLayerClassName, threadContentLayerClassName).
const READ_ONLY_THREAD_PANEL_CLASS_NAME = "isolate flex h-full min-h-0 w-full flex-col bg-layer-canvas";
const READ_ONLY_THREAD_BODY_CLASS_NAME = "relative z-base min-h-0 flex-1 overflow-hidden";
const READ_ONLY_TIMELINE_END = <div aria-hidden className="pb-timeline-end" />;
const READ_ONLY_THREAD_HEADER_CONTAINER_PROPS = { className: THREAD_HEADER_CONTAINER_CLASS_NAME };

export function ReadOnlyThreadPanel({
  presentation = "side",
  onClose,
  hideHeader = false,
  readOnlyData,
}: ThreadPanelProps & { readOnlyData: ReadOnlyThreadData }) {
  const { formatMessage } = useIntl();
  const source = useMemo<MessageTimelineSource>(() => ({
    messages: readOnlyData.replies,
    hasOlder: readOnlyData.hasOlder,
    hasNewer: false,
    loading: readOnlyData.loading,
    loadOlder: readOnlyData.loadOlder,
    loadNewer: () => undefined,
  }), [readOnlyData.hasOlder, readOnlyData.loadOlder, readOnlyData.loading, readOnlyData.replies]);
  const closeButtonClassName = presentation === "modal"
    ? "flex"
    : "hidden lg:flex";
  const readOnlyParentChannelName = readOnlyData.channels.find((channel) => channel.id === readOnlyData.parentChannelId)?.name;
  // Task hand-off cards: when each came back to whoever handed it off.
  const handoffReturns = useMemo(() => taskHandoffReturns(readOnlyData.replies), [readOnlyData.replies]);
  const renderMessage = useCallback((message: Message) => (
    <div className="px-3" style={{ overflow: "clip visible" }}>
      <MessageItem
        message={message}
        taskHandoffReturn={handoffReturns.get(message.id) ?? null}
        mentionMap={EMPTY_PUBLIC_MENTION_MAP}
        channels={readOnlyData.channels}
        parentChannelId={readOnlyData.parentChannelId}
        parentMessageId={readOnlyData.parentMessage.id}
        readOnlyProjection
        readOnlySender={readOnlyData.senderByMessageId.get(message.id)}
        canReact={false}
        hideThreadActions
      />
    </div>
  ), [handoffReturns, readOnlyData.channels, readOnlyData.parentChannelId, readOnlyData.parentMessage.id, readOnlyData.senderByMessageId]);
  const parent = useMemo(() => (
    <div data-testid="thread-panel-parent" className={THREAD_PANEL_PARENT_CLASS_NAME}>
      <MessageItem
        message={readOnlyData.parentMessage}
        mentionMap={EMPTY_PUBLIC_MENTION_MAP}
        channels={readOnlyData.channels}
        parentChannelId={readOnlyData.parentChannelId}
        readOnlyProjection
        readOnlySender={readOnlyData.senderByMessageId.get(readOnlyData.parentMessage.id)}
        canReact={false}
        hideThreadActions
        senderAvatarTestId="thread-parent-avatar"
      />
    </div>
  ), [readOnlyData.channels, readOnlyData.parentChannelId, readOnlyData.parentMessage, readOnlyData.senderByMessageId]);

  const readOnlyLeadingRows = useMemo<MessageTimelineLeadingRow[]>(
    () => [{ kind: "parent", message: readOnlyData.parentMessage }],
    [readOnlyData.parentMessage],
  );
  // The replies start a section step under the root's rule (their first row
  // brings its own lead), and end a section step above the panel's edge.
  const renderReadOnlyLeadingRow = useCallback(() => (
    <>
      {parent}
      <div aria-hidden className={TIMELINE_START_ABOVE_ROW} />
    </>
  ), [parent]);

  return (
    <ThreadPanelRoot className={READ_ONLY_THREAD_PANEL_CLASS_NAME} data-testid="read-only-thread-panel">
      {!hideHeader && (
        <PanelHeader
          containerProps={READ_ONLY_THREAD_HEADER_CONTAINER_PROPS}
          titleSlot={(
            <div className="flex min-w-0 flex-col">
              <PanelTitle className="min-w-0 truncate text-left">
                {formatMessage({ id: "message.threadPanel.thread" })}
              </PanelTitle>
              {readOnlyParentChannelName ? (
                <PanelMeta render={<p />} className={THREAD_HEADER_SUBTITLE_CLASS_NAME}>
                  {formatMessage({ id: "message.threadPanel.channelContext" }, { name: readOnlyParentChannelName })}
                  {" · "}
                  {formatMessage({ id: "message.inlineThreadReplies.replyCount" }, { count: readOnlyData.replies.length })}
                </PanelMeta>
              ) : null}
            </div>
          )}
          mobileBreakpoint={presentation === "side" ? "lg" : "md"}
          onMobileBack={onClose}
          mobileBackProps={THREAD_MOBILE_BACK_PROPS}
          actions={presentation !== "mobile-modal" ? (
            <Tooltip content={formatMessage({ id: "message.threadPanel.closeThread" })}>
              <PanelAction
                onClick={onClose}
                className={closeButtonClassName}
                aria-label={formatMessage({ id: "message.threadPanel.closeThread" })}
                data-testid="thread-close"
              >
                <X />
              </PanelAction>
            </Tooltip>
          ) : undefined}
        />
      )}
      <ThreadPanelContent>
      <ThreadPanelBody className={READ_ONLY_THREAD_BODY_CLASS_NAME}>
        {readOnlyData.error ? (
          // Without a timeline (an error, or no replies) the parent and what stands in
          // for the replies scroll in a raft-ui ScrollArea, vertical as the timeline.
          <ScrollArea className="flex h-full flex-col" data-testid="read-only-thread-placeholder-scroll">
            {parent}
            <div className="p-3">
              <Banner intent="warning">{readOnlyData.error}</Banner>
            </div>
          </ScrollArea>
        ) : readOnlyData.replies.length === 0 && !readOnlyData.loading ? (
          <ScrollArea className="flex h-full flex-col" data-testid="read-only-thread-placeholder-scroll">
            {parent}
            <EmptyState
              className="flex flex-1 flex-col items-center justify-center"
              icon={<ThreadIcon width={36} height={36} />}
              title={formatMessage({ id: "message.threadPanel.noRepliesTitle" })}
            />
          </ScrollArea>
        ) : (
          <MessageTimeline
            key={readOnlyData.threadChannelId}
            source={source}
            renderItem={renderMessage}
            leadingRows={readOnlyLeadingRows}
            renderLeadingRow={renderReadOnlyLeadingRow}
            footer={READ_ONLY_TIMELINE_END}
            className="h-full"
            testId="thread-message-scroller"
            persistKey={`public-thread:${readOnlyData.threadChannelId}`}
          />
        )}
      </ThreadPanelBody>
      </ThreadPanelContent>
    </ThreadPanelRoot>
  );
}

const EMPTY_PUBLIC_MENTION_MAP = new Map<string, MentionEntry>();

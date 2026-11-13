import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useInRouterContext } from "react-router-dom";
import { toast } from "@botiverse/raft-ui";
import { useRefNavigation } from "../../hooks/useRefNavigation";
import type { MessageId } from "../../i18n/messages";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { navigateThread, taskRefKey } from "../../utils/refTarget";
import type { ThreadRefIntent } from "../../utils/threadRefNavigation";
import { MessageMarkdownBody } from "./MessageMarkdownBody";
import type { MentionEntry } from "./messageMarkdownRefs";
import { messageMarkdownSlot, withoutMessageMarkdownSlotMarks } from "./messageMarkdownSlots";
import type { MessageMarkdownSlots } from "./messageMarkdownSlots";
import { useOpenRaftPermalink } from "./useOpenRaftPermalink";

/**
 * One run of a text: words, or a structured part the caller draws itself (an
 * Artifact comment's mention) with `text`, its words where Markdown shows
 * text as written (in code, a link's label).
 */
export type MessageMarkdownTextPart =
  | { type: "text"; text: string }
  | { type: "inline"; text: string; node: ReactNode };

/** No name in the text is a mention: only the caller's own parts are. */
const NO_MENTIONS = new Map<string, MentionEntry>();
const ignore = () => undefined;

/** What the renderer reads from the stores, for either host. */
function useMessageMarkdownInputs() {
  const { options: timeFormatOptions } = useTimeFormatter();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  // Every conversation a ref can reach, as a message's (MessageItem's navigableChannels).
  const navigableChannels = useMemo(() => {
    const listed = new Set(channels.map((channel) => channel.id));
    return [...channels, ...[...dmChannels, ...loungeChannels].filter((row) => !listed.has(row.id))];
  }, [channels, dmChannels, loungeChannels]);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const serverTasks = useTaskStore((s) => s.serverTasks);
  const taskByChannelNumber = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of serverTasks) map.set(taskRefKey(task.channelId, task.taskNumber), task);
    return map;
  }, [serverTasks]);
  return { timeFormatOptions, navigableChannels, serverSlug, taskByChannelNumber };
}

interface DrawnText {
  content: string;
  slots: MessageMarkdownSlots;
}

/** In the app (under its router): a ref opens where it opens from a message. */
function RoutedMessageMarkdownText({ content, slots }: DrawnText) {
  const { formatMessage } = useIntl();
  const { timeFormatOptions, navigableChannels, serverSlug, taskByChannelNumber } = useMessageMarkdownInputs();
  const onThreadUnavailable = useCallback((id: MessageId) => {
    toast.error(formatMessage({ id }));
  }, [formatMessage]);
  const nav = useRefNavigation(onThreadUnavailable);
  const navigateChannel = useCallback((channel: Channel) => nav.toChannel(channel.id), [nav]);
  const navigateDm = useCallback((channel: Channel) => nav.toDm(channel.id), [nav]);
  const openThread = useCallback(async (intent: ThreadRefIntent) => {
    if (intent.parentChannelId) await navigateThread(nav, intent.parentChannelId, intent.shortId, intent.parentChannelType === "dm");
  }, [nav]);
  const openTask = useCallback((taskNumber: number, channelId?: string) => {
    if (channelId) void nav.openTask?.(channelId, taskNumber);
  }, [nav]);
  const openMessage = useCallback(async (channel: Channel, messageId: string, threadParentShortId: string | null) => {
    if (threadParentShortId) await navigateThread(nav, channel.id, threadParentShortId, channel.type === "dm");
    else if (channel.type === "dm") nav.toDmMessage(channel.id, messageId);
    else nav.toMessage(channel.id, messageId);
  }, [nav]);
  const openPermalink = useOpenRaftPermalink();
  return (
    <MessageMarkdownBody
      content={content}
      slots={slots}
      channels={navigableChannels}
      mentionMap={NO_MENTIONS}
      structuredMentionMap={NO_MENTIONS}
      onNavigateChannel={navigateChannel}
      onNavigateDm={navigateDm}
      onNavigateAgent={ignore}
      onNavigateHuman={ignore}
      onNavigateExternal={ignore}
      onOpenThread={openThread}
      onOpenTask={openTask}
      onOpenMessage={openMessage}
      onOpenPermalink={openPermalink}
      serverSlug={serverSlug}
      refAuthorityServerSlug={serverSlug}
      taskByChannelNumber={taskByChannelNumber}
      timeFormatOptions={timeFormatOptions}
      readReceiptChannelId=""
      readReceiptMessageSeq={undefined}
      readReceiptEnabled={false}
    />
  );
}

/** Outside a router (a test, the visual harness): the same text, its refs drawn but going nowhere. */
function StillMessageMarkdownText({ content, slots }: DrawnText) {
  const { timeFormatOptions, navigableChannels, serverSlug, taskByChannelNumber } = useMessageMarkdownInputs();
  return (
    <MessageMarkdownBody
      content={content}
      slots={slots}
      channels={navigableChannels}
      mentionMap={NO_MENTIONS}
      structuredMentionMap={NO_MENTIONS}
      onNavigateChannel={ignore}
      onNavigateDm={ignore}
      onNavigateAgent={ignore}
      onNavigateHuman={ignore}
      onNavigateExternal={ignore}
      serverSlug={serverSlug}
      refAuthorityServerSlug={serverSlug}
      taskByChannelNumber={taskByChannelNumber}
      timeFormatOptions={timeFormatOptions}
      readReceiptChannelId=""
      readReceiptMessageSeq={undefined}
      readReceiptEnabled={false}
    />
  );
}

/**
 * A text that isn't a message drawn as a message body is (the message
 * renderer, MessageMarkdownBody): the same Markdown, the same security rules
 * (messageMarkdownSecurity: sanitized, raw HTML as typed text, safe links),
 * Raft references (#channel, #channel:thread, #channel:#7, permalinks) that
 * open where they open from a message, and links. Its structured parts are
 * drawn by the caller in place (messageMarkdownSlots), never found again in
 * the words: `@name` typed in a text run stays text. `parts` must be
 * referentially stable (memoized), as the renderer re-parses on a new one.
 */
export function MessageMarkdownText({ parts }: { parts: readonly MessageMarkdownTextPart[] }) {
  const { content, slots } = useMemo(() => {
    const inline: Array<Extract<MessageMarkdownTextPart, { type: "inline" }>> = [];
    const source = parts.map((part) => {
      if (part.type === "text") return withoutMessageMarkdownSlotMarks(part.text);
      inline.push(part);
      return messageMarkdownSlot(inline.length - 1);
    }).join("");
    const drawn: MessageMarkdownSlots = {
      render: (index) => inline[index]?.node ?? null,
      text: (index) => inline[index]?.text ?? "",
    };
    return { content: source, slots: drawn };
  }, [parts]);
  const routed = useInRouterContext();
  return routed
    ? <RoutedMessageMarkdownText content={content} slots={slots} />
    : <StillMessageMarkdownText content={content} slots={slots} />;
}

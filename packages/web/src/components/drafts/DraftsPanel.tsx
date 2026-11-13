import { memo, useCallback, useEffect, useId, useRef } from "react";
import { useIntl } from "react-intl";
import { Pencil } from "lucide-react";
import {
  InboxItem as RaftInboxItem,
  InboxItemBody,
  InboxItemContent,
  InboxItemHeading,
  InboxItemTimestamp,
  InboxItemTitle,
  InboxItemTrailing,
  InboxItemTrigger,
  ScrollArea,
} from "@botiverse/raft-ui";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useLoungeAgentId } from "../../store/useStoredChannel";
import { useLoungeTitle } from "../agent/agentLounge";
import { useServerStore } from "../../store/serverStore";
import { useTaskStore } from "../../store/taskStore";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useDraftEntriesState } from "../../hooks/useDrafts";
import type { DraftEntry } from "../../hooks/useDrafts";
import { formatRelativeTime } from "../../utils/relativeTime";
import { currentRouteKind } from "../../utils/draftPlaces";
import type { DraftPlace } from "../../utils/draftPlaces";
import { ConversationAvatar } from "../thread/ConversationAvatar";
import PanelHeader from "../ui/PanelHeader";
import EmptyState from "../ui/EmptyState";
import { trackDraftsItemOpened, trackDraftsPageViewed } from "../../analytics/gatedFeatures";

// Drafts (#triage:#127, artin): every message started and not sent, from any
// conversation, in one list beside Saved. The texts are this device's
// (messageStore.drafts, kept per person in localStorage), so the page reads
// them as they are: no loading, no pull to refresh, and a row goes away the
// moment its draft is sent or emptied. Each row opens its conversation, whose
// composer already holds the text.
//
// Rows drawn as Activity's (artin): the same InboxItem and conversation tile.

function placeConversationId(place: DraftPlace): string {
  return place.kind === "channel" ? place.channelId : place.parentChannelId;
}

type TaskStoreState = ReturnType<typeof useTaskStore.getState>;

function findTaskIn(s: TaskStoreState, taskId: string, place: DraftPlace) {
  const parentChannelId = place.kind === "channel" ? place.channelId : place.parentChannelId;
  return s.tasks.find((candidate) => candidate.id === taskId)
    ?? s.tasksByChannelId[parentChannelId]?.find((candidate) => candidate.id === taskId);
}

/**
 * A draft as an Activity row (artin, #triage:#127): raft-ui's InboxItem in
 * Activity's list layout and density, led by the same conversation tile
 * (ConversationAvatar: the channel's kind icon, the DM peer's face, a thread
 * or task mark in the corner), the conversation as the title, the draft as
 * the line under it and the time it was last edited at the end. A draft has
 * nothing to mark done, read or unfollow, so the row has no actions.
 *
 * Titles follow Activity's: a channel's name, a DM's person, a task's own
 * title with its `#channel:#7` before the text, and a thread "Thread in
 * #channel", Activity's title for a thread whose parent it doesn't have.
 */
const DraftItem = memo(function DraftItem({ entry, onOpen }: {
  entry: DraftEntry;
  onOpen: (entry: DraftEntry) => void;
}) {
  const { formatMessage, locale } = useIntl();
  const { place } = entry;
  const conversationId = placeConversationId(place);
  // Store rows, not objects built here: a selector that returns a new object
  // on every call loops under React 19 (MentionLink keeps the same rule).
  const dmChannel = useChannelStore((s) => s.dmChannels.find((channel) => channel.id === conversationId) ?? null);
  // A channel or an agent's Lounge (the Lounge is not in `channels`).
  const storedChannel = useChannelStore((s) => findStoredChannel(s, conversationId) ?? null);
  const channel = storedChannel?.type === "dm" ? null : storedChannel;
  const loungeAgentId = useLoungeAgentId(dmChannel ? null : conversationId);
  const loungeTitle = useLoungeTitle(loungeAgentId, channel?.name);
  const serverPublicPageLive = useServerStore((s) => s.current?.publicPageLive === true);
  const taskId = place.kind === "task" ? place.taskId : null;
  const taskNumber = useTaskStore((s) => (taskId ? findTaskIn(s, taskId, place)?.taskNumber ?? null : null));
  const taskName = useTaskStore((s) => (taskId ? findTaskIn(s, taskId, place)?.title ?? null : null));
  const titleId = useId();
  const bodyId = useId();
  const handleOpen = useCallback(() => onOpen(entry), [entry, onOpen]);
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleOpen();
  }, [handleOpen]);

  const conversationName = dmChannel
    ? dmChannel.peerDisplayName || dmChannel.peerName || dmChannel.name
    : loungeTitle
      ? loungeTitle
      : channel
      ? channel.name
      : formatMessage({ id: "drafts.row.unknownConversation" });
  const channelRef = dmChannel || loungeTitle ? conversationName : channel ? `#${channel.name}` : conversationName;
  const kind = place.kind === "task" ? "task" : place.kind === "thread" ? "thread" : dmChannel ? "dm" : "channel";
  const title = place.kind === "task"
    ? taskName ?? formatMessage({ id: "drafts.row.taskUntitled" })
    : place.kind === "thread"
      ? formatMessage({ id: "thread.row.savedThreadTitle" }, { conversation: channelRef })
      : conversationName;
  // Before the text, Activity's muted prefix: where a task is (`#channel:#7`).
  const prefix = place.kind === "task"
    ? formatMessage({ id: "activity.list.threadChannel" }, { channel: taskNumber !== null ? `${channelRef}:#${taskNumber}` : channelRef })
    : null;
  const time = entry.updatedAt === null ? null : formatRelativeTime(new Date(entry.updatedAt).toISOString(), locale);

  return (
    <RaftInboxItem
      density="compact"
      data-layout="list"
      data-draft-row=""
      data-testid={`draft-row-${entry.key}`}
    >
      <InboxItemTrigger
        data-testid={`draft-row-open-${entry.key}`}
        aria-labelledby={`${titleId} ${bodyId}`}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
      />
      <ConversationAvatar
        kind={kind}
        dmChannel={dmChannel}
        parentIsDm={kind !== "channel" && kind !== "dm" && dmChannel !== null}
        channelType={channel?.type ?? "channel"}
        channel={channel}
        serverPublicPageLive={serverPublicPageLive}
        loungeAgentId={loungeAgentId}
      />
      <InboxItemContent>
        <InboxItemHeading>
          <InboxItemTitle id={titleId} data-testid={`draft-row-title-${entry.key}`}>{title}</InboxItemTitle>
        </InboxItemHeading>
        <InboxItemBody id={bodyId} data-testid={`draft-row-body-${entry.key}`}>
          {/* The pencil the sidebar puts on a conversation with a draft (artin):
              it marks the line as unsent text, where Activity puts the sender.
              14px in the hint color, on the text's first line; screen readers
              announce it as "Draft:". */}
          <Pencil role="img" aria-label={formatMessage({ id: "drafts.row.draftLabel" })} data-testid="draft-row-mark" className="mr-1 inline size-3.5 shrink-0 align-[-2px] text-foreground-hint" />
          {prefix ? <span className="mr-1">{prefix}</span> : null}
          {entry.content}
        </InboxItemBody>
      </InboxItemContent>
      {time ? (
        <InboxItemTrailing>
          <InboxItemTimestamp data-testid={`draft-row-time-${entry.key}`}>{time}</InboxItemTimestamp>
        </InboxItemTrailing>
      ) : null}
    </RaftInboxItem>
  );
});

/** Opens a draft's conversation; its composer holds the draft already (messageStore.drafts, by the same key). */
export function openDraftPlace(place: DraftPlace, nav: Pick<ReturnType<typeof useAppNavigate>, "toChannel" | "toDm" | "toThreadMessage" | "toTaskConversation">): void {
  switch (place.kind) {
    case "channel":
      if (currentRouteKind(place.channelId, place.routeKind) === "dm") nav.toDm(place.channelId);
      else nav.toChannel(place.channelId);
      return;
    case "thread":
      // The parent channel at the thread's first message with the thread
      // open: its composer is the draft's.
      nav.toThreadMessage(place.parentChannelId, place.parentMessageId, place.parentMessageId, currentRouteKind(place.parentChannelId, place.parentRouteKind));
      return;
    case "task":
      // The task's own conversation over its channel (task v2).
      nav.toTaskConversation(place.parentChannelId, place.taskId, currentRouteKind(place.parentChannelId, place.parentRouteKind));
      return;
  }
}

export default function DraftsPanel() {
  const { formatMessage } = useIntl();
  const { entries, settled } = useDraftEntriesState();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const nav = useAppNavigate();
  const openEntry = useCallback((entry: DraftEntry) => {
    trackDraftsItemOpened(entry.place);
    openDraftPlace(entry.place, nav);
  }, [nav]);
  // Usage of the gated page (tygg, #proj-o11y:a5f3094f): once per opening,
  // with how many drafts it lists once every draft is placed (on a cold load
  // the sidebar's lists and lookups come after the page). The drafts are this
  // browser's, so the server never sees the page used.
  const viewRecorded = useRef(false);
  useEffect(() => {
    if (!settled || viewRecorded.current) return;
    viewRecorded.current = true;
    trackDraftsPageViewed(entries.length);
  }, [settled, entries.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas [--column-margin:20px]">
      <PanelHeader
        title={formatMessage({ id: "drafts.header.title" })}
        subtitle={formatMessage({ id: "drafts.header.subtitle" }, { count: entries.length })}
        onMobileBack={onMobileBack}
      />
      {/* raft-ui ScrollArea: its overlay scrollbar takes no width, so the
          rows' shapes sit 8px from both edges on every platform. The content
          fills the area, so the empty state stays centred in it. */}
      <ScrollArea
        data-testid="drafts-list-scroller"
        className="flex-1 bg-layer-canvas"
        contentClassName="flex min-h-full flex-col py-1 safe-bottom"
      >
        {entries.length === 0 ? (
          <EmptyState
            className="flex flex-1 flex-col items-center justify-center"
            icon={<Pencil size={36} />}
            title={formatMessage({ id: "drafts.empty.title" })}
            description={formatMessage({ id: "drafts.empty.description" })}
          />
        ) : (
          // A list of cells, as Activity's: 2px between rows (raft-design patterns/lists.md).
          <div className="flex flex-col gap-0.5 py-1" data-layout="list">
            {entries.map((entry) => (
              <DraftItem key={entry.key} entry={entry} onOpen={openEntry} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

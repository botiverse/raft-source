import { useCallback, useId, useMemo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import Tooltip from "../../components/ui/Tooltip";
import { AtSign, Check } from "lucide-react";
import type { InboxFilter, InboxItem, ObjectActivityItem } from "../../store/inboxStore";
import { artifactActivityExcerpt, artifactActivityImagesOnly, artifactActivityRowParts, artifactActivityTarget, useArtifactOpenIntent } from "../../apps/artifacts";
import type { ArtifactActivityRowParts } from "../../apps/artifacts";
import { IconTile, InboxItemBody, InboxItemContent, InboxItemHeading, InboxItemHoverTarget, InboxItemLeading, InboxItemMarks, InboxItemSender, InboxItemTitle, InboxItemTrigger, InboxItem as RaftInboxItem, SidebarItemCount, SidebarItemIndicator } from "@botiverse/raft-ui";
import { InboxItemLine } from "@botiverse/raft-ui/wip";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import InlineMarkdownPreview from "../../components/markdown/InlineMarkdownPreview";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { dismissLayerProps } from "../../components/ui/dismissLayer";
import { useLongPress } from "../../hooks/useLongPress";
import { useOverflowTitle } from "../../hooks/useOverflowTitle";
import { ROW_SWIPE_ACTION_ATTR, ROW_SWIPE_BUTTON_WIDTH, useRowSwipe } from "../../hooks/useRowSwipe";
import { ActivityRowTime } from "./ActivityRowTime";
import { InboxRowDone } from "./InboxRowDone";
import { SWIPE_DONE_BUTTON_CLASS, SWIPE_LAYER_CLASS, SWIPE_ROW_CLASS, UNREAD_BODY_CLASS, activityMentionsOnly, itemKey, useMergedRowRef } from "./inboxRowShared";
import type { RowSwipeProps } from "./inboxRowShared";

// An object row's line (ObjectInboxRow), one flex line whose pieces truncate
// each on their own, in this order as it narrows: where the object lives
// first (it shrinks a thousand times faster), then the text down to about a
// dozen characters, then the name and what else is new. The text's floor is
// its width (12ch) under a max-content basis: an auto minimum is the smaller
// of the two, so a short comment ("ok") takes no more than its own width.
// The ellipsis is drawn by a block inside it, which keeps that minimum.
const OBJECT_ROW_TEXT_CLASS = "w-[12ch] shrink-10 basis-[max-content]";
const OBJECT_ROW_TEXT_INNER_CLASS = "block truncate";
// What else is new ("· 2 new comments") has a floor of its own the same way,
// 9ch: at least "· 2 new…" (or "· 12 new…") stays, so the count can be read
// (InNOut QA r97: "· 2 n…"). Only the name gives way to nothing.
const OBJECT_ROW_NEWS_CLASS = "ml-1 w-[9ch] basis-[max-content]";
const OBJECT_ROW_PART = "[data-object-row-part]";

/**
 * An object row's parts, from the app whose kind it is (the kinds the
 * inbox store keeps, ACTIVITY_OBJECT_KINDS): Artifacts the only one so far.
 */
function objectRowParts(item: ObjectActivityItem, actorName: string | null, intl: Pick<IntlShape, "formatMessage">): ArtifactActivityRowParts {
  return artifactActivityRowParts(item, actorName, renderObjectRowActor, intl);
}

/** The actor in an object row's sentence: a conversation row's sender (strong); the rest reads as its message (muted once read). */
function renderObjectRowActor(name: string): ReactNode {
  return <InboxItemSender key="actor" data-testid="object-card-actor">{name}</InboxItemSender>;
}

/** Where an object lives, as its row's second line names it: `#channel`, `@peer`; nothing for the server, public or a deleted conversation. */
function objectRowHome(item: ObjectActivityItem): string | null {
  const { kind, label, peerDisplayName } = item.home;
  if (!label) return null;
  if (kind === "channel") return `#${label}`;
  // A DM by the other person as the sidebar names them: the display name, else the handle (no "@").
  if (kind === "dm") return peerDisplayName || label;
  return null;
}

/**
 * An object's Activity row (an Artifact's; shared activityObjectsContract),
 * in a conversation row's anatomy (raft-ui InboxItem, compact): the kind's
 * tile, the object's title, then who did what, or a comment's text as a
 * message row's excerpt (their face and name, as a conversation row's
 * sender), and where it lives; the time ends its first line and the unread
 * marks its second, as a conversation row's. Opening it goes to the object; Done takes it out (a phone: the left swipe, with Undo), and
 * the menu reads it while it is unread.
 */
export function ObjectInboxRow({ item, filter, onOpen, onDone, swipe: rowSwipe, onContextMenu, onLongPress, focused, active, located, focusRef }: {
  item: ObjectActivityItem;
  filter: InboxFilter;
  onOpen: (e: React.MouseEvent | ReactKeyboardEvent, item: InboxItem) => void;
  onDone: (item: InboxItem) => void;
  swipe?: RowSwipeProps;
  onContextMenu: (e: React.MouseEvent, item: InboxItem) => void;
  onLongPress: (coords: { x: number; y: number }, item: InboxItem) => void;
  focused?: boolean;
  /** Open in the main area: raft-ui's active look, for as long as it is open (a conversation row's). */
  active?: boolean;
  located?: boolean;
  focusRef?: React.Ref<HTMLDivElement>;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  // A comment's text is its author's, who may not be the newest event's actor.
  const excerpt = artifactActivityExcerpt(item);
  // A comment of images alone: "Image" / "3 images" where its text would be.
  const imagesOnly = excerpt ? artifactActivityImagesOnly(excerpt, intl) : null;
  const actor = excerpt?.author ?? item.latestEvent.actor;
  const actorAgent = actor.type === "agent" ? agents.find((a) => a.id === actor.id) : undefined;
  const actorMember = actor.type === "user"
    ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: actor.id }, members, currentUser)
    : undefined;
  const actorName = actorAgent?.displayName ?? actorAgent?.name ?? actorMember?.displayName ?? actorMember?.name ?? actor.name;
  const parts = objectRowParts(item, actorName, intl);
  const home = objectRowHome(item);
  const target = useMemo(() => artifactActivityTarget(item), [item]);
  const intent = useArtifactOpenIntent(target, item.summary);
  const actorAvatar = actor.type === "agent" ? (
    <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={actorAgent?.avatarUrl ?? null} />
  ) : (
    <AvatarSlot
      context="sidebar-list"
      type="human"
      humanAvatarUrl={actorMember?.avatarUrl ?? null}
    />
  );
  const unreadCount = item.unreadCount;
  const shouldShowMentionBadge = !activityMentionsOnly(filter) && item.hasMention && unreadCount > 0;

  const titleId = useId();
  const bodyId = useId();
  const timeId = useId();
  const handleLongPress = useCallback((coords: { x: number; y: number }) => onLongPress(coords, item), [item, onLongPress]);
  const longPress = useLongPress(handleLongPress);
  const longPressSuppressClickRef = longPress.suppressClickRef;
  const { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchCancel } = longPress;
  const handleOpen = useCallback((event: React.MouseEvent | ReactKeyboardEvent) => {
    if (longPressSuppressClickRef.current) {
      longPressSuppressClickRef.current = false;
      return;
    }
    onOpen(event, item);
  }, [item, longPressSuppressClickRef, onOpen]);
  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(event, item);
  }, [item, onOpen]);
  const handleContextMenu = useCallback((event: React.MouseEvent) => onContextMenu(event, item), [item, onContextMenu]);
  const handleDone = useCallback(() => onDone(item), [item, onDone]);
  // A phone: Done is its one swipe button, as a conversation row's outer one.
  // No right swipe: an object row can be read but not marked unread again
  // (the contract has no such route), so a swipe couldn't switch it back.
  const swipeEnabled = rowSwipe !== undefined;
  const swipeActions = rowSwipe?.actions;
  const swipeKey = itemKey(item);
  const setSwipeOpen = useCallback((open: boolean) => rowSwipe?.onOpenChange(swipeKey, open), [rowSwipe, swipeKey]);
  const handleFullSwipe = useCallback(() => swipeActions?.done(item), [item, swipeActions]);
  const longPressOpenedMenu = useCallback(() => longPressSuppressClickRef.current, [longPressSuppressClickRef]);
  const swipe = useRowSwipe<HTMLDivElement>({
    enabled: swipeEnabled,
    end: { width: ROW_SWIPE_BUTTON_WIDTH, onFullSwipe: handleFullSwipe, fullSwipe: "remove" },
    open: rowSwipe?.open ?? false,
    onOpenChange: setSwipeOpen,
    shouldYield: longPressOpenedMenu,
  });
  const rowRef = useMergedRowRef(focusRef, swipe.ref);
  const doneLabel = formatMessage({ id: "thread.row.markRowAsDone" }, { conversation: parts.title });
  const lineRef = useOverflowTitle<HTMLSpanElement>(OBJECT_ROW_PART);

  return (
    <RaftInboxItem
      ref={rowRef}
      data-testid="inbox-row"
      data-inbox-key={itemKey(item)}
      data-object-kind={item.objectKind}
      data-focused={focused ? "true" : undefined}
      data-located={located ? "" : undefined}
      active={Boolean(active)}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      {...(swipeEnabled ? swipe.handlers : {})}
      {...(rowSwipe?.open ? dismissLayerProps : {})}
      density="compact"
      data-layout="list"
      className={swipeEnabled ? SWIPE_ROW_CLASS : undefined}
      data-unread={unreadCount > 0 || undefined}
    >
      <InboxItemTrigger
        data-testid="inbox-row-open"
        aria-current={active ? "true" : undefined}
        aria-labelledby={`${titleId} ${bodyId} ${timeId}`}
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
        {...intent}
      />
      {swipeEnabled && swipeActions ? (
        <div data-row-swipe-layer="" aria-hidden="true" data-testid="inbox-row-swipe-actions" className={SWIPE_LAYER_CLASS}>
          <button
            type="button"
            tabIndex={-1}
            {...{ [ROW_SWIPE_ACTION_ATTR]: "done" }}
            data-testid="inbox-row-swipe-done"
            className={SWIPE_DONE_BUTTON_CLASS}
            onClick={() => {
              setSwipeOpen(false);
              swipeActions.done(item);
            }}
          >
            <Check />
            {formatMessage({ id: "thread.row.swipeDone" })}
          </button>
        </div>
      ) : null}
      <InboxItemLeading data-testid="conversation-card-avatar" data-kind="object">
        <IconTile>{parts.icon}</IconTile>
      </InboxItemLeading>
      <InboxItemContent data-testid="conversation-card-content">
        <InboxItemHeading>
          <InboxItemTitle id={titleId} data-testid="conversation-card-primary">{parts.title}</InboxItemTitle>
          <ActivityRowTime at={item.lastActivityAt} wordsId={timeId} />
        </InboxItemHeading>
        <InboxItemLine>
          <InboxItemBody id={bodyId} className={UNREAD_BODY_CLASS} data-testid="conversation-card-body">
            {/* One line: who did what (and, unread, what else is new: "· 3 new
                comments", #81), then where the object lives. As it narrows,
                where it lives truncates first, then the text, down to about a
                dozen characters it always shows (OBJECT_ROW_TEXT_CLASS), then
                the name and what else is new (that down to its count,
                OBJECT_ROW_NEWS_CLASS). While any of it is cut off, the
                line's title is all of it; the line takes the pointer for that
                title and hands a click to the row's trigger (a hover target). */}
            <InboxItemHoverTarget
              render={<span ref={lineRef} />}
              className="flex items-baseline overflow-hidden select-none"
              data-testid="object-card-line"
              {...intent}
            >
              <span className="contents" data-testid="object-card-event">
                <span className="relative top-0.5 mr-1 inline-flex shrink-0" data-testid="conversation-card-sender-avatar">
                  {actorAvatar}
                </span>
                {excerpt ? (
                  // As a message row's excerpt: the sender, then the text (one line, muted once read).
                  <>
                    <InboxItemSender className="min-w-0 overflow-hidden text-ellipsis whitespace-pre" data-object-row-part="" data-testid="object-card-actor">{actorName ?? formatMessage({ id: "artifacts.activity.someone" })}: </InboxItemSender>
                    <span className={OBJECT_ROW_TEXT_CLASS} data-testid="object-card-text">
                      <span className={OBJECT_ROW_TEXT_INNER_CLASS} data-object-row-part="" data-testid="object-card-excerpt">
                        {imagesOnly ?? <InlineMarkdownPreview markdown={excerpt.text} />}
                      </span>
                    </span>
                  </>
                ) : (
                  <span className={OBJECT_ROW_TEXT_CLASS} data-testid="object-card-text">
                    <span className={OBJECT_ROW_TEXT_INNER_CLASS} data-object-row-part="">{parts.event}</span>
                  </span>
                )}
              </span>
              {parts.news.map((news) => (
                <span key={news} className={OBJECT_ROW_NEWS_CLASS} data-testid="object-card-news">
                  <span className={OBJECT_ROW_TEXT_INNER_CLASS} data-object-row-part="">{news}</span>
                </span>
              ))}
              {home ? (
                <span className="ml-1 min-w-0 shrink-1000 truncate" data-object-row-part="" data-testid="object-card-home">
                  {formatMessage({ id: "activity.list.objectHome" }, { home })}
                </span>
              ) : null}
            </InboxItemHoverTarget>
          </InboxItemBody>
          <InboxItemMarks data-testid="conversation-card-marks">
            {shouldShowMentionBadge ? (
              <Tooltip content={formatMessage({ id: "layout.sidebar.mentionedYouTitle" })}>
                <InboxItemHoverTarget
                  render={<SidebarItemIndicator />}
                  role="img"
                  data-testid="inbox-mention-badge"
                  aria-label={formatMessage({ id: "layout.sidebar.mentionedYouAria" })}
                >
                  <AtSign />
                </InboxItemHoverTarget>
              </Tooltip>
            ) : null}
            {unreadCount > 0 ? (
              <SidebarItemCount data-testid="conversation-card-new-badge">{unreadCount}</SidebarItemCount>
            ) : null}
          </InboxItemMarks>
        </InboxItemLine>
        <InboxRowDone phone={swipeEnabled} label={doneLabel} onDone={handleDone} />
      </InboxItemContent>
    </RaftInboxItem>
  );
}

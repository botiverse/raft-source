import {
  Composer,
  ComposerActions,
  ComposerIconButton,
  ComposerSubmit,
  ComposerToolbar,
  ConversationPanelTabs,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemSender,
  Skeleton,
  Tabs,
  TabsLabel,
  TabsList,
  TabsTab,
} from "@botiverse/raft-ui";

import { SkeletonTextBar } from "../components/ui/Skeleton";
import {
  COMPOSER_FULL_EDGE_CLASS,
  MESSAGE_AVATAR_OFFSET,
  TIMELINE_END_ABOVE_COMPOSER,
  TIMELINE_ROW_INSET,
} from "../components/message/composerHost";
import {
  getComposerFontStyle,
  getMessageAvatarSizeClass,
  getMessageBodyFontSizeClass,
  getMessageBodyFontSizeStyle,
  getMessageNameSizeClass,
  useAppearanceStore,
} from "../store/appearanceStore";
import type { MessageBodyFontSize } from "../store/appearanceStore";

/**
 * Placeholders for a conversation, a thread and a message list while they
 * load: raft-ui Skeletons in the shape of what comes (DS Feedback: one
 * placeholder, the size of the content, never swapped for another). The same
 * components fill the boot shell prerendered into index.html
 * (docs/frontend/boot-shell.md), so the first paint and React show the same.
 */

const ROWS = 8;
// Fixed lengths, not shares of the column: a column that changes width (the
// prerendered shell at the default, then the remembered width) keeps its lines.
const LINE_WIDTHS = ["w-[280px]", "w-[360px]"];

/**
 * One message while it loads, built from the parts of the real row: the
 * timeline row's inset, raft-ui MessageItem (its turn border, row inset,
 * avatar gutter and text column), the avatar at MessageItem's `--mi-avatar`
 * size and the sender avatar's offset, and bars inside the sender and body
 * lines, so the row is a real one-turn message's size at every width. The
 * reader's message size (Small / Medium / Large, appearanceStore) sets the
 * avatar, the name's and the body's lines as it does on the loaded row.
 */
function MessageRowSkeleton({ row, size }: { row: number; size: MessageBodyFontSize }) {
  const avatarSize = getMessageAvatarSizeClass(size);
  return (
    <div className={`${TIMELINE_ROW_INSET} w-full`}>
      <MessageItem role="presentation" aria-hidden="true" data-skeleton="" className={avatarSize ? `pointer-events-none ${avatarSize}` : "pointer-events-none"}>
        <MessageItemGutter>
          <MessageItemAvatarSlot className="flex items-start">
            <Skeleton className={`size-(--mi-avatar,35px) ${MESSAGE_AVATAR_OFFSET}`} />
          </MessageItemAvatarSlot>
        </MessageItemGutter>
        <MessageItemContent>
          <MessageItemHeader>
            <MessageItemSender className={getMessageNameSizeClass(size)}>
              <SkeletonTextBar className="w-[120px]" />
            </MessageItemSender>
          </MessageItemHeader>
          <MessageItemBody className={getMessageBodyFontSizeClass(size)} style={getMessageBodyFontSizeStyle(size)}>
            <div><SkeletonTextBar className={LINE_WIDTHS[row % 2]} /></div>
            {row % 3 === 2 ? null : <div><SkeletonTextBar className="w-[160px]" /></div>}
          </MessageItemBody>
        </MessageItemContent>
      </MessageItem>
    </div>
  );
}

/**
 * The rows, bottom up like a conversation (the top row is cut by the edge),
 * ending where the list ends above the composer. `from="top"` lays them top
 * down, for replies under a thread's parent, and shows only the rows that fit
 * whole: the ones that don't wrap into a second column, out of view.
 */
export function MessageRows({ from = "bottom" }: { from?: "bottom" | "top" }) {
  const size = useAppearanceStore((s) => s.messageBodyFontSize);
  const layout = from === "top" ? "flex-wrap content-start" : `justify-end ${TIMELINE_END_ABOVE_COMPOSER}`;
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${layout} overflow-hidden`}>
      {Array.from({ length: ROWS }, (_, row) => <MessageRowSkeleton key={row} row={row} size={size} />)}
    </div>
  );
}

function HeaderRow() {
  return (
    <div className="flex h-(--header-height) shrink-0 items-center border-b border-line-seam px-4">
      <Skeleton variant="line" className="h-[18px] w-36" />
    </div>
  );
}

/** raft-ui ComposerInput's textarea classes (ScrollAreaTextarea's and the `input` recipe part's) and its frame's (without the classes its state adds); the geometry test requires both to equal the real ones'. raft-ui exports no composer recipe and ComposerInput is always a textarea, so they are copied. The line is one line of its type tall (`1lh`), as the empty textarea is; `min-h-6` still holds. */
const COMPOSER_LINE_FRAME_CLASS = "r-scroll-area r-scroll-area--textarea w-full min-w-0 [--r-scroll-area-resize-grip-size:0px]";
const COMPOSER_LINE_CLASS =
  "r-scroll-area__container r-scroll-area__textarea max-h-32 w-full resize-none bg-transparent outline-none field-sizing-content min-h-6 px-0.5 font-sans text-body font-normal text-foreground placeholder:text-foreground-hint";

/**
 * The composer while it loads: MessageInput's edge around raft-ui's Composer
 * card with an empty line of the composer's text (the reader's message size)
 * and its toolbar, the buttons kept invisible for their height only, so the
 * card is the loaded one's size and place. Nothing in it takes focus.
 */
export function ComposerBox() {
  const size = useAppearanceStore((s) => s.messageBodyFontSize);
  return (
    <div className={`shrink-0 bg-layer-canvas ${COMPOSER_FULL_EDGE_CLASS}`} inert aria-hidden="true">
      <Composer data-testid="composer-skeleton">
        {/* The empty line, as a div with ComposerInput's classes: a textarea here would be found
            by `textarea` selectors (an e2e waited on it and pressed ⌘K before the real composer
            was there, #triage:a9297ae5), so `textarea` stays the real composer. */}
        <div className={COMPOSER_LINE_FRAME_CLASS}>
          <div data-slot="composer-input" className={COMPOSER_LINE_CLASS} style={{ ...getComposerFontStyle(size), height: "1lh" }} />
        </div>
        <ComposerToolbar>
          <ComposerActions>
            <ComposerIconButton disabled className="invisible" />
          </ComposerActions>
          <ComposerSubmit type="button" size="icon-md" disabled className="invisible" />
        </ComposerToolbar>
      </Composer>
    </div>
  );
}

const TAB_WIDTHS = ["w-12", "w-12", "w-10"];

/**
 * The conversation's tab bar while it loads: raft-ui ConversationPanelTabs
 * with its tabs list and tabs (their height and the bar's padding at every
 * size), a bar in each label and none of them picked yet. Nothing in it
 * takes focus. Also an agent's profile's tab bar while it loads (ProfilePanel).
 */
export function TabBarRow() {
  return (
    <ConversationPanelTabs render={<Tabs value="" />} inert aria-hidden="true" data-testid="conversation-tabs-skeleton">
      <TabsList>
        {TAB_WIDTHS.map((width, index) => (
          <TabsTab key={index} value={String(index)}>
            <TabsLabel><SkeletonTextBar className={width} /></TabsLabel>
          </TabsTab>
        ))}
      </TabsList>
    </ConversationPanelTabs>
  );
}

/** A conversation: header, tab bar, messages, composer. */
export function ConversationSkeleton() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-layer-canvas" aria-busy="true">
      <HeaderRow />
      <TabBarRow />
      <MessageRows />
      <ComposerBox />
    </div>
  );
}

/** A thread: header, replies, composer. */
export function ThreadSkeleton() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-layer-canvas" aria-busy="true">
      <HeaderRow />
      <MessageRows />
      <ComposerBox />
    </div>
  );
}

/** A conversation that is still being found, in its place; the label is for assistive technology. */
export function ConversationLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <span className="sr-only" role="status">{label}</span>
      <ConversationSkeleton />
    </div>
  );
}

/** A message list's first load, filling its surface. */
export function MessagesLoading({ label, testId }: { label: string; testId?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-layer-canvas" data-testid={testId} aria-busy="true">
      <span className="sr-only" role="status">{label}</span>
      <MessageRows />
    </div>
  );
}

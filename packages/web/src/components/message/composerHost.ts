// MessageInput owns the composer spacing and safe-area inset. RUI panel
// footers also provide spacing by default; neutralize it at both hosts.
//
// z-chrome on BOTH branches: the composer (and everything it pops, e.g. the
// "@" suggestion list) must paint above the timeline's floating overlays - the
// "N new messages" pill sits at z-float in the timeline and used to cover open
// suggestions in the non-overlay composer. Layering the host keeps the whole
// composer one layer instead of each popover carrying its own hard-coded
// z-index.
export function composerHostClassName(overlay: boolean): string {
  return `!flex !shrink-0 !flex-col !items-stretch !p-0 !border-0 before:!hidden ${overlay ? "!absolute inset-x-0 bottom-0 z-chrome" : "!relative z-chrome"}`;
}

// The side edge of a conversation's composer, 20px on a desktop and a phone:
// MessageInput's full composer keeps its frame this far from the panel's
// sides, and every notice stacked above the composer keeps the same edge, so
// a notice is exactly as wide as the frame under it (task #153). A notice
// that took the panel's 12px instead ran 8px past the frame on each side.
/**
 * A timeline row's inline padding: 12px, and with a mouse on a desktop the page
 * inset less the message's own 8px (raft-ui MessageItem px-2), so a message's
 * avatar starts on the 16px content edge like the head above it (stdrc,
 * 2026-11-05).
 */
export const TIMELINE_ROW_INSET = "px-3 md:pointer-fine:px-[calc(var(--page-inset)-8px)]";
/**
 * The sender avatar's drop in a message row's gutter (MessageItem), shared
 * with the message skeleton (boot/bootSkeletons) so the placeholder's avatar
 * sits where the loaded one does.
 */
export const MESSAGE_AVATAR_OFFSET = "mt-0.5";
export const COMPOSER_EDGE_CLASS = "px-(--surface-inset)";
/**
 * A conversation's full composer around its card (MessageInput's root): the
 * side edge, 8px above (which also seats the typing line) and the bottom
 * safe area, 16px. The composer's placeholder (bootSkeletons ComposerBox)
 * takes the same, so its card is where the loaded one is.
 */
export const COMPOSER_FULL_EDGE_CLASS = `${COMPOSER_EDGE_CLASS} pt-2 safe-bottom`;

// A compact composer docked under content that scrolls (attachment comments,
// the forward dialog, its phone page): one seam above it — the line between
// two regions of a panel — and the 12px those surfaces keep around their
// content, so every docked composer sits the same way.
export const COMPOSER_DOCK_CLASS = "shrink-0 border-t border-line-seam p-3";

// Under the last row of a conversation's timeline, when the composer follows:
// the list's end (raft-ui `timeline-end`, the section step less the row's
// inset) less the 8px the composer keeps above its card (MessageInput's
// `pt-2`, which also seats the typing line), so the card sits a section step
// under the last line.
export const TIMELINE_END_ABOVE_COMPOSER = "pb-[calc(var(--spacing-timeline-end)-(--spacing(2)))]";

// Over the first row of a conversation's timeline: raft-ui's
// `timeline-start`, a section step less the lead every row brings above its
// text (a message, the history notice), so the first line sits a section
// step under the panel's head or a rule.
export const TIMELINE_START_ABOVE_ROW = "pt-timeline-start";

// A notice's row in the timeline (HistoryTopState: "Beginning of replies"):
// a row's lead above its one mono-meta line and the row inset below it
// (raft-ui timeline rhythm). The thread's "Loading replies" line takes the
// same box and the notice's line height, so the replies under it start where
// the loaded ones do.
export const TIMELINE_NOTICE_ROW = "pt-timeline-lead pb-timeline-row";
export const TIMELINE_NOTICE_LINE_HEIGHT = "leading-(--text-mono-meta--line-height)";

// The list's end fade over the composer (raft-ui MessageListEndFade) less
// the same 8px: that strip of panel colour above the card lies outside the
// list, so the fade and the strip together span the section step, and at the
// end of the list the fade covers only the empty end, never the last line.
export const END_FADE_ABOVE_COMPOSER = "h-[calc(var(--spacing-timeline-section)-(--spacing(2)))]";

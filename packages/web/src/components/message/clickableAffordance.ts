/**
 * Clickable-affordance contract for in-message references (option A):
 *
 * - A reference that opens something is an `<a>`/`<button>` and shows the
 *   pointer: the RUI message-reference / task-chip recipes carry it, and the
 *   global `a[href="#"]` rule in index.css covers bare anchors. Callsites add
 *   no cursor class (`cursor-wait` while resolving is the one exception).
 * - A reference that cannot be opened is a `<span>` and must not look
 *   clickable: arrow cursor and no hover wash.
 *
 * The RUI chip/sticker recipes put the pointer and the hover/press wash on the
 * root whatever element it renders, so a span-rendered reference cancels them
 * here. The wash is a `background-image` overlay (`overlay-medium`,
 * `overlay-sticker-medium`) that Tailwind emits after `bg-none`, and
 * tailwind-merge does not see it as a conflict, so the cancel needs `!`.
 */
export const STATIC_REFERENCE_CLASS = "cursor-default hover:bg-none! active:bg-none!";

/**
 * A non-clickable mention: no pointer and no underline. The underline and its
 * hover darkening belong to the clickable `MessageReferenceText` link; a span
 * keeps only the bold weight.
 */
export const STATIC_MENTION_CLASS = "cursor-default hover:no-underline";

/**
 * A control that wraps a chip/badge (`<a><Badge/></a>`, `<button><TaskChip/></button>`)
 * puts the chip's hover/press wash on the chip itself, so the wash keeps the
 * chip's own shape and fill. The chip recipes only add it when the chip
 * element is itself the `<a>`/`<button>`.
 */
export const WRAPPED_CHIP_PRESS_CLASS = "hover:*:overlay-medium active:*:overlay-medium";

// Pure layout rules for the title-bar workspace strip (task #140); see
// WorkspaceStrip.tsx. Kept framework-free so they are unit-testable.

/**
 * The avatar button's width where it can't be measured (no layout, e.g.
 * jsdom): raft-ui Button `icon-md` by touch, 32px. With a mouse on a desktop
 * raft-ui makes it the control height (34px, desktop density), so the bar
 * measures the rendered button instead (useStripLayout, the strip's slot probe).
 */
export const STRIP_BUTTON_PX = 32;
/** The gap between avatars (gap-1): n avatars need n slots minus one gap. */
export const STRIP_GAP_PX = 4;
/** One slot = the avatar button + the gap after it. */
export const STRIP_SLOT_PX = STRIP_BUTTON_PX + STRIP_GAP_PX;
/** The strip's lead before its first avatar (WorkspaceStrip's pl-2). */
const STRIP_LEAD_PX = 8;
/**
 * What the hairline before an out-of-range current workspace adds over a plain
 * gap: one more gap-1 plus the 1px line, so the line sits in the middle of
 * a 9px gap. Always reserved, so the count never depends on which workspace
 * is current.
 */
export const STRIP_DIVIDER_PX = 5;

/**
 * Width the avatars may use, given `spanPx` from the name slot's end to the
 * history controls' box. The strip uses all of it: the air before the
 * controls is their own 8px lead (pl-2), the same 8px the strip keeps after
 * the name, so the avatars sit between two equal gaps, with no spare slot
 * before ‹ ›. What is left over is under one slot and goes to the search
 * field (useElasticSearch): avatars keep a fixed rhythm rather than spreading
 * out with the window.
 */
export function stripFreePx(spanPx: number): number {
  return Math.max(0, spanPx - STRIP_LEAD_PX + STRIP_GAP_PX - STRIP_DIVIDER_PX);
}
/** Pointer travel before a press becomes a drag (a click still switches); the switcher menu uses 6. */
export const STRIP_DRAG_THRESHOLD_PX = 6;

/**
 * New switcher order after dragging the item at `from` by `shift` slots.
 * Only the strip's head items (the list's first ones) are draggable, so the
 * strip index IS the list index.
 */
export function reorderAfterDrag(order: readonly string[], from: number, shift: number): string[] {
  const to = Math.max(0, Math.min(order.length - 1, from + shift));
  if (to === from) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** A single extra avatar reads as noise, not a switcher. */
export const STRIP_MIN = 2;

/**
 * How many avatars fit in `freePx` (no fixed cap: the space decides), or 0
 * below STRIP_MIN. `slotPx` is one avatar button plus its gap, as rendered
 * (useStripLayout's avatarSlotPx); callers always pass it, so a fixed 32px
 * avatar can't be counted where raft-ui renders 34.
 */
export function stripCapacity(freePx: number, total: number, slotPx: number): number {
  if (total < 2) return 0;
  const fit = Math.min(total, Math.floor(freePx / slotPx));
  return fit >= STRIP_MIN ? fit : 0;
}

/**
 * Which workspaces to show: the first `n` in switcher order. If the current one
 * sits beyond them, it takes the last slot (after a hairline divider) so "where
 * am I" is always visible in the strip.
 */
export function stripItems<T extends { id: string }>(servers: readonly T[], currentId: string | null, n: number): { items: T[]; currentOutside: boolean } {
  if (n <= 0) return { items: [], currentOutside: false };
  const head = servers.slice(0, n);
  const at = servers.findIndex((s) => s.id === currentId);
  if (at === -1 || at < n) return { items: head, currentOutside: false };
  return { items: [...servers.slice(0, n - 1), servers[at]], currentOutside: true };
}

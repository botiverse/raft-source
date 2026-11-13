import type { HTMLAttributes } from "react";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting. (Mirrors StatusDot /
// PanelHeader.)
type SpanPassthroughProps = HTMLAttributes<HTMLSpanElement> &
  Record<`data-${string}`, string | undefined>;

/**
 * Canonical attention-dot primitive — "something here is waiting for you"
 * (unread messages, pending notifications, an update to install). Raft Design
 * System › Badge / StatusChip: the attention pixel (`rf-pixel--attention`) is
 * a pink square pixel with an ink edge, the same in light and dark. Separate
 * from `<StatusDot>`, which signals presence (online / working / error).
 *
 * **Size = physical fit, NOT priority** (stdrc 2026-05-14 PR #1709 amend,
 * msg=6ad15567). Unread is a binary signal — every attention dot means the
 * same thing ("there is unread here"); size only varies when the dot's
 * physical context can't accommodate the canonical pixel.
 *
 * - `lg` (default) = the DS pixel, 9×9 with a 1.5px ink edge and a 2px
 *   radius. Use everywhere unless the host context is physically too tight.
 * - `sm` = 6×6 with a 1px edge — **compact-only**. Reach for this only when
 *   the parent surface (badge interior, dense list-row inline marker) can
 *   not visually fit `lg`. Not a "lower priority" dot.
 *
 * **Why not merge with StatusDot:** the two primitives have different
 * semantics (attention vs presence) and default colors (pink vs presence-
 * mapped). Splitting keeps each callsite's intent legible at the JSX level.
 *
 * **Edge rule:** both tiers keep the ink edge (`border-sticker-ink`). Every
 * colour block in the DS is a sticker; the edge is what makes the dot read as
 * an attention pixel rather than decoration — don't drop it even at `sm`.
 * Never animated.
 */
import Tooltip from "./Tooltip";

export interface AttentionDotProps extends Omit<SpanPassthroughProps, "children"> {
  /** Size variant. `lg` (default) = the 10px DS pixel (status.md#sizes) — use everywhere by
   *  default. `sm` = 6px — compact-only, reach for it only when the parent
   *  can not fit `lg`. Size is physical fit, not priority. */
  size?: "sm" | "lg";
  /** Tailwind bg token for the dot color. Default `"bg-attention"` (pink: it
   *  waits for you). Override only for notification-kind dots whose kind is
   *  a problem (`"bg-warning"`, orange) — do NOT override for ordinary unread
   *  signals. */
  tone?: string;
}

const SIZE_CLASS: Record<NonNullable<AttentionDotProps["size"]>, string> = {
  sm: "size-1.5 rounded-[1px] border",
  lg: "size-2.5 rounded-[2px] border-[1.5px]",
};

export default function AttentionDot({
  size = "lg",
  tone = "bg-attention",
  className,
  title,
  ...rest
}: AttentionDotProps) {
  const dot = (
    <span
      {...rest}
      className={`inline-block shrink-0 border-sticker-ink ${SIZE_CLASS[size]} ${tone} ${className ?? ""}`}
    />
  );
  // Native title= on a span is only a hover tooltip; route it through the RUI
  // Tooltip so it follows the theme recipe (title= migration, task #595).
  return title ? <Tooltip content={title}>{dot}</Tooltip> : dot;
}

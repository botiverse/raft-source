import type { HTMLAttributes } from "react";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting. (Mirrors StatusDot /
// PanelHeader.)
type SpanPassthroughProps = HTMLAttributes<HTMLSpanElement> &
  Record<`data-${string}`, string | undefined>;

/**
 * Canonical attention-dot primitive — the small filled circle with a black
 * border that flags "something here needs your attention" (unread messages,
 * pending notifications, etc.). Separate from `<StatusDot>`, which signals
 * presence/activity (online / typing / thinking).
 *
 * **Size = physical fit, NOT priority** (stdrc 2026-05-14 PR #1709 amend,
 * msg=6ad15567). Unread is a binary signal — every attention dot means the
 * same thing ("there is unread here"); size only varies when the dot's
 * physical context can't accommodate the canonical 10×10. An earlier
 * 3-tier mapping (cross-context vs in-surface vs inline) tried to encode
 * priority into size; it didn't survive contact with consumers — two
 * adjacent "unread" signals visually competing because one was tagged
 * "global" was the symptom that motivated this rewrite.
 *
 * - `lg` (default) = `size-2.5` (10×10) — **canonical** attention dot.
 *   Use everywhere unless the host context is physically too tight.
 * - `sm` = `size-1` (4×4) — **compact-only**. Reach for this only when
 *   the parent surface (badge interior, dense list-row inline marker) can
 *   not visually fit `lg` without crowding. Not a "lower priority" dot.
 *
 * **Why not merge with StatusDot:** the two primitives have different
 * semantics (attention vs presence) and default colors (brutal-pink vs
 * activity-mapped). Merging would force a one-or-the-other-undefined API;
 * splitting keeps each callsite's intent legible at the JSX level.
 *
 * **Border rule:** both tiers keep `border border-black`. The border is
 * what makes the dot read as an "attention chip" rather than a decorative
 * pixel — don't drop it even at `sm`.
 */
export interface AttentionDotProps extends Omit<SpanPassthroughProps, "children"> {
  /** Size variant. `lg` (default) = `size-2.5` — canonical attention
   *  dot, use everywhere by default. `sm` = `size-1` — compact-only,
   *  reach for it only when the parent can not fit `lg`. Size is physical
   *  fit, not priority. */
  size?: "sm" | "lg";
  /** Tailwind bg token for the dot color. Default `"bg-brutal-pink"`.
   *  Override for notification-kind dots (e.g. `KIND_DOT_BG[kind]` →
   *  `"bg-brutal-orange"` for warnings) — keep using the existing kind→bg
   *  map at the callsite. Do NOT override for ordinary unread signals;
   *  brutal-pink is the canonical unread color. */
  tone?: string;
}

const SIZE_CLASS: Record<NonNullable<AttentionDotProps["size"]>, string> = {
  sm: "size-1",
  lg: "size-2.5",
};

export default function AttentionDot({
  size = "lg",
  tone = "bg-brutal-pink",
  className,
  ...rest
}: AttentionDotProps) {
  return (
    <span
      {...rest}
      className={`inline-block shrink-0 rounded-full border border-black ${SIZE_CLASS[size]} ${tone} ${className ?? ""}`}
    />
  );
}

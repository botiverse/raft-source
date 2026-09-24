import type { HTMLAttributes } from "react";
import type { AgentActivity } from "@botiverse/raft-shared";
import { getActivityDotClass } from "../../utils/activity";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting. (Mirrors PanelHeader.)
type SpanPassthroughProps = HTMLAttributes<HTMLSpanElement> &
  Record<`data-${string}`, string | undefined>;

/**
 * Canonical status-dot primitive — covers every inline "colored circle with
 * black border" that signals presence / activity / binary state across the
 * app (~20 callsites: Sidebar, ChatPanel, AgentDetailPanel, MachineDetailPanel,
 * ProfilePreviewCardContent, AgentListRow, AgentActivityLog, MessageItem avatar
 * overlay, ChannelMembers, etc.).
 *
 * stdrc 2026-05-10 #wg-theme:f5a597b3 ("@Duoyu 来做 StatusDot") — Tier 1
 * theme-componentization audit candidate, same primitive, different prop
 * combinations for each surface.
 *
 * **API design** (follows PanelHeader conventions — Joy 2026-05-10 design API note):
 * - `activity` drives the color via `getActivityDotClass()`. For non-activity
 *   binary states (machine online/offline, waiting pulse, etc.) pass `tone`
 *   with a Tailwind color token like `"bg-brutal-lime"` — `activity` wins
 *   if both are provided.
 * - `size` is the canonical variant axis. `md` = `size-2.5` (headers,
 *   sidebar, ChannelMembers, machine detail — the standard size from
 *   CLAUDE.md). `sm` = `size-2` (inline text contexts — profile preview cards,
 *   AgentActivityLog, AgentDetailPanel machine info). `lg` = `h-[11px]
 *   w-[11px]` (MessageItem avatar overlay).
 * - `pulse` adds `animate-pulse` — used for "waiting for input" / "thinking"
 *   affordances where the activity mapping does not already encode pulse.
 * - `className` passes through for positioning overrides (e.g. `absolute
 *   -bottom-0.5 -right-0.5`, `inline-block`, `shrink-0`, etc.).
 */
export interface StatusDotProps extends Omit<SpanPassthroughProps, "children"> {
  /** Agent activity state; drives the color via `getActivityDotClass()`. */
  activity?: AgentActivity;
  /** Explicit Tailwind bg token for non-activity uses (e.g.
   *  `"bg-brutal-lime"`, `"bg-brutal-orange"`, `"bg-gray-400"`). Ignored
   *  when `activity` is provided (unless `external` is true). */
  tone?: string;
  /** When true, renders neutral `bg-brutal-cyan` tone regardless of `activity`.
   *  For external agents (SHA-V0-014) — no managed liveness green/red. */
  external?: boolean;
  /** Size variant. `md` (default) = `size-2.5`. `sm` = `size-2` for
   *  inline text. `lg` = `size-[11px]` for avatar overlays. */
  size?: "sm" | "md" | "lg";
  /** Adds `animate-pulse` on top of the chosen color. The color util
   *  already pulses for `thinking`/`working`; only use this prop when the
   *  pulse is orthogonal to activity mapping. */
  pulse?: boolean;
}

const SIZE_CLASS: Record<NonNullable<StatusDotProps["size"]>, string> = {
  sm: "size-2",
  md: "size-2.5",
  lg: "size-[11px]",
};

export default function StatusDot({
  activity,
  tone,
  external = false,
  size = "md",
  pulse = false,
  className,
  ...rest
}: StatusDotProps) {
  const colorClass = external
    ? "bg-brutal-cyan"
    : activity ? getActivityDotClass(activity) : tone ?? "bg-gray-400";
  return (
    <span
      {...rest}
      className={`inline-block shrink-0 rounded-full border border-black ${SIZE_CLASS[size]} ${colorClass} ${pulse ? "animate-pulse" : ""} ${className ?? ""}`}
    />
  );
}

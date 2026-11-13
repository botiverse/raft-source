import type { HTMLAttributes } from "react";
import { Status } from "@botiverse/raft-ui";
import type { Presence } from "@botiverse/raft-ui";
import type { AgentActivity } from "@botiverse/raft-shared";
import Tooltip from "./Tooltip";
import { activityPresence } from "../../utils/activity";

// React's `HTMLAttributes` doesn't expose `data-*` keys in TS, so widen
// passthrough prop types with a string-key index signature so callsites
// can attach `data-testid` etc. without casting. (Mirrors PanelHeader.)
type SpanPassthroughProps = HTMLAttributes<HTMLSpanElement> &
  Record<`data-${string}`, string | undefined>;

/** Raft Design System presence lights: fixed meanings, never animated
 *  (raft-ui's `Presence`, drawn by raft-ui `Status presence`). */
export type StatusDotPresence = Presence;

/**
 * Canonical status-dot primitive — every presence / activity / binary-state
 * light across the app (Sidebar, ChatPanel, AgentDetailPanel,
 * MachineDetailPanel, ProfilePreviewCardContent, AgentListRow,
 * AgentActivityLog, MessageItem avatar overlay, ChannelMembers, …).
 *
 * Raft Design System › StatusChip / Avatar: every dot is a square pixel —
 * radius 2, a 1.5px ink edge, a fixed presence colour (online lime, busy
 * yellow, error orange, offline stone, external cyan). It never animates.
 * The pixel and its presence colours are raft-ui's `Status`; this wrapper
 * only maps agent activity onto a presence and routes `title` through the
 * app Tooltip.
 *
 * **API design** (follows PanelHeader conventions — Joy 2026-05-10 design API note):
 * - `presence` names the DS presence light directly. Prefer it for new code.
 * - `activity` maps an agent activity onto its presence light
 *   (thinking / working → busy).
 * - `tone` is the escape hatch for non-presence binary states (an upgrade's
 *   pink, a task status): a Tailwind bg token that replaces the pixel's
 *   colour. `presence` wins over `activity`, which wins over `tone`.
 * - `external` forces the external (cyan) light regardless of the rest
 *   (SHA-V0-014: no managed liveness for external agents).
 * - `size` is the physical-fit axis. `md` (default) = the 10px DS pixel
 *   (headers, sidebar, members, machine detail). `sm` = 8px for inline text
 *   (profile preview cards, activity log). `lg` = 11px for avatar overlays.
 * - No `pulse`: status dots mark AMBIENT states and never animate (task #136 —
 *   an infinite pulse keeps the page rendering at display refresh rate).
 * - `className` passes through for positioning (e.g. `absolute -bottom-0.5
 *   -right-0.5`, `shrink-0`).
 */
export interface StatusDotProps extends Omit<SpanPassthroughProps, "children"> {
  /** DS presence light. Wins over `activity` and `tone`. */
  presence?: StatusDotPresence;
  /** Agent activity state; mapped onto its presence light. */
  activity?: AgentActivity;
  /** Explicit Tailwind bg token for non-presence uses. Ignored when
   *  `presence` or `activity` is provided (or `external` is true). */
  tone?: string;
  /** When true, renders the external (cyan) presence light regardless of
   *  `activity`. For external agents (SHA-V0-014) — no managed liveness. */
  external?: boolean;
  /** Size variant. `md` (default) = 10px DS pixel (raft-ui
   *  Status md, status.md#sizes: even, so it centres in even rows). `sm` = 8px for inline
   *  text. `lg` = 11px for avatar overlays. */
  size?: "sm" | "md" | "lg";
}

export default function StatusDot({
  presence,
  activity,
  tone,
  external = false,
  size = "md",
  className,
  title,
  ...rest
}: StatusDotProps) {
  const resolvedPresence: StatusDotPresence | undefined = external
    ? "external"
    : presence ?? (activity ? activityPresence(activity) : undefined);
  const dot = (
    <Status
      {...rest}
      size={size}
      presence={resolvedPresence ?? (tone ? undefined : "offline")}
      className={[resolvedPresence ? "" : tone ?? "", className ?? ""].join(" ").trim() || undefined}
    />
  );
  // Native title= on a span is only a hover tooltip; route it through the RUI
  // Tooltip so it follows the theme recipe (migration wave for title=, task #595).
  return title ? <Tooltip content={title}>{dot}</Tooltip> : dot;
}

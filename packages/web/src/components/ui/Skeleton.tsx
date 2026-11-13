import type { HTMLAttributes } from "react";
import { Skeleton } from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import type { ListRowSkeletonProps } from "@botiverse/raft-ui/wip";
import { useListSkeletonShown } from "./useListSkeletonShown";

/**
 * Loading-placeholder compositions built from raft-ui's Skeleton.
 *
 * Raft Design System › Loading (`rf-skel`): a passive indicator — the sunken
 * fill with the sticker radius, never pink. The shape is the content that is
 * coming: text is a `line`, an avatar is a square `block` (every identity in
 * the DS is a square sticker). Size comes from `className`; skeletons are
 * aria-hidden, so announce loading at the region level (e.g. `aria-busy` on
 * the list container).
 *
 * Layout-shift rule: a skeleton MUST occupy the same box the real content
 * will. Build row-skeletons to the SAME height/padding as the real row (see
 * SkeletonRow + each panel's row classes), so loaded content swaps in without
 * the page jumping.
 */

/**
 * A bar inside a line of text (raft-ui ListRowSkeleton's bar): put it in the
 * element that holds that text in the real row, so the line's own type gives
 * the placeholder its height and the row is the loaded row's size.
 */
export function SkeletonTextBar({ className }: { className: string }) {
  return <Skeleton variant="line" className={`inline-block h-[0.75em] max-w-full align-middle ${className}`} />;
}

export interface SkeletonRowProps extends HTMLAttributes<HTMLDivElement> {
  /** Render an avatar/icon stand-in on the left (sized via avatarClassName). */
  avatar?: boolean;
  /** Sizing for the avatar stand-in — MUST match the real row's avatar box. */
  avatarClassName?: string;
  /** Width classes for each text line, top to bottom. Defaults to a 2-line row. */
  lineWidths?: string[];
}

/**
 * SkeletonRow — a composable list-row skeleton (avatar + stacked lines).
 *
 * Pass the SAME outer height/padding classes the real row uses (via `className`)
 * and the SAME avatar box (via `avatarClassName`) so the placeholder is the
 * exact height of the loaded row. Example — sidebar channel/DM row (~44px):
 *
 *   <SkeletonRow
 *     className="gap-1.5 px-2 py-2"
 *     avatar avatarClassName="size-[18px]"
 *     lineWidths={["w-24"]}
 *   />
 */
export function SkeletonRow({
  avatar = false,
  avatarClassName = "size-[18px]",
  lineWidths = ["w-3/4", "w-1/2"],
  className = "",
  ...props
}: SkeletonRowProps) {
  return (
    <div className={["flex items-center", className].filter(Boolean).join(" ")} {...props}>
      {avatar && <Skeleton variant="block" className={`shrink-0 ${avatarClassName}`} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {lineWidths.map((w, i) => (
          <Skeleton key={i} variant="line" className={w} />
        ))}
      </div>
    </div>
  );
}

export interface ListRowSkeletonListProps extends ListRowSkeletonProps {
  /** How many rows: about a screenful. */
  count: number;
  /** Milliseconds before the rows show; until then nothing does. */
  delay?: number;
}

/**
 * ListRowSkeletonList — `count` raft-ui `ListRowSkeleton` rows that show once
 * the load passes 1 second, so a fast load goes straight to the rows
 * (raft-design Feedback, "Empty, loading and failed"). `InboxItemSkeletonList`
 * waits on its own; `ListRowSkeleton` doesn't, so the wait lives here. Put it
 * where the rows will be, and mark the region that stays `aria-busy`.
 */
export function ListRowSkeletonList({ count, delay, ...rowProps }: ListRowSkeletonListProps) {
  const shown = useListSkeletonShown(delay);
  if (!shown) return null;
  return Array.from({ length: count }, (_, index) => <ListRowSkeleton key={index} {...rowProps} />);
}

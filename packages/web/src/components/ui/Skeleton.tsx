import type { HTMLAttributes } from "react";

/**
 * Skeleton — the brutal-style loading placeholder primitive.
 *
 * Consolidates the previously ad-hoc `animate-pulse … bg-black/10` placeholders
 * (search results, quoted-message preview, inline translation) into one shared
 * primitive so every loading surface looks the same.
 *
 * Doctrine:
 * - The primitive owns ONLY shimmer (animate-pulse), tone (bg-black/10), and
 *   shape; size comes from `className` (h-/w-/size-).
 * - Sharp corners by default — brutal system has no rounding on content blocks.
 *   `circle` is the sole rounded variant (avatars/dots).
 * - Tone matches the established idiom: bars use bg-black/10; `circle` (avatar
 *   stand-in) uses a slightly lighter bg-black/5 inside a border-2, matching how
 *   real avatar slots render while loading.
 * - aria-hidden: skeletons are decorative; announce loading at the region level
 *   (e.g. `aria-busy` on the list container), not per bar.
 *
 * Layout-shift rule (the whole point of #31): a skeleton MUST occupy the same
 * box the real content will. Build row-skeletons to the SAME height/padding as
 * the real row (see SkeletonRow + each panel's row classes), so loaded content
 * swaps in without the page jumping.
 */

export type SkeletonVariant = "line" | "block" | "circle";

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  // A text-line stand-in. Default height matches the system's text-sm bars (h-3);
  // override via className for taller lines. No radius — brutal bars are square.
  line: "h-3 bg-black/10",
  // A filled block (cards, thumbnails, larger regions). Sharp corners.
  block: "bg-black/10",
  // Avatar / status-dot stand-in. The only rounded variant; bordered + lighter
  // fill to read as an avatar slot, matching existing loading avatars.
  circle: "rounded-full border-2 border-black bg-black/5",
};

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
}

export default function Skeleton({ variant = "block", className = "", ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      {...props}
      className={["animate-pulse", VARIANT_CLASS[variant], className].filter(Boolean).join(" ")}
    />
  );
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
      {avatar && <Skeleton variant="circle" className={`shrink-0 ${avatarClassName}`} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {lineWidths.map((w, i) => (
          <Skeleton key={i} variant="line" className={w} />
        ))}
      </div>
    </div>
  );
}

/**
 * ConversationCardSkeleton — the loading placeholder for ConversationPreviewCard
 * list rows (Inbox + Saved panels, ~96px cards). Mirrors the real card box
 * (`border-2 border-black/30 bg-white p-3`, header line + multi-line preview) so
 * the list does not jump when items load. Shared so inbox/saved stay identical.
 */
export function ConversationCardSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex w-full items-start gap-3 border-2 border-black/30 bg-white p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <Skeleton variant="line" className="w-20" />
              <Skeleton variant="line" className="w-16" />
              <Skeleton variant="line" className="w-10" />
            </div>
            <Skeleton variant="line" className="w-full" />
            <Skeleton variant="line" className="w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

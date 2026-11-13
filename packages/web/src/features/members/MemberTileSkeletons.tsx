import { Card, Skeleton } from "@botiverse/raft-ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MEMBER_TILE_MIN_H } from "./memberRowHeights";

/** raft-design Feedback: a skeleton shows only once the wait passes 1 second, so a fast load never flashes one. */
const SKELETON_DELAY_MS = 1000;

/** Its children, once the wait passes SKELETON_DELAY_MS (ListRowSkeletonList waits the same). */
export function AfterSkeletonDelay({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return shown ? <>{children}</> : null;
}

/**
 * Tiles that stand in for MemberTile while the members load: the same Card,
 * padding, 35px avatar and name line, so the loaded tiles swap in without the
 * grid moving. raft-ui has a ListRowSkeleton but no card one; this is built
 * from its Skeleton.
 */
export function MemberTileSkeletons({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <Card key={index} className={`${MEMBER_TILE_MIN_H} flex-row items-center gap-3 px-4 py-3 pointer-coarse:py-2`} aria-hidden>
      <Skeleton variant="block" className="size-[35px] shrink-0" />
      {/* The name's body line. */}
      <span className="flex h-lh flex-1 items-center text-body"><Skeleton variant="line" className="w-28" /></span>
    </Card>
  ));
}

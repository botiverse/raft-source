import type { ReactNode } from "react";
import {
  Badge,
  InboxItem,
  InboxItemContent,
  InboxItemHeading,
  InboxItemLeading,
  InboxItemMetadata,
  InboxItemSubtitle,
  InboxItemTimestamp,
  InboxItemTitle,
  InboxItemTrailing,
  MessageEmbed,
  MessageEmbedContent,
  MessageEmbedFooter,
  MessageEmbedHeader,
  Skeleton,
} from "@botiverse/raft-ui";
import { InboxItemSkeletonList } from "@botiverse/raft-ui/wip";
import { useSkeletonShown } from "./artifactSkeletonShown";
import { SKELETON_ROWS, TILE_GRID_CLASS } from "./artifactDashboardParts";
import type { DashboardLayout } from "./artifactDashboardParts";

/**
 * The Artifacts home while its first page loads, in the shape of the view it
 * loads into (#proj-raft-ui:#246, Jasper's round 2): the grid's tiles, the
 * table's rows under its header (ArtifactsTable's `loadingRows`), or a
 * phone's rows. Each placeholder is built from the loaded part's own pieces
 * and type classes, so its boxes and line heights are the loaded ones and
 * nothing moves when the content arrives.
 */

/** A bar the height of one line of `type` (the loaded line's box), `width` of it filled. */
function Line({ type, width, className = "" }: { type: string; width: string; className?: string }) {
  return (
    <span className={`flex h-[1lh] min-w-0 items-center ${type} ${className}`}>
      <Skeleton variant="line" className={width} />
    </span>
  );
}

/** About a screenful of tiles: two rows of the widest grid, three of a phone's two columns. */
const TILES = { wide: 10, phone: 6 } as const;

/**
 * ArtifactTile without its content: the cover box, the title line with its version badge, then the footer as the
 * tile lays it out: the author, who can see it (the scope chip, on every tile: an outlined Badge round its icon), the
 * time. On a phone the title takes two lines, as a title does in a tile about 150px wide, and the chip ends the time's
 * line, as it does there (Jasper's round 2: without the chip the tile was 5px short, 27px on a phone).
 */
function TileSkeleton({ phone }: { phone: boolean }) {
  return (
    <MessageEmbed className="relative flex h-full min-w-0 flex-col" data-testid="artifacts-skeleton-tile" aria-hidden>
      <MessageEmbedContent>
        <div className="aspect-[16/10] w-full border-b border-line-hairline bg-fill-muted" />
      </MessageEmbedContent>
      <MessageEmbedHeader className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="grid min-w-0 flex-1" data-testid="artifacts-skeleton-tile-title">
            <Line type="text-subhead" width={phone ? "w-full" : "w-3/4"} />
            {phone ? <Line type="text-subhead" width="w-1/2" /> : null}
          </span>
          <Skeleton variant="block" className="h-5 w-7 shrink-0 rounded-sticker" />
        </div>
      </MessageEmbedHeader>
      <MessageEmbedFooter className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex flex-1 items-center gap-1.5 max-md:basis-full">
          <Skeleton variant="circle" className="size-4 shrink-0" />
          <Line type="text-footnote" width="w-20" />
        </span>
        <span className="ms-auto flex items-center max-md:order-last max-md:self-end">
          <Badge appearance="outline" variant="muted" className="[&_svg]:size-3" data-testid="artifacts-skeleton-tile-scope">
            <Skeleton variant="circle" className="size-3" />
          </Badge>
        </span>
        <Line type="font-mono text-mono-meta" width="w-1/2" className="basis-full max-md:flex-[1_1_min-content]" />
      </MessageEmbedFooter>
    </MessageEmbed>
  );
}

/** A phone's AllRow without its content: the tile, the title, the line under it, the author line and the time. */
function RowSkeleton() {
  return (
    <InboxItem density="compact" aria-hidden data-testid="artifacts-skeleton-row">
      <InboxItemLeading>
        <Skeleton variant="block" className="size-[35px] rounded-sticker" />
      </InboxItemLeading>
      <InboxItemContent>
        <InboxItemHeading>
          <InboxItemTitle><Skeleton variant="line" className="inline-block w-40 align-middle" /></InboxItemTitle>
        </InboxItemHeading>
        <InboxItemSubtitle><Skeleton variant="line" className="inline-block w-28 align-middle" /></InboxItemSubtitle>
        <InboxItemMetadata>
          <Skeleton variant="circle" className="size-4 shrink-0" />
          <Skeleton variant="line" className="w-16" />
        </InboxItemMetadata>
      </InboxItemContent>
      <InboxItemTrailing>
        <InboxItemTimestamp><Skeleton variant="line" className="inline-block w-6 align-middle" /></InboxItemTimestamp>
      </InboxItemTrailing>
    </InboxItem>
  );
}

/**
 * The grid and the phone's rows while the first page loads. The table draws its own (ArtifactsTable `loadingRows`),
 * under its real header.
 */
export function ArtifactDashboardSkeleton({ layout, phone }: { layout: Exclude<DashboardLayout, "table">; phone: boolean }): ReactNode {
  const shown = useSkeletonShown();
  if (layout === "grid") {
    return (
      <div
        className={TILE_GRID_CLASS}
        data-testid="artifacts-all-skeleton"
        data-layout="grid"
      >
        {shown ? Array.from({ length: phone ? TILES.phone : TILES.wide }, (_, index) => <TileSkeleton key={index} phone={phone} />) : null}
      </div>
    );
  }
  return (
    <InboxItemSkeletonList className="py-2" data-testid="artifacts-all-skeleton" data-layout="rows">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => <RowSkeleton key={index} />)}
    </InboxItemSkeletonList>
  );
}

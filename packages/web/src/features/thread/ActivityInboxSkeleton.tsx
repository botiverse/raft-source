import { InboxItemListGroup, InboxItemListHeading, InboxItemSkeleton, InboxItemSkeletonList } from "@botiverse/raft-ui/wip";
import { SkeletonTextBar } from "../../components/ui/Skeleton";
import { ACTIVITY_SKELETON_ROWS } from "./threadsInboxHelpers";

/**
 * The Activity list while its first page loads. Flat rows in the shape of
 * InboxRow (compact, a leading face or tile, no context line, content 20px in
 * like the rows), about a screenful, 2px apart and 8px from the list's ends
 * as the rows are. They show only once the load passes raft-ui's 1s delay, so
 * a fast load goes straight to the rows (raft-design Feedback, "Empty,
 * loading and failed"; task #154).
 *
 * The loaded list opens with a day heading ("Today"), so the skeleton draws
 * one too, as a bar in the heading's own box: without it the first row
 * dropped 30px when the rows came (skeleton round 2, #proj-raft-ui:#246).
 */
export function ActivityInboxSkeleton({ phone }: { phone: boolean }) {
  return (
    <InboxItemSkeletonList data-testid="inbox-loading-skeleton" className={phone ? "pt-2 pb-1" : "py-1"}>
      <InboxItemListGroup>
        <InboxItemListHeading aria-hidden data-testid="inbox-loading-day-heading" render={<div />}>
          <SkeletonTextBar className="w-10" />
        </InboxItemListHeading>
        {Array.from({ length: ACTIVITY_SKELETON_ROWS }, (_, index) => (
          <InboxItemSkeleton key={index} density="compact" leading line />
        ))}
      </InboxItemListGroup>
    </InboxItemSkeletonList>
  );
}

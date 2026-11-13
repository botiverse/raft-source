import { usePullToRefresh } from "@botiverse/raft-ui/wip";
import type { PullToRefresh } from "@botiverse/raft-ui/wip";
import type { RefObject } from "react";
import { PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import { useMediaQuery } from "./effectPrimitives";

// Pull to refresh on a phone page that loads a snapshot and doesn't update
// itself (Raft DS › Navigation › Refreshing, stdrc 2026-10-23): Saved, search
// results once a search is showing, a conversation's files. Never on a page
// fed by realtime updates (messages, Home, Activity, Tasks, Members,
// Computers): those stay current on their own.
//
// raft-ui's hook already answers a finger only; this also keeps it to phone
// widths, so a touch laptop or a tablet's desktop layout never gets it, and
// returns null there. Render `PagePullToRefreshIndicator` with the result as
// the scroller's first child. `onRefresh` settles when the new content is on
// screen; on a failure it keeps the content and shows a `warning` toast with
// the failed first load's message.
export function usePagePullToRefresh(
  scrollRef: RefObject<HTMLElement | null>,
  { onRefresh, disabled = false }: { onRefresh: () => Promise<unknown>; disabled?: boolean },
): PullToRefresh | null {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const pull = usePullToRefresh(scrollRef, { onRefresh, disabled: disabled || !phone });
  return phone ? pull : null;
}

import { PullToRefreshIndicator } from "@botiverse/raft-ui/wip";
import type { PullToRefresh } from "@botiverse/raft-ui/wip";
import { useIntl } from "react-intl";

/** raft-ui's pull indicator with Raft's announcement, for
 *  `usePagePullToRefresh`; nothing off a phone. The scroller's first child. */
export function PagePullToRefreshIndicator({ pull }: { pull: PullToRefresh | null }) {
  const { formatMessage } = useIntl();
  if (!pull) return null;
  return <PullToRefreshIndicator pull={pull} label={formatMessage({ id: "common.refreshing" })} />;
}

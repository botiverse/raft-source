import { Badge } from "@botiverse/raft-ui";
import Tooltip from "./Tooltip";
import { useIntl } from "react-intl";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";

/**
 * A server row's unread count, the same in every server list (Home's
 * switcher, the phone's server tab popover): nothing for the current server
 * or when there is nothing new; a pink count, or a muted gray one when the
 * person muted that server's notifications, capped at 99+. The muted count's
 * reason is its tooltip and, for a screen reader, part of its text, so it is
 * never read as a bare number.
 */
export default function ServerRowUnread({
  summary,
  isCurrent,
}: {
  summary?: ServerUnreadSummary;
  isCurrent: boolean;
}) {
  const intl = useIntl();
  const unread = summary?.activityUnreadCount ?? 0;
  if (isCurrent || unread <= 0) return null;
  const count = unread > 99 ? "99+" : String(unread);
  if (summary?.serverPushMuted === true) {
    const muted = intl.formatMessage({ id: "ui.serverSwitcher.notificationsMuted" });
    return (
      <Tooltip content={muted}>
        <span className="ml-auto shrink-0 font-mono text-mono-meta text-foreground-hint font-normal" data-testid="server-row-unread-muted">
          {count}
          <span className="sr-only">, {muted}</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <Badge variant="accent" className="ml-auto shrink-0 justify-center" data-testid="server-row-unread">
      {count}
    </Badge>
  );
}

import { useIntl } from "react-intl";
import { Badge, Status } from "@botiverse/raft-ui";

/**
 * The top bar's chip while the app shows the last session from the device
 * (OfflineServerLayout): the DS presence chip (a soft Badge with the offline
 * light) stating the whole reason. `compact`: a phone's Home bar, which has
 * room for "Offline" only; the reason is then above the rows
 * (OfflineReasonNotice). No tooltip: the offline frame is inert.
 */
export function OfflineIndicator({ compact = false }: { compact?: boolean }) {
  const { formatMessage } = useIntl();
  const reason = formatMessage({ id: "layout.offline.indicator" });
  return (
    <Badge appearance="soft" variant="muted" role="status" aria-label={reason} className="min-w-0 max-w-full" data-testid="offline-indicator">
      <Status presence="offline" aria-hidden="true" />
      <span className="truncate">{compact ? formatMessage({ id: "layout.offline.title" }) : reason}</span>
    </Badge>
  );
}

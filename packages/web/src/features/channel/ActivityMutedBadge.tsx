import { useIntl } from "react-intl";
import { BellOff } from "lucide-react";
import Tooltip from "../../components/ui/Tooltip";

export function ActivityMutedBadge() {
  const { formatMessage } = useIntl();
  // Icon-only indicator; the tooltip keeps the meaning discoverable.
  return (
    <Tooltip content={formatMessage({ id: "message.chatPanel.activityMuted" })}>
    <span
      className="inline-flex shrink-0 items-center leading-none text-foreground-hint"
      data-testid="activity-muted-badge"
    >
      <BellOff size={12} />
    </span>
    </Tooltip>
  );
}

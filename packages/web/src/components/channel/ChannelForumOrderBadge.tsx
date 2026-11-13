import { useIntl } from "react-intl";
import { ArrowDownWideNarrow } from "lucide-react";
import Tooltip from "../ui/Tooltip";

/**
 * Forum-style channel (#proj-chat:#24): the head says why the order is not
 * post order. Icon-only, like the muted indicator beside it; the tooltip and
 * the accessible name carry the sentence.
 */
export function ChannelForumOrderBadge() {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "message.timeline.sortedByActivity" });
  return (
    <Tooltip content={label}>
      <span
        role="img"
        aria-label={label}
        className="inline-flex shrink-0 items-center leading-none text-foreground-muted"
        data-testid="channel-forum-order-badge"
      >
        <ArrowDownWideNarrow size={14} aria-hidden />
      </span>
    </Tooltip>
  );
}

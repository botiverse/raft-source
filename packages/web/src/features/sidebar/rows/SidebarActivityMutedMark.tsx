import { SidebarItemMetaIcon } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { useIntl } from "react-intl";
import { BellOff } from "lucide-react";

// The bell-off after a muted conversation's name: a channel row's and a DM
// row's are the same mark.
export function SidebarActivityMutedMark() {
  const { formatMessage } = useIntl();
  return (
    <Tooltip content={formatMessage({ id: "layout.sidebar.activityMutedTitle" })}>
    <SidebarItemMetaIcon
      className="shrink-0"
      data-slot="sidebar-item-meta-icon"
      data-testid="sidebar-activity-muted"
      aria-label={formatMessage({ id: "layout.sidebar.activityMutedAria" })}
    >
      <BellOff size={14} />
    </SidebarItemMetaIcon>
    </Tooltip>
  );
}

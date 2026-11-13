import { useCallback } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";

import Tooltip from "../ui/Tooltip";
import { useThreadSectionStore } from "./ChannelSideArea";
import type { ThreadColumnSide } from "./ChannelSideArea";

/**
 * The thread's fold chevron, where it shares its column; none while a region there is expanded (#189 rule 5). Its icon
 * box on the head's content margin, as a section head's first button (raft-ui head edges, `-ml-icon-inset`): the
 * thread's head pulls only its first child, its Back, which the row always hides (index.css), so the chevron pulls
 * itself, and it and the title start where Tasks' and Files' do.
 */
export function ThreadCollapseChevron({ side }: { side: ThreadColumnSide }) {
  const { formatMessage } = useIntl();
  const setCollapsed = useThreadSectionStore((s) => s.setCollapsed);
  const collapsed = side.threadCollapsed;
  const toggle = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
  if (!side.stacked || side.stack.expanded) return null;
  const title = formatMessage({ id: "message.threadPanel.thread" });
  const label = formatMessage({ id: side.threadCollapsed ? "task.sideCard.expand" : "task.sideCard.collapse" }, { title });
  return (
    <Tooltip content={label}>
      <PanelAction aria-label={label} aria-expanded={!side.threadCollapsed} onClick={toggle} className="-ml-icon-inset" data-testid="thread-side-collapse">
        {side.threadCollapsed ? <ChevronRight /> : <ChevronDown />}
      </PanelAction>
    </Tooltip>
  );
}

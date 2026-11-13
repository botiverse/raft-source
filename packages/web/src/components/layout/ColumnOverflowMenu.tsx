import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, PanelAction } from "@botiverse/raft-ui";

import Tooltip from "../ui/Tooltip";

/** A command in a column's ⋯: one of its own actions that didn't fit (rule 6), or Move Left / Move Right (rule 7). */
export interface ColumnMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  testId?: string;
}

/**
 * A column's ⋯ where the column has no menu of its own (Tasks, Files): after its shown actions, before Expand and
 * Close (raft-design panel.md, Rules). Only with something in it (#189 rule 6): none, no ⋯.
 */
export function ColumnOverflowMenu({ items, testId }: { items: readonly ColumnMenuItem[]; testId: string }) {
  const { formatMessage } = useIntl();
  if (items.length === 0) return null;
  const label = formatMessage({ id: "layout.row.more" });
  return (
    <DropdownMenu>
      <Tooltip content={label}>
        <DropdownMenuTrigger render={<PanelAction aria-label={label} data-testid={`${testId}-trigger`}><EllipsisVertical /></PanelAction>} />
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={label} data-testid={`${testId}-menu`}>
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onClick={item.onSelect} data-testid={item.testId}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

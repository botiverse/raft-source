import { createElement, useMemo } from "react";
import { MoveLeft, MoveRight } from "lucide-react";
import { useIntl } from "react-intl";
import type { ChannelSideDrop, ChannelSideSection } from "@botiverse/raft-shared";

import { CONVERSATION, THREAD } from "../layout/rowPlan";
import { rowTabsOf, useRowPlanStore } from "../layout/rowPlanStore";
import type { ColumnMenuItem } from "../layout/ColumnOverflowMenu";
import { columnMoves } from "./columnMovePlaces";

/**
 * #189 rule 7's keyboard path (the prototype's keyMoves; raft-design drag-and-drop.md: a drag is never the only way):
 * ⋯ > Move Left / Move Right (columnMovePlaces), as menu items. Nothing while a column is expanded.
 */

/** `region`'s Move Left / Move Right as ⋯ items, where the planned row lets it move (none otherwise). */
export function useColumnMoveItems(region: string | null): ColumnMenuItem[] {
  const { formatMessage } = useIntl();
  const layout = useRowPlanStore((s) => s.layout);
  const plan = useRowPlanStore((s) => s.plan);
  const active = useRowPlanStore((s) => s.active);
  return useMemo(() => {
    if (!plan || !layout || !region || plan.expandedUnit) return [];
    // A head showing the row's tabs (rule 4) offers no moves, as the prototype's (`keyMoves` none where `o.tabs`):
    // its ⋯ isn't there for them alone, so the tabs keep that room.
    if (rowTabsOf(plan, active, region)) return [];
    // The sections standing in the row's columns: a thread folded into the conversation's column isn't one.
    const open = new Set(plan.units.flatMap((unit) => (unit.key === CONVERSATION ? [] : unit.regions)) as ChannelSideSection[]);
    if (!open.has(region as ChannelSideSection) || (region === THREAD && plan.fold)) return [];
    const section = region as ChannelSideSection;
    const { left, right } = columnMoves(layout, open, section);
    const move = (drop: ChannelSideDrop) => () => useRowPlanStore.getState().moveSection?.(section, drop);
    const items: ColumnMenuItem[] = [];
    // Each with its icon, as every other item in the menus they join (raft-design dropdown-menu.md: a 16px icon, then the label).
    if (left) items.push({ id: "move-left", label: formatMessage({ id: "layout.row.moveLeft" }), icon: createElement(MoveLeft), onSelect: move(left), testId: `column-move-left-${section}` });
    if (right) items.push({ id: "move-right", label: formatMessage({ id: "layout.row.moveRight" }), icon: createElement(MoveRight), onSelect: move(right), testId: `column-move-right-${section}` });
    return items;
  }, [active, formatMessage, layout, plan, region]);
}

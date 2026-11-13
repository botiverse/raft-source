import { useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { DropdownMenuItem } from "@botiverse/raft-ui";

import { useColumnMoveItems } from "../task/columnMoves";
import { ColumnOverflowMenu } from "./ColumnOverflowMenu";
import type { ColumnMenuItem } from "./ColumnOverflowMenu";
import { RowRegionContext } from "./rowPlanStore";

/**
 * #189 rule 7's Move Left / Move Right, last in a column's own ⋯ (the thread's, the Artifact's, an agent profile's),
 * shown only where the section can move (task/columnMoves). `region` defaults to the panel's (RowRegionContext).
 * `lead`: drawn before them only when there is one to draw (a separator, where they may be the only items of the
 * menu's last group: the Artifact's ⋯ for another server's reader, who has no Follow), so no group is left empty.
 */
export function ColumnMoveMenuItems({ region, lead }: { region?: string; lead?: ReactNode }) {
  const contextRegion = useContext(RowRegionContext);
  const items = useColumnMoveItems(region ?? contextRegion);
  return (
    <>
      {items.length > 0 ? lead : null}
      {items.map((item) => (
        <DropdownMenuItem key={item.id} onClick={item.onSelect} data-testid={item.testId}>
          {item.icon}
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * A ⋯ for a profile head that has no ⋯ of its own: the head's own actions that didn't fit it (`folded`, #189 rule 6),
 * then Move Left / Move Right; none with nothing in it.
 */
export function RowMoveMenu({ folded = NO_ITEMS }: { folded?: readonly ColumnMenuItem[] }) {
  const region = useContext(RowRegionContext);
  const moves = useColumnMoveItems(region);
  const items = useMemo(() => [...folded, ...moves], [folded, moves]);
  return <ColumnOverflowMenu items={items} testId={`${region ?? "column"}-overflow`} />;
}

const NO_ITEMS: readonly ColumnMenuItem[] = [];

import { moveChannelSideSection, visibleChannelSideColumns } from "@botiverse/raft-shared";
import type { ChannelSideDrop, ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

/**
 * #189 rule 7's keyboard path (the prototype's keyMoves), as a pure function: where ⋯ > Move Left / Move Right put a
 * section. Out of a column it shares, into a new column of its own beside it; alone in its column, the column swaps
 * places with its neighbour. Only where it changes what shows, and never past four side columns.
 */

const sameShown = (a: ChannelSideLayout, b: ChannelSideLayout, open: ReadonlySet<ChannelSideSection>) =>
  JSON.stringify(visibleChannelSideColumns(a, open).map((c) => c.sections)) === JSON.stringify(visibleChannelSideColumns(b, open).map((c) => c.sections));

/** Where Move Left and Move Right put `section` among the columns showing `open`'s sections; null where it can't go. */
export function columnMoves(layout: ChannelSideLayout, open: ReadonlySet<ChannelSideSection>, section: ChannelSideSection): { left: ChannelSideDrop | null; right: ChannelSideDrop | null } {
  const shown = visibleChannelSideColumns(layout, open);
  const at = shown.findIndex((column) => column.sections.includes(section));
  if (at < 0) return { left: null, right: null };
  const own = shown[at]!;
  const shared = own.sections.length > 1;
  const left: ChannelSideDrop | null = shared ? { kind: "newColumn", at: own.column } : at > 0 ? { kind: "newColumn", at: shown[at - 1]!.column } : null;
  const right: ChannelSideDrop | null = shared ? { kind: "newColumn", at: own.column + 1 } : at < shown.length - 1 ? { kind: "newColumn", at: shown[at + 1]!.column + 1 } : null;
  const ok = (drop: ChannelSideDrop | null) => {
    if (!drop) return null;
    const moved = moveChannelSideSection(layout, section, drop);
    return moved === layout || sameShown(moved, layout, open) ? null : drop;
  };
  return { left: ok(left), right: ok(right) };
}

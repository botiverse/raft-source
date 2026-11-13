import type { CSSProperties } from "react";
import type { RackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";

// The whole card or row opens the computer (a stretched link): its name stays
// the one real button, and its `::after` covers the card or row, which holds
// the hover. What does something of its own (the agent slots, the … menu, the
// next step, a meter's tooltip) sits above that cover.
export const RACK_ABOVE_LINK = "relative z-raised";
/** Every child of a cell above the cover. */
export const RACK_CHILDREN_ABOVE_LINK = "[&>*]:relative [&>*]:z-raised";
/** A row or card that opens something: the cover's hover. */
export const RACK_LINK_SURFACE = "relative hover:overlay-subtle";

// The list's columns (desktop), the same on every row and under the header:
// the computer (252px), its agents (the rest), then the metrics block, one
// 80px cell each for Disk and Memory (wide enough for "100% usado"), a
// hairline, one 96px cell for every usage runtime, Other (40px), then the next step's column, wide enough for
// "Upgrade to v1.0.53", and the … menu. 12px between all of them.
export const RACK_GAP_PX = 12;
const RACK_CELL_PX = 80;
/**
 * A usage cell: the widest used-up value with the attention pixel beside it,
 * in every locale, whole. "Back in 47h" is 80.8px in the cell's mono, plus a
 * 4px gap and the 8px pixel: 92.8px, so the next 4px step, 96 (#triage:#292).
 */
export const RACK_USAGE_CELL_PX = 96;
const RACK_OTHER_PX = 40;
export const RACK_ACTION_PX = 184;
export const RACK_CELL_WIDTH = "w-20"; // RACK_CELL_PX
export const RACK_USAGE_CELL_WIDTH = "w-24"; // RACK_USAGE_CELL_PX
export const RACK_IDENTITY_WIDTH = "w-[252px]";
export const RACK_OTHER_WIDTH = "w-10";
export const RACK_ACTION_WIDTH = "w-[184px]";

/**
 * A phone block's runtime cells and the header over them: one grid, so they
 * line up. The cells are as wide as the list's (96px) where there is room and
 * narrow together below that (a 360px phone has 328px for four columns and
 * Other), where a value too long for its cell is cut with an ellipsis rather
 * than run into the next.
 */
export function phoneRuntimeGrid(columns: RackRuntimeColumns): CSSProperties {
  const tracks = [`repeat(${columns.usage.length}, minmax(0, ${RACK_USAGE_CELL_PX}px))`];
  if (columns.other.length > 0) tracks.push(`${RACK_OTHER_PX}px`);
  return { display: "grid", gridTemplateColumns: tracks.join(" "), columnGap: 8, alignItems: "start" };
}

/** The narrowest the agents' column gets before the list scrolls sideways. */
const RACK_SLOTS_MIN_PX = 96;

/** The metrics block's width for these columns, so an offline row's recovery can span it. */
export function metricsWidthPx(columns: RackRuntimeColumns): number {
  const widths = [RACK_CELL_PX, RACK_CELL_PX];
  if (columns.usage.length > 0 || columns.other.length > 0) widths.push(1);
  for (let i = 0; i < columns.usage.length; i++) widths.push(RACK_USAGE_CELL_PX);
  if (columns.other.length > 0) widths.push(RACK_OTHER_PX);
  return widths.reduce((sum, width) => sum + width, 0) + RACK_GAP_PX * (widths.length - 1);
}

/** The list's narrowest width: its fixed columns, the slots' minimum, gaps and padding. */
export function listMinWidthPx(columns: RackRuntimeColumns): number {
  const widths = [252, RACK_SLOTS_MIN_PX, metricsWidthPx(columns), RACK_ACTION_PX, 32];
  return widths.reduce((sum, width) => sum + width, 0) + RACK_GAP_PX * (widths.length - 1) + 40;
}

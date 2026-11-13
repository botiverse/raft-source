/**
 * The layout row's width rules (#proj-raft-ui:#189, the design lead's prototype, pt_141adb2e), as pure functions:
 * widths in, widths out, so they run under any test runner. This is the prototype's algorithm (`cascade`, `solve`,
 * `shrinkProp` in its script), not an approximation of it.
 *
 * - Rule 1, a seam: the two columns beside it trade width; once the shrinking one is at its minimum the drag goes on
 *   taking from the next column further out on that side (the cascade). What a release shows is what is saved.
 * - Rule 2: a column may be as narrow as SEAM_COLUMN_MIN_WIDTH; its content keeps its own minimum and is clipped.
 * - Rule 4, the room changing (a window resize, the sidebar opening or closing, a column opening): with room to
 *   spare every column grows in proportion; short of room, each first gives up, in proportion, what it has above its
 *   content's minimum (or its saved width, if that is less: nothing clips yet); then the conversation with the thread
 *   folded into it gives way to 360; then all shrink in proportion towards SEAM_COLUMN_MIN_WIDTH, clipping. Saved
 *   widths never change. Whether the thread folds, and which columns become tabs, is rowPlan's.
 */

/** The narrowest any column in the row may be (rule 2). */
export const SEAM_COLUMN_MIN_WIDTH = 160;

export interface SeamColumn {
  /** Its width on screen now. */
  width: number;
  /** The narrowest a drag may take it. */
  min: number;
}

/**
 * The row's widths, left to right, with the seam between column `seam` and column `seam + 1` moved `dx` px (right is
 * positive). The side the seam moves into gives, nearest column first, each down to its minimum; the column on the
 * other side of the seam takes what was given. The sum never changes.
 */
export function cascadeSeam(columns: readonly SeamColumn[], seam: number, dx: number): number[] {
  const widths = columns.map((column) => column.width);
  if (seam < 0 || seam + 1 >= columns.length || dx === 0) return widths;
  let need = Math.abs(dx);
  const give = (index: number) => {
    const taken = Math.min(need, Math.max(0, widths[index]! - columns[index]!.min));
    widths[index] = widths[index]! - taken;
    need -= taken;
  };
  if (dx > 0) for (let index = seam + 1; index < widths.length && need > 0; index += 1) give(index);
  else for (let index = seam; index >= 0 && need > 0; index -= 1) give(index);
  const taker = dx > 0 ? seam : seam + 1;
  widths[taker] = widths[taker]! + Math.abs(dx) - need;
  return widths;
}

/** How far the seam after column `seam` can move: left (what the columns left of it have above their minimums) and right. */
export function seamReach(columns: readonly SeamColumn[], seam: number): { left: number; right: number } {
  const room = (list: readonly SeamColumn[]) => list.reduce((sum, column) => sum + Math.max(0, column.width - column.min), 0);
  return { left: room(columns.slice(0, seam + 1)), right: room(columns.slice(seam + 1)) };
}

export interface RowUnit {
  /** The width the person left it at. */
  saved: number;
  /** Its content's minimum (conversation 360, thread 360, Tasks and Files 280, Artifact 480, profile 320). */
  contentMin: number;
  /**
   * What it gives way down to before anything clips; min(saved, contentMin) when not given. The conversation with
   * the thread folded into it (rule 3) gives way to min(saved, 720) first, and only then, before any column clips,
   * on down to its content's 360 (`merged`).
   */
  floor?: number;
  /** The conversation with the thread folded into it (rule 3): past the floors it gives way to `contentMin` first. */
  merged?: boolean;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Takes `deficit` px from `widths` in proportion to each, none under `min` (the prototype's shrinkProp). */
function shrinkInProportion(start: readonly number[], deficit: number, min: number): number[] {
  const widths = [...start];
  let left = deficit;
  for (let guard = 0; left > 0.01 && guard < 24; guard += 1) {
    const shrinkable = widths.map((_, index) => index).filter((index) => widths[index]! > min + 0.01);
    if (shrinkable.length === 0) break;
    const total = sum(shrinkable.map((index) => widths[index]!));
    let taken = 0;
    for (const index of shrinkable) {
      const take = Math.min(widths[index]! - min, (left * widths[index]!) / total);
      widths[index] = widths[index]! - take;
      taken += take;
    }
    left -= taken;
  }
  return widths;
}

/**
 * Each unit's width in `available` px (rule 4, the prototype's `solve`): saved widths that leave room over grow in
 * proportion; short of room, each unit first gives up in proportion what it has above its floor (min(saved,
 * contentMin)), so nothing clips; then the conversation with the thread folded into it gives way from 720 to its 360;
 * past that all shrink in proportion towards SEAM_COLUMN_MIN_WIDTH and clip (`clip`).
 */
export function solveUnits(units: readonly RowUnit[], available: number): { widths: number[]; clip: boolean } {
  const saved = units.map((unit) => Math.max(SEAM_COLUMN_MIN_WIDTH, unit.saved));
  const total = sum(saved);
  if (total <= 0) return { widths: saved, clip: false };
  if (total <= available + 0.01) return { widths: saved.map((width) => (width * available) / total), clip: false };
  let deficit = total - available;
  const floors = saved.map((width, index) => Math.min(width, units[index]!.floor ?? units[index]!.contentMin));
  const above = sum(saved.map((width, index) => width - floors[index]!));
  if (deficit <= above + 0.01) {
    return { widths: saved.map((width, index) => (above > 0 ? width - (deficit * (width - floors[index]!)) / above : width)), clip: false };
  }
  const widths = [...floors];
  deficit -= above;
  units.forEach((unit, index) => {
    if (!unit.merged || deficit <= 0) return;
    const give = Math.min(deficit, Math.max(0, widths[index]! - unit.contentMin));
    widths[index] = widths[index]! - give;
    deficit -= give;
  });
  return { widths: shrinkInProportion(widths, deficit, SEAM_COLUMN_MIN_WIDTH), clip: true };
}

/** `solveUnits`' widths alone. */
export function solveRow(units: readonly RowUnit[], available: number): number[] {
  return solveUnits(units, available).widths;
}

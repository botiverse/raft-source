/**
 * What a released drag of a column alone saves (ColumnResizeHandle outside MainLayout's row; in the row a drag trades
 * along it, rowSeams). Task #189: a drag never saves more than the column shows, and a drag that did not move the
 * seam saves nothing.
 */

/**
 * The width a released drag saves, or null for none (the remembered width stays). A drag that changed nothing (it
 * never moved the seam, or ended where it started, as on a seam whose maximum is its minimum) saves nothing: the
 * width it started from is the one shown, which for a squeezed column is less than the remembered one (task #189).
 * Otherwise the last width dragged to, never more than the column can show now (`maxNow`, read from the layout at
 * the release) nor less than `min`.
 */
export function releasedDragWidth(startWidth: number, last: number | null, maxNow: number, min: number): number | null {
  if (last === null || Math.round(last) === Math.round(startWidth)) return null;
  return Math.max(min, Math.min(last, maxNow));
}

/**
 * One step of a drag: shows `next`, unless the seam has not moved yet (a squeezed column keeps its remembered width
 * until it does). `drag.last` records the last width shown, null until then.
 */
export function dragStep(drag: { last: number | null }, startWidth: number, next: number, preview: (width: number) => void): void {
  if (drag.last === null && Math.round(next) === Math.round(startWidth)) return;
  drag.last = next;
  preview(next);
}

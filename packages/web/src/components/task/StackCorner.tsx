import type { CornerEdge, StackCornerDrag } from "./stackCornerDrag";

// Tailwind only sees literal class names, so these are lookups rather than interpolated prefixes.
const EDGE_CLASS = {
  // Across the seam from the scrollbar, as the seam's own handle (ColumnResizeHandle, DS Resizable): inside the
  // column at its left seam, past it at its right one.
  left: "left-0",
  right: "-right-3 pointer-coarse:-right-6",
} as const;

const TEST_ID = { left: "channel-side-corner-resize", right: "channel-side-corner-resize-right" } as const;

/**
 * The crossing of a column's left seam (`edge` left), or of its right one, the next column's left seam (`edge` right),
 * with the seam above stacked section `seam + 1` (useStackCorner; DS Resizable, where two seams cross): the 12px
 * square (24px by touch) where both meet, on the seam's far side from the scrollbar as its handle is, the move cursor; dragged, it moves that seam and the split together.
 * Pointer only: each seam keeps its own keyboard handle. It stands over the resize handle (z-control) on that seam, which
 * runs the full height: the column's own at its left, the next column's at its right.
 */
export function StackCorner({ corner, seam, edge = "left" }: { corner: StackCornerDrag; seam: number; edge?: CornerEdge }) {
  return (
    <div
      aria-hidden="true"
      data-testid={TEST_ID[edge]}
      className={`absolute -top-1.5 z-float size-3 cursor-move touch-none select-none pointer-coarse:-top-3 pointer-coarse:size-6 ${EDGE_CLASS[edge]}`}
      onPointerEnter={() => corner.hover(seam, edge, true)}
      onPointerLeave={() => corner.hover(seam, edge, false)}
      onPointerDown={corner.start(seam, edge)}
      onPointerMove={corner.move}
      onPointerUp={corner.end}
      onPointerCancel={corner.end}
      onLostPointerCapture={corner.end}
      onDoubleClick={() => corner.reset(edge)}
    />
  );
}

/** A stacked seam's crossings: with the column's left seam (`left`) and with its right one (`right`). */
export function StackCorners({ corner, seam, left, right }: { corner: StackCornerDrag; seam: number; left: boolean; right: boolean }) {
  return (
    <>
      {left ? <StackCorner corner={corner} seam={seam} edge="left" /> : null}
      {right ? <StackCorner corner={corner} seam={seam} edge="right" /> : null}
    </>
  );
}

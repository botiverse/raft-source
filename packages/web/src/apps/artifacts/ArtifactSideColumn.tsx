import type { ReactNode } from "react";

import ColumnResizeHandle from "../../components/ui/ColumnResizeHandle";
import { COLUMN_BOUNDS, MAIN_COLUMN_MIN_WIDTH } from "../../lib/panelBounds";
import { useColumnWidth } from "../../store/columnWidthStore";

/**
 * The viewer's side column (the comment list, comment mode's review in its place, the Files panel):
 * beside the content, a column with its own seam (no overlay, no shadow) whose width is dragged on
 * that seam (#proj-workspace:#328) and remembered, as far as the content keeps its 360 and never
 * under the column's minimum; over the content where the viewer is narrow (`cover`), no seam.
 */
export function ArtifactSideColumn({ id, cover, children }: { id: string; cover: boolean; children: ReactNode }) {
  const width = useColumnWidth("artifactComments");
  return (
    <aside
      id={id}
      className={cover ? "absolute inset-0 z-cover flex" : "relative flex shrink-0 border-s border-line-seam"}
      style={cover ? undefined : { width: `max(${COLUMN_BOUNDS.artifactComments.min}px, min(${width}px, 100% - ${MAIN_COLUMN_MIN_WIDTH}px))` }}
      data-testid={id}
    >
      {cover ? null : <ColumnResizeHandle column="artifactComments" edge="left" ownBorder outsideRow />}
      {children}
    </aside>
  );
}

import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDomMeasureEffect, useEventBridge } from "../../hooks/effectPrimitives";
import { COLUMN_BOUNDS, fitLeadingColumnWidth, MAIN_COLUMN_MIN_WIDTH, shareCapWidth } from "../../lib/panelBounds";
import { useColumnWidth } from "../../store/columnWidthStore";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import type { ColumnSnap } from "../ui/ColumnResizeHandle";
import { setSidebarSlotHiddenKeepingFocus, useSidebarSlotHidden } from "./sidebarToggle";
import type { SidebarSlotColumn } from "./sidebarToggle";

// Beyond this much room every remembered width fits, so a wider window needs no re-render.
const ROOM_CAP = Math.max(COLUMN_BOUNDS.sidebar.max, COLUMN_BOUNDS.list.max)
  + MAIN_COLUMN_MIN_WIDTH
  + Math.max(COLUMN_BOUNDS.thread.contentMin, COLUMN_BOUNDS.detail.contentMin);

/**
 * The signed-in shell's sidebar slot column: the sidebar, or the Activity / Search list beside a picked item.
 *
 * Renders at its remembered width, except when the window is too narrow for it, the conversation's 360px and the
 * minimum of the panel open on the right (`rightColumnMin`; 0 when none sits beside the conversation, and always 0
 * in MainLayout's planned row, #189: the sidebar is not in the row, which folds the thread instead, so the sidebar
 * keeps its width when a right panel opens). Outside that row the right panel gives way first, in CSS (index.css
 * caps it at `100% - 360px`); this column then shrinks toward its own minimum, but only while that can still keep
 * the panel beside the conversation (fitLeadingColumnWidth). The remembered width is not touched, so widening the
 * window brings it back.
 *
 * Re-renders when the room changes (a window resize, or the rail beside it changing width) only while the window is
 * narrower than `ROOM_CAP`; its children are elements the parent created, so they do not re-render with it.
 */
export default function ShellSidebarColumn({
  column,
  inline,
  rightColumnMin,
  maxShare,
  collapseColumn = null,
  ownBorder = false,
  className,
  children,
}: {
  column: "sidebar" | "list";
  /** Phone tab root: the column is the page, so it takes no width and has no handle. */
  inline: boolean;
  rightColumnMin: number;
  /** At most this share of the room right of the rail (Activity's list with an item open: half, so the
   *  conversation is never narrower than the list). The remembered width is untouched; the handle's maximum follows. */
  maxShare?: number;
  /** The collapsible column this slot shows (MainLayout's `sidebarCollapsible`), or null where it does not collapse:
   *  dragging the handle 40px past the minimum collapses it, Enter on the handle too (DS Resizable). */
  collapseColumn?: SidebarSlotColumn | null;
  /** Draw the column's right border on the column itself (the Activity and search lists), not on a panel inside it as
   *  the Sidebar does. Its handle is told, so it stands 1px further out and its hover line covers that border, one
   *  1px line as on chat's (ColumnResizeHandle; stdrc, #proj-raft-ui:4558060a). */
  ownBorder?: boolean;
  className: string;
  children: ReactNode;
}) {
  const width = useColumnWidth(column);
  const ref = useRef<HTMLDivElement | null>(null);
  // Room from this column's left edge to the window's right edge; null until laid out (and in jsdom).
  const [room, setRoom] = useState<number | null>(null);
  const measure = useCallback(() => {
    const element = ref.current;
    const windowWidth = document.documentElement.clientWidth;
    if (!element || windowWidth <= 0) return;
    setRoom(Math.min(ROOM_CAP, Math.round(windowWidth - element.getBoundingClientRect().left)));
  }, []);
  // The room changes with the window, and also when something left of the
  // column changes width without the window resizing (the rail shown, hidden or
  // narrowed): the boxes before it, at every level, are watched for that.
  useDomMeasureEffect(() => {
    measure();
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) observer.observe(before);
    }
    return () => observer.disconnect();
  }, [measure, inline]);
  useEventBridge(typeof window === "undefined" ? null : window, "resize", measure);

  const { min } = COLUMN_BOUNDS[column];
  const shareCap = maxShare === undefined || room === null ? undefined : shareCapWidth(room, maxShare, min);
  const fitted = room === null ? width : fitLeadingColumnWidth(room, { width, min }, rightColumnMin);
  const renderedWidth = shareCap === undefined ? fitted : Math.min(fitted, shareCap);
  const collapsed = useSidebarSlotHidden(collapseColumn ?? "sidebar");
  const snap = useMemo<ColumnSnap | undefined>(() => (collapseColumn === null ? undefined : {
    kind: "collapse",
    snapped: collapsed,
    onSnappedChange: (hidden) => setSidebarSlotHiddenKeepingFocus(collapseColumn, hidden),
  }), [collapseColumn, collapsed]);

  return (
    <div
      ref={ref}
      className={ownBorder ? `${className} border-r border-line-seam` : className}
      style={inline ? undefined : { width: renderedWidth }}
      data-testid="shell-sidebar-column"
      // An edge the assistant's otter can be dragged to (assistantOtterDock.ts).
      data-otter-dock={column}
    >
      {children}
      {inline ? null : <ColumnResizeHandle column={column} edge="right" visibleFrom="md" maxWidth={shareCap} snap={snap} ownBorder={ownBorder} />}
    </div>
  );
}

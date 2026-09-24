import { CONTEXT_MENU_VIEWPORT_MARGIN, placeContextMenu } from "../ui/contextMenuPosition";

export const SIDEBAR_CONTEXT_MENU_VIEWPORT_MARGIN = CONTEXT_MENU_VIEWPORT_MARGIN;
export const SIDEBAR_CONTEXT_SUBMENU_GAP = 4;

export function placeSidebarContextMenu({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = SIDEBAR_CONTEXT_MENU_VIEWPORT_MARGIN,
}: {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}) {
  const position = placeContextMenu({
    x,
    y,
    width: menuWidth,
    height: menuHeight,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
    },
    margin,
  });

  return {
    x: position.x,
    y: position.y,
  };
}

export function placeSidebarContextSubmenu({
  anchor,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = SIDEBAR_CONTEXT_MENU_VIEWPORT_MARGIN,
  gap = SIDEBAR_CONTEXT_SUBMENU_GAP,
}: {
  anchor: { left: number; right: number; top: number };
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
}) {
  const rightX = anchor.right + gap;
  const leftX = anchor.left - menuWidth - gap;
  const x = rightX + menuWidth <= viewportWidth - margin
    ? rightX
    : Math.max(margin, leftX);
  const maxY = Math.max(margin, viewportHeight - menuHeight - margin);

  return {
    x,
    y: Math.min(Math.max(anchor.top, margin), maxY),
  };
}

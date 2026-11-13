import {
  CONTEXT_MENU_VIEWPORT_MARGIN,
  placeContextMenu,
} from "../ui/contextMenuPosition";
import type {
  ContextMenuViewport,
} from "../ui/contextMenuPosition";

// The menu's size before it is measured: as wide as its row of quick
// reactions (7 drawings and Add Reaction, 36px each, 2px apart, 3px at each
// side, inside the popup's 4px), and about as tall as its longest form. The
// popup measures itself once it renders and moves back inside the window.
export const MESSAGE_CONTEXT_MENU_WIDTH = 316;
export const MESSAGE_CONTEXT_MENU_HEIGHT = 400;
export const MESSAGE_CONTEXT_MENU_VIEWPORT_MARGIN = CONTEXT_MENU_VIEWPORT_MARGIN;

export interface MessageContextMenuPosition {
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  source: "pointer" | "touch";
}

export function placeTouchMessageContextMenu({
  x,
  y,
  viewport,
}: {
  x: number;
  y: number;
  viewport?: ContextMenuViewport;
}): MessageContextMenuPosition {
  const position = placeContextMenu({
    x,
    y,
    width: MESSAGE_CONTEXT_MENU_WIDTH,
    height: MESSAGE_CONTEXT_MENU_HEIGHT,
    viewport,
    margin: MESSAGE_CONTEXT_MENU_VIEWPORT_MARGIN,
  });

  return {
    anchorX: x,
    anchorY: y,
    x: position.x,
    y: position.y,
    source: "touch",
  };
}

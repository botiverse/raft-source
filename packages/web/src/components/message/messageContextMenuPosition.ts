import {
  CONTEXT_MENU_VIEWPORT_MARGIN,
  placeContextMenu,
} from "../ui/contextMenuPosition";
import type {
  ContextMenuViewport,
} from "../ui/contextMenuPosition";

export const MESSAGE_CONTEXT_MENU_WIDTH = 200;
export const MESSAGE_CONTEXT_MENU_HEIGHT = 224;
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

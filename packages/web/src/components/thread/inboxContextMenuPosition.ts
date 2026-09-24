import {
  CONTEXT_MENU_VIEWPORT_MARGIN,
  placeContextMenu,
} from "../ui/contextMenuPosition";
import type {
  ContextMenuViewport,
} from "../ui/contextMenuPosition";
import type { InboxItem } from "../../store/inboxStore";

export const INBOX_CONTEXT_MENU_WIDTH = 184;
export const INBOX_CONTEXT_MENU_HEIGHT = 96;
export const INBOX_CONTEXT_MENU_VIEWPORT_MARGIN = CONTEXT_MENU_VIEWPORT_MARGIN;

export interface InboxContextMenuPosition {
  x: number;
  y: number;
  maxWidth: number;
  maxHeight: number;
  item: InboxItem;
}

export function placeInboxContextMenu({
  x,
  y,
  item,
  viewport,
}: {
  x: number;
  y: number;
  item: InboxItem;
  viewport?: ContextMenuViewport;
}): InboxContextMenuPosition {
  const position = placeContextMenu({
    x,
    y,
    width: INBOX_CONTEXT_MENU_WIDTH,
    height: INBOX_CONTEXT_MENU_HEIGHT,
    viewport,
    margin: INBOX_CONTEXT_MENU_VIEWPORT_MARGIN,
  });

  return {
    x: position.x,
    y: position.y,
    maxWidth: position.maxWidth,
    maxHeight: position.maxHeight,
    item,
  };
}

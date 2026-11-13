import type { SidebarSortSection } from "./sections/sidebarSortSections";

export interface CtxMenu {
  x: number;
  y: number;
  /** `lounge`: an Agent Lounge row; `id` is the Lounge's channel id. */
  type: "channel" | "agent" | "human" | "dm" | "lounge";
  id: string;
}

export interface SectionCtxMenu {
  x: number;
  y: number;
  section: SidebarSortSection | `custom:${string}`;
}

export interface SidebarSurfaceCtxMenu {
  x: number;
  y: number;
}

// Stryker disable all: shared context-menu geometry and propagation shielding predate the Activity mute action and have separate position/interaction coverage.
export function getSidebarContextMenuStyle(ctxMenu: Pick<CtxMenu, "x" | "y">) {
  return { left: ctxMenu.x, top: ctxMenu.y };
}

export function stopSidebarContextMenuPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}
// Stryker restore all

export type SidebarCtxKind = CtxMenu["type"];

// Touch long-press handlers spread onto a sidebar row button.
export type SidebarLongPress = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
};

import type { PopupAnchorTarget } from "../../components/ui/popupAnchor";
import type { SidebarSortSection } from "./sections/sidebarSortSections";

export interface CtxMenu {
  anchor: PopupAnchorTarget;
  /** `lounge`: an Agent Lounge row; `id` is the Lounge's channel id. */
  type: "channel" | "agent" | "human" | "dm" | "lounge";
  id: string;
}

export interface SectionCtxMenu {
  anchor: PopupAnchorTarget;
  section: SidebarSortSection | `custom:${string}`;
}

export interface SidebarSurfaceCtxMenu {
  anchor: PopupAnchorTarget;
}

// Stryker disable all: shared propagation shielding predates the Activity mute action and has separate interaction coverage.
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

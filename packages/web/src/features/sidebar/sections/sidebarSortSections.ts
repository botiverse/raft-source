import type { MessageId } from "../../../i18n/messages";
import type { SidebarSortMode } from "../../../components/layout/sidebarSort";

export const SIDEBAR_SORT_MODES: SidebarSortMode[] = ["manual", "recent", "az"];
// Sort-mode option labels are display copy — the map now holds the layout
// catalog id and the rendering call sites resolve it through formatMessage.
export const SIDEBAR_SORT_LABEL_ID: Record<SidebarSortMode, MessageId> = {
  manual: "layout.sidebar.sortManual",
  recent: "layout.sidebar.sortRecent",
  az: "layout.sidebar.sortAz",
};

export type SidebarSortSection = "pinned" | "jointChannels" | "channels" | "dms";
// Stryker disable all: accessible section labels are asserted by rendered DOM tests; mutating copy inside Sidebar does not exercise a separate domain seam.
export const SIDEBAR_SORT_SECTION_LABEL_ID: Record<SidebarSortSection, MessageId> = {
  pinned: "layout.sidebar.pinned",
  jointChannels: "layout.sidebar.jointChannels",
  channels: "layout.sidebar.channels",
  dms: "layout.sidebar.directMessages",
};

export const DEFAULT_SECTION_ORDER = ["system:pinned", "system:joint", "system:channels", "system:dms"];
const SORT_SECTION_ORDER_KEY: Record<SidebarSortSection, string> = {
  pinned: "system:pinned",
  jointChannels: "system:joint",
  channels: "system:channels",
  dms: "system:dms",
};

/** A section context-menu target as its key in `sectionOrder`. */
export function sidebarSectionOrderKey(section: SidebarSortSection | `custom:${string}`): string {
  return section.startsWith("custom:") ? section.slice("custom:".length) : SORT_SECTION_ORDER_KEY[section as SidebarSortSection];
}
// Stryker restore all

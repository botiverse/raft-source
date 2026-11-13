// A computer row's parts (ComputerRowBody), shared with its loading
// placeholder (ComputerRowSkeleton) so the placeholder is the loaded row's
// two-line size, glyph box and text lines (skeleton-vs-layout audit,
// #proj-raft-ui:#231).

/** The glyph's box: raft-ui SidebarItemIcon, which must not clip the presence pixel on its corner. */
export const COMPUTER_ROW_ICON_CLASS = "relative overflow-visible";
/** The text column: the name line over the facts line. */
export const COMPUTER_ROW_TEXT_CLASS = "min-w-0 flex-1";
/** The name line. */
export const COMPUTER_ROW_NAME_LINE_CLASS = "flex items-center";
/** The name in its line. */
export const COMPUTER_ROW_NAME_CLASS = "min-w-0 truncate";
/** The facts line (raft-ui SidebarItemMeta): run label / version, upgrade, disk. */
export const COMPUTER_ROW_META_CLASS = "mt-0.5 flex items-center gap-1.5";

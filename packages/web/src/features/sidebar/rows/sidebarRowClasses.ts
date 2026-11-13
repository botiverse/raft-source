// Pure — at module scope so the memoized row leaves below can compute their own
// className from primitive `selected`/`menuOpen` props (no className prop, which
// would change identity every parent render and defeat memoization).
// The row chrome itself (36h, 15/20 500, hover/press overlay, focus ring, the
// yellow "you are here" sticker on `active`, and — with `wrap` — the pinned
// row that grows instead of truncating) is raft-ui SidebarItem's; these
// classes only add the menu-open look while the row's context menu is open
// (the phone tap-target sizing is SidebarItem's own). The row is a list cell:
// a menu open is `fill-cell-hover` on its inset shape, never a fill on the
// whole row (raft-design patterns/lists.md). The menu here is the app's own,
// so the row has no `data-popup-open` for raft-ui to read.
// Stryker disable all: row class-token variants are visual-equivalent under the DOM oracle; wrap/unread behavior is pinned by focused Sidebar DOM tests.
export function sidebarItemClass(selected: boolean, menuOpen = false) {
  return `w-full ${!selected && menuOpen ? "before:bg-fill-cell-hover" : ""}`;
}
// Stryker restore all

// The right-hand column: one badge, or the draft mark + the agent meta. Capped
// at 58% of the row (DS `rf-srow__meta--live`) so a long activity sentence
// never pushes the name out.
export const SIDEBAR_ROW_TRAILING_CLASS = "flex min-w-0 max-w-[58%] flex-initial items-center gap-1.5";

// A section's rows are a list of cells (raft-ui SidebarList's column): 2px
// apart, 8px at its ends (4px above with a mouse on a desktop), so 8px under
// the section's heading. SidebarDndContainer draws it, and the pending
// frame's sidebar (PendingSidebarSkeleton) too, so the loaded rows land where
// its placeholders were.
export const SIDEBAR_SECTION_ROWS_CLASS = "flex flex-col gap-0.5 py-2 md:pointer-fine:pt-1";
// An empty section keeps a row's room for a drop.
export const SIDEBAR_SECTION_EMPTY_ROWS_CLASS = "min-h-7";

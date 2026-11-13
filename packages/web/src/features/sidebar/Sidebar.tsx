import { ScrollArea, SidebarRoot } from "@botiverse/raft-ui";
import { memo } from "react";
import { SettingsSearch } from "../settings/search/DeferredSettingsSearch";
import { useSidebarData } from "./hooks/useSidebarData";
import { useSidebarViewState } from "./hooks/useSidebarViewState";
import { useSidebarSync } from "./hooks/useSidebarSync";
import { useSidebarRowHandlers } from "./hooks/useSidebarRowHandlers";
import { useSidebarRoute } from "./hooks/useSidebarRoute";
import { useSidebarCreateActions } from "./hooks/useSidebarCreateActions";
import { useSidebarItems } from "./hooks/useSidebarItems";
import { useSidebarProjection } from "./hooks/useSidebarProjection";
import { useSidebarDnd } from "./hooks/useSidebarDnd";
import { useSidebarHomeEntries } from "./hooks/useSidebarHomeEntries";
import { useSidebarMenuActions } from "./hooks/useSidebarMenuActions";
import { SidebarTopBar } from "./SidebarTopBar";
import { SidebarComputersRail } from "./computers/SidebarComputersRail";
import { SidebarHomeEntries } from "./rows/SidebarHomeEntries";
import { SidebarChatSections } from "./sections/SidebarChatSections";
import { SidebarDialogs } from "./SidebarDialogs";
import { SidebarSectionContextMenu } from "./menus/SidebarSectionContextMenu";
import { SidebarSurfaceContextMenu } from "./menus/SidebarSurfaceContextMenu";
import { SidebarRowContextMenu } from "./menus/SidebarRowContextMenu";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
interface SidebarProps {
  announcementSlot?: React.ReactNode;
  mobileInline?: boolean;
  /** The top bar is shown (task #753): drop the panel title, as the desktop app does. */
  hideTitle?: boolean;
}
// Stryker restore all

/**
 * Memoised: MainLayout re-renders on many updates the sidebar doesn't show
 * (settings, saved, translation...), and each used to re-render all of its
 * rows (heavy-account boot profile, web perf). Its props are primitives and a
 * stable slot element.
 *
 * The component is the composition of its parts, in their original order: the
 * hooks run in sequence (each reads what the earlier ones return), so the
 * hook calls, effects and their dependencies are those of the single
 * component it was split from (#proj-frontend:#27).
 */
export const Sidebar = memo(function Sidebar({ mobileInline, hideTitle = false, announcementSlot }: SidebarProps) {
  const data = useSidebarData();
  const view = useSidebarViewState(data);
  const sync = useSidebarSync(data, view);
  const rowHandlers = useSidebarRowHandlers(data, view, sync);
  const route = useSidebarRoute(mobileInline, data, view, rowHandlers);
  const createActions = useSidebarCreateActions(data, view);
  const items = useSidebarItems(data, view, sync);
  const projection = useSidebarProjection(data, view, sync, items);
  const dnd = useSidebarDnd(data, view, sync, items, projection);
  const home = useSidebarHomeEntries(mobileInline, data, view, route);
  const menuActions = useSidebarMenuActions(data, view, sync, items, dnd);
  const { sidebarScrollRef } = data;
  const { railMode, showSettingsRail, showComputersRail, showChatRail } = view;
  const { openSidebarSurfaceCtxMenu } = rowHandlers;
  const { settingsTabFromPath, settingsSidebarGroups, serverSlug } = route;

  // `sidebarItemClass` is now defined at module scope (pure) so the memoized row
  // leaves can use it too.

  // Stryker disable next-line StringLiteral: class composition is pinned by source-contract and real-browser scrollbar QA.
  // `.rf-side__body`: no side padding. Each row insets its own state shape
  // 8px and its content 12px inside that (raft-ui SidebarItem; raft-design
  // patterns/lists.md), so the content and the section heads start 20px in,
  // on the head's line; the first section's own 16px top padding (not the
  // scroller) sets the gap under the head.
  // The scroller has no top padding: the rows sit in lists of cells
  // (a gap-0.5 py-2 column), so the first shape is 8px under the head or
  // under the top bar's seam, like the rail beside it, and the first row
  // lines up with the first rail button.
  // raft-ui ScrollArea: an overlay scrollbar that takes no width, so the
  // rows' shapes sit 8px from both edges on every platform (no gutter to
  // measure). The bottom padding is on its content, so the scrollbar runs the
  // full height; the content is at least as tall as the area, so empty space
  // under the rows is still the list.
  const sidebarScrollContentClassName = "min-h-full pb-2 mobile-nav-clearance";

  return (
    <>
      {/* Raft Design System › Sidebar / NavBar. Desktop: the cream sidebar
          (`.rf-side`) between the yellow rail and the white main column, a
          seam on its right. Phone tab roots (mobileInline): the frame's 56px
          top bar over a white paper list (yellow → cream → white). */}
      <SidebarRoot
        // `@container/sidebar`: an App row's badge shortens to "App" while the sidebar is narrower than 260px.
        // Stryker disable next-line StringLiteral: Tailwind composition is presentation-only and browser-smoke verified.
        className={`@container/sidebar relative flex h-full w-full flex-col font-sans text-foreground select-none ${mobileInline ? "bg-layer-canvas" : "border-r border-line-seam bg-layer-sidebar"}`}
        data-testid="sidebar-root"
      >
        <SidebarTopBar mobileInline={mobileInline} hideTitle={hideTitle} data={data} view={view} sync={sync} home={home} />

        {/* Scrollable content: raft-ui ScrollArea, shown while it scrolls
            like raft-ui's own SidebarContent. In Settings, Search settings is
            pinned at its top, opaque and painted over the scrollbar, so the
            scrollbar starts below it: its 8px + field + 4px (SettingsSearch). */}
        <div className="relative flex min-h-0 flex-1">
          <ScrollArea
            ref={sidebarScrollRef}
            trigger="scroll"
            className={showSettingsRail ? "flex-1 [--r-scroll-area-rail-inset-top:calc(var(--control-height)+12px)]" : "flex-1"}
            contentClassName={sidebarScrollContentClassName}
            data-testid="sidebar-scroll-surface"
            onContextMenu={railMode === "chat" ? openSidebarSurfaceCtxMenu : undefined}
          >
          {showSettingsRail ? (
            // Search settings on top of the list (raft-design settings.md#searching-settings);
            // mounted again on another server, whose Settings starts with no query.
            <SettingsSearch key={serverSlug} groups={settingsSidebarGroups} activeId={settingsTabFromPath} mobileInline={mobileInline} />
          ) : showComputersRail ? (
            <SidebarComputersRail mobileInline={mobileInline} data={data} view={view} rowHandlers={rowHandlers} route={route} createActions={createActions} />
          ) : showChatRail ? (
            <>
              {/* Search and Activity are not Home rows on the phone: the phone
                  bar carries both (Activity tab, Search button), so Home's
                  first ListRow entry is Saved (Jasper 2026-10-20). On desktop
                  they live on the LeftRail. No lines between the entries and
                  no "you are here" — the phone shows the current page by
                  pushing it, not in lists. */}

              {/* Tasks moved to its own LeftRail mode, removed from Chat sidebar. */}

              {/* Saved — a sidebar row on desktop (yellow while open), the first
                  Home entry on the phone; its count is the grey mono number. */}
              <SidebarHomeEntries mobileInline={mobileInline} data={data} home={home} />

              <SidebarChatSections
                data={data} view={view} sync={sync} rowHandlers={rowHandlers} route={route}
                createActions={createActions} items={items} projection={projection} dnd={dnd}
              />
            </>
          ) : null /* Members is its own page with no sidebar (shellRouteLayout). */}
          </ScrollArea>
        </div>

        {announcementSlot}

        {/* Nothing below the list: the live-activity bar moved to the head
            (WorkingNowSummary, DS AgentActivity), and account info, Settings,
            Release Notes and Logout live in the LeftRail's account-menu
            flyout (desktop) and the MobileTabBar's Settings tab (mobile). */}
      </SidebarRoot>

      <SidebarDialogs data={data} view={view} menuActions={menuActions} />

      <SidebarSectionContextMenu data={data} view={view} sync={sync} createActions={createActions} items={items} menuActions={menuActions} />

      <SidebarSurfaceContextMenu data={data} view={view} sync={sync} menuActions={menuActions} />

      <SidebarRowContextMenu data={data} view={view} sync={sync} items={items} menuActions={menuActions} />
    </>
  );
});

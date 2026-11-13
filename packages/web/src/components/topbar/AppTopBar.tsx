// The app's top bar at desktop width, the same bar as the desktop app's. One
// row, three regions: the workspace (current name, quick-switch avatars) on
// the left, the search field in the centre, and a trailing region on the right. The two side regions are both flex-1, so the
// search field stays centred whatever they hold, and centred on the WINDOW even
// when a host shell reserves space at one edge (see EDGE_BALANCE below).
//
// The web renders it bare. The desktop shell passes its own extras through the
// slots (history controls, update pill) and marks the row as the window's title
// bar; nothing desktop-specific lives here.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Search } from "lucide-react";
import { Popover, PopoverTrigger, SearchTrigger, SearchTriggerLabel, SearchTriggerShortcut, Skeleton, WorkspaceButton, WorkspaceButtonName } from "@botiverse/raft-ui";
import { useShellOffline, useShellPending } from "../layout/shellPending";
import { OfflineIndicator } from "../layout/OfflineIndicator";
import { useServerStore } from "../../store/serverStore";
import { useRailMode } from "../../hooks/useSidebarTab";
import { trackNavEntrySelected } from "../../analytics/navigation";
import { useShortcutBinding } from "../../features/shortcuts/useShortcutBinding";
import AvatarSlot from "../ui/AvatarSlot";
import { PublicPageGlobe } from "../server/PublicPageGlobe";
import ServerSwitcherMenu from "../ui/ServerSwitcherMenu";
import AttentionDot from "../ui/AttentionDot";
import { DESKTOP_SEARCH_ANCHOR_VARS } from "../../features/search/searchOverlayAnchor";
import { serverSlugFromSearchPath } from "../../features/search/searchOverlayLocation";
import { WorkspaceStrip } from "./WorkspaceStrip";
import { PausedNotificationsIndicator } from "../notifications/PausedNotificationsIndicator";
import { WORKSPACE_UNREAD_BADGE_OFFSET, WorkspaceStripSlotProbe } from "./WorkspaceStripButton";
import { useStripLayout } from "./useStripLayout";
import { useElasticSearch } from "./useElasticSearch";
import { HistoryControls } from "./HistoryControls";
import { TopBarTrailingRoomContext } from "./topBarHostContext";
import { isHistoryNavigationSupported } from "./historyNavigation";
import type { FrameDecorTop } from "./useElasticSearch";
import { stripCapacity, stripItems } from "./workspaceStripLayout";
import { useLocation } from "react-router-dom";
import { serverSlugOfPath } from "../../utils/serverSlugOfPath";

// A host shell reserves window-chrome space at the bar's edges with padding (the
// desktop: the macOS traffic lights' corner on the left, titlebar-area-x, the
// Windows caption buttons on the right) and publishes the same amounts as
// --raft-titlebar-inset-start / --raft-titlebar-inset-end. Padding on one side
// only would push the search field off the window's centre by half of it, and
// the search overlay, which is centred on the window, would no longer line up.
// So the region facing the narrower edge starts from the difference as its flex
// basis (a content-box basis; flex-1 shares the rest equally): both edges then
// end the same distance from the field. The difference is room inside the
// region, not a dead margin beside the field: each side keeps half the window
// less its own edge, so on Windows (caption buttons on the right) the left
// region's workspace name keeps room beside the history controls at the
// minimum width instead of collapsing under them. The web sets neither
// variable, so both bases are 0 there.
//
// Each side's total is the shell's inset plus the region's own horizontal
// padding (box-content, so the bases above are content widths and the padding
// counts on top of them). On the web the left region is LEAD_PAD + pr-2 (17px on
// a touch screen, 15px with a mouse) and the right one pl-2 + TRAIL_PAD (20px,
// 22px with a mouse); in title-bar mode the right region is pl-3 + TRAIL_PAD and
// the left has none, the reserved corner already spacing it. The pads follow
// raft-ui's rail and frame-item tokens, so the sums are written the same way.
const LEAD_PAD = "((var(--rail-width) - 1px - var(--rail-item)) / 2 + 1px)";
const TRAIL_PAD = "(20px - (var(--frame-item-height) - 20px) / 2)";
function edgeBalance(titleBar: boolean) {
  const start = `(var(--raft-titlebar-inset-start, 0px) + ${titleBar ? "0px" : `${LEAD_PAD} + 8px`})`;
  const end = `(var(--raft-titlebar-inset-end, 0px) + ${titleBar ? "12px" : "8px"} + ${TRAIL_PAD})`;
  return {
    leading: { flexBasis: `max(0px, calc(${end} - ${start}))` },
    trailing: { flexBasis: `max(0px, calc(${start} - ${end}))` },
  };
}
const EDGE_BALANCE = { web: edgeBalance(false), titleBar: edgeBalance(true) };

// Raft Design System: the bar is part of the frame (yellow in light, the
// neutral dark frame in dark), with the rail under it and a seam below.
// It is the frame item plus 6px above and below (44px with a mouse: the
// desktop header; 48px on a touch screen), the desktop app's title bar row,
// whose controls fill it: raft-ui `frame-item-height` items (Button
// `on-frame`, WorkspaceButton, SearchTrigger), 6px off its top and bottom edges (the rail's gap between items). On the
// left, the rail's 8px side inset, so the workspace button lines up with the
// rail buttons under it; on the right, the bell's icon box ends 20px from the
// edge, on the line the last icon of the header under it ends on.
// `frame-decor-top`: the theme's pixel art on the bar's right (themes.css;
// none for Raft Yellow, Boring Gray or with the decorations off), in the room
// between the search field and the trailing actions (decorTopStyle).
const BAR_FRAME =
  "relative flex h-[calc(var(--frame-item-height)+2*var(--header-air))] w-full shrink-0 items-center border-b border-line-seam bg-layer-frame text-foreground-on-frame frame-decor-top";

// The theme's strip (raft-ui `frame-decor-top`) ends 16px before the trailing
// actions, counted from the bar's edge inside the reserved corner: raft-ui adds
// the desktop's caption buttons (--raft-frame-inset-end) itself, and positions
// from the padding box, so the padding that reserves them is not counted
// again. Where the whole strip, 16px clear on both sides, does not fit between
// the field and the actions, the bar drops it. Plain variables: a raft-ui
// without the end variable keeps its fixed place and still drops the strip.
function decorTopStyle(decor: FrameDecorTop | undefined): CSSProperties | undefined {
  if (!decor) return undefined;
  return {
    "--frame-decor-top-end": `${decor.endPx}px`,
    ...(decor.fits ? {} : { "--frame-decor-top": "none" }),
  } as CSSProperties;
}

export interface AppTopBarProps {
  /**
   * Back / Forward / History at the end of the left region, next to the search
   * field (a host without browser buttons: TopBarHost.historyControls). Shown
   * only where the browser has the Navigation API.
   */
  historyControls?: boolean;
  /** Rendered in the right region. */
  trailing?: ReactNode;
  /** Desktop shell: the row is the window's title bar (drag region, insets). */
  titleBar?: boolean;
  /** Desktop shell: the modifier of its "switch to workspace N" shortcut, for the strip's tooltips. */
  workspaceShortcutModifier?: string | null;
}

export function AppTopBar({ historyControls = false, trailing, titleBar = false, workspaceShortcutModifier = null }: AppTopBarProps) {
  const { formatMessage } = useIntl();
  const searchShortcut = useShortcutBinding("search");
  // While the server is still being resolved the current one, if any, is the
  // previous server: hold the workspace button as a skeleton (ShellPendingContext).
  const pending = useShellPending();
  const showHistory = historyControls && isHistoryNavigationSupported();
  const server = useServerStore((s) => s.current);
  // While the frame waits, the current server may still be the one being left;
  // it is shown only when it is already the server the URL opens (a server
  // link opened from the device's list, boot/openServerFromDevice).
  const { pathname } = useLocation();
  // Offline (OfflineServerLayout): the server shown from the device's tables.
  const offline = useShellOffline();
  const shownServer = offline
    ? offline.server
    : server && (!pending || server.slug === serverSlugOfPath(pathname)) ? server : null;
  const servers = useServerStore((s) => s.servers);
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const { currentMode, selectRailMode } = useRailMode();
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const workspaceNameRef = useRef<HTMLDivElement>(null);
  const serverNames = useMemo(
    () => servers.map((s) => ({ name: s.name ?? "", publicPageLive: s.publicPageLive === true })),
    [servers],
  );
  const searchFieldRef = useRef<HTMLButtonElement>(null);
  const leadingRegionRef = useRef<HTMLDivElement>(null);
  const trailingRegionRef = useRef<HTMLDivElement>(null);
  const { free: stripFree, slotPx: nameSlotPx, floorPx: switcherFloorPx, avatarSlotPx } = useStripLayout(workspaceNameRef, serverNames, searchFieldRef);
  const searchLayout = useElasticSearch(searchFieldRef, leadingRegionRef, trailingRegionRef);
  const searchWidth = searchLayout?.width;
  const searchStyle = useMemo(() => (searchWidth === undefined ? undefined : { width: searchWidth }), [searchWidth]);
  const decorTop = searchLayout?.decorTop;
  const trailingRoom = searchLayout?.trailingRoom ?? undefined;
  const barStyle = useMemo(() => decorTopStyle(decorTop), [decorTop]);
  const stripCount = stripCapacity(stripFree, servers.length, avatarSlotPx);
  const stripShown = stripCount > 0;
  // In the window's title bar the switcher also never gets narrower than its
  // avatar and chevron (task #161). Below that raft-ui's button overflows on
  // both sides, its avatar under the macOS traffic lights and its chevron into
  // ‹ ›; held at it, the left region runs out of room instead, and the search
  // field (useElasticSearch) gives room back, as the window narrows. The web
  // bar has no window controls at its edges and keeps its own layout.
  const nameSlotMinPx = Math.max(stripShown ? nameSlotPx : 0, titleBar ? switcherFloorPx : 0);
  const nameSlotStyle = useMemo(() => (nameSlotMinPx > 0 ? { minWidth: nameSlotMinPx } : undefined), [nameSlotMinPx]);
  // Another workspace has unread activity but no avatar in the strip to carry
  // the dot (strip collapsed, or that workspace is beyond what fits): the
  // current workspace's avatar carries it — in the strip when it shows, else
  // on the name button — as a raft-ui AvatarBadge, never a free-floating dot.
  const shownIds = new Set(stripItems(servers, server?.id ?? null, stripCount).items.map((s) => s.id));
  const hiddenWorkspaceUnread = servers.some((s) =>
    s.id !== server?.id && !shownIds.has(s.id) && (serverUnreadCounts[s.id]?.activityUnreadCount ?? 0) > 0);

  // Publish the search field's geometry so the search overlay opens from it:
  // its top edge on the field's top edge (searchOverlayAnchor.ts). Only while
  // search is open (a /search path, overlay or page): the field resizes with
  // the window, and every write restyles the whole document (below), so
  // publishing it all the time cost a full-document style recalc on every frame
  // of a window drag (#proj-frontend:#39). Before paint, so the overlay's first
  // frame already sits on the field.
  const searchOpen = serverSlugFromSearchPath(pathname) !== null;
  useLayoutEffect(() => {
    const field = searchFieldRef.current;
    if (!field || !searchOpen) return;
    const root = document.documentElement;
    const px = (n: number) => `${Number(n.toFixed(3))}px`;
    // The anchor is a cross-app contract on <html> (the desktop shell writes
    // it too), and every element inherits a custom property there: a write
    // restyles the whole document. Only write values that changed.
    const write = (name: string, value: string) => {
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    };
    const publish = () => {
      const rect = field.getBoundingClientRect();
      write(DESKTOP_SEARCH_ANCHOR_VARS.top, px(rect.top));
      write(DESKTOP_SEARCH_ANCHOR_VARS.width, px(rect.width));
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(field);
    window.addEventListener("resize", publish);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty(DESKTOP_SEARCH_ANCHOR_VARS.top);
      root.style.removeProperty(DESKTOP_SEARCH_ANCHOR_VARS.width);
    };
  }, [searchOpen]);

  // The same entry the rail's Search tab used: the overlay over the current
  // view, or a plain re-entry when the full search page is already open.
  const openSearch = useCallback(() => {
    trackNavEntrySelected("search", "top_bar", currentMode === "search");
    selectRailMode("search");
  }, [currentMode, selectRailMode]);
  const closeServerMenu = useCallback(() => setServerMenuOpen(false), []);

  const serverName = shownServer?.name ?? "";
  const serverInitial = serverName.slice(0, 1).toUpperCase() || "R";

  const edges = titleBar ? EDGE_BALANCE.titleBar : EDGE_BALANCE.web;

  const serverSwitcher = (
    <Popover open={serverMenuOpen} onOpenChange={setServerMenuOpen}>
      <PopoverTrigger
        render={(
          <WorkspaceButton
            aria-label={!shownServer && pending ? formatMessage({ id: "common.loading" }) : hiddenWorkspaceUnread ? formatMessage({ id: "ui.workspaceStrip.currentWithOtherUnread" }, { name: serverName }) : serverName}
            data-testid="desktop-workspace-trigger"
          />
        )}
      >
        {/* One shape whether the strip shows or not (raft-ui
            WorkspaceButton): the server's avatar, its name, a chevron. */}
        {/* Before the server arrives (PendingServerLayout): its avatar and
            name hold their place as a skeleton, not a stand-in initial. */}
        {shownServer ? (
          <AvatarSlot context="compact-row" type="server" serverAvatarUrl={shownServer.avatarUrl} serverInitial={serverInitial} className="shrink-0" badge={!stripShown && hiddenWorkspaceUnread ? <AttentionDot aria-hidden data-testid="app-top-bar-workspace-unread" /> : undefined} badgeOffset={WORKSPACE_UNREAD_BADGE_OFFSET} />
        ) : (
          <>
            <Skeleton variant="circle" className="size-5 shrink-0" />
            <Skeleton variant="line" className="w-24" />
          </>
        )}
        {/* The name and the public-page globe share one cap: the globe
            is a state of the current server, so outside the cap it made
            a public server's button wider than a private one's, and the
            strip's reserved slot moved on every switch between them
            (WAWQAQ, #proj-frontend:9e1b4abd). Inside it, a long public
            name gives up the globe's width instead. */}
        {serverName && shownServer ? (
          <span data-workspace-name className={`inline-flex min-w-0 items-center gap-2 ${stripShown ? "max-w-[120px]" : "max-w-[160px]"}`}>
            <WorkspaceButtonName className="max-w-none">{serverName}</WorkspaceButtonName>
            <PublicPageGlobe live={shownServer?.publicPageLive === true} />
          </span>
        ) : null}
      </PopoverTrigger>
      <ServerSwitcherMenu
        onClose={closeServerMenu}
        serverUnreadCounts={serverUnreadCounts}
        testId="desktop-server-switcher-menu"
        className="w-64"
      />
    </Popover>
  );

  return (
    <div {...(titleBar ? { "data-raft-titlebar": "" } : {})} data-testid="app-top-bar" className={BAR_FRAME} style={barStyle}>
      {/* Web: 9px on the left, so the switcher's avatar (inside the button's
          1.5px border and 10px padding) sits 20px from the window, as the bell's icon does on
          the right; edgeBalance() makes up the difference to the right
          region, so the search field stays centred on the window. */}
      <div ref={leadingRegionRef} className={`box-content flex min-w-0 flex-1 items-center ${titleBar ? "" : "pr-2 pl-[calc((var(--rail-width)-1px-var(--rail-item))/2+1px)]"}`} style={edges.leading}>
        <div
          ref={workspaceNameRef}
          className="flex min-w-0 w-fit shrink"
          // Reserve the longest name's width while the strip shows, so the
          // strip's position never depends on which workspace is current.
          style={nameSlotStyle}
        >
          {/* The switcher is a raft-ui Popover: it opens 8px under the
              button, in a portal kept on screen. The button is raft-ui's
              WorkspaceButton (the on-frame md Button: 36 tall, 15/20 700,
              10px each side, frame-pressed on hover, press and while open). */}
          {serverSwitcher}
        </div>
        <WorkspaceStrip count={stripCount} shortcutModifier={workspaceShortcutModifier} otherUnread={hiddenWorkspaceUnread} />
        <WorkspaceStripSlotProbe />
        {/* The region's last item, always 8px from the search field. What
            the region has left over goes to the field (useElasticSearch); only
            once the field is at its widest does air open up before ‹ ›.
            Empty on the web: no lead of its own then. */}
        <div data-topbar-leading-end className={`ml-auto flex shrink-0 items-center gap-0.5 ${showHistory ? "pl-2" : ""} ${titleBar ? "pr-2" : ""}`}>
          {showHistory ? <HistoryControls /> : null}
        </div>
      </div>

      {/* Raft DS › top bar search (`rf-topbar__search`): raft-ui SearchTrigger,
          a button drawn as the field (36 tall, the 1.5px ink line, an 18px
          glyph, the placeholder in ink-3). It opens search rather than taking
          input itself. Its width follows the window (32vw) and never
          animates: the strip measures the side regions on every resize. */}
      <SearchTrigger
        ref={searchFieldRef}
        style={searchStyle}
        onClick={openSearch}
        data-search-anchor-field=""
        data-testid="app-top-bar-search"
      >
        <Search aria-hidden />
        <SearchTriggerLabel>{formatMessage({ id: "layout.leftRail.tabSearch" })}</SearchTriggerLabel>
        <SearchTriggerShortcut>{searchShortcut.menuText}</SearchTriggerShortcut>
      </SearchTrigger>

      {/* The bell, last, ends its icon box 20px from the window's edge, on
          the margin of the header under it (DS Alignment › The ends of a
          header): pr-3 plus the 36px frame item's 8px inset around its 20px
          glyph. Its hit area hangs past the line. In title-bar mode pr-3 sits
          inside the caption buttons' inset, so the same 20px holds there. */}
      <div ref={trailingRegionRef} className={`box-content flex min-w-0 flex-1 items-center justify-end gap-1 ${titleBar ? "pl-3 pr-[calc(20px-(var(--frame-item-height)-20px)/2)]" : "pl-2 pr-[calc(20px-(var(--frame-item-height)-20px)/2)]"}`} style={edges.trailing}>
        {offline ? <OfflineIndicator /> : null}
        <PausedNotificationsIndicator />
        <TopBarTrailingRoomContext value={trailingRoom}>{trailing}</TopBarTrailingRoomContext>
      </div>
    </div>
  );
}

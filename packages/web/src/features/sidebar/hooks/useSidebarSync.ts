import { useState, useEffect, useCallback, useEffectEvent, useRef, useMemo } from "react";
import { KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { NonTouchPointerSensor } from "../../../lib/dndSensors";
import { useHoldThenMoveTouchSensor } from "@botiverse/raft-ui/wip";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useServerStore } from "../../../store/serverStore";
import { useMessageStore } from "../../../store/messageStore";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "../../../store/events/notificationPrefsEvents";
import { hasOtherServerActivityUnread } from "../../../utils/serverUnreadSummary";
import { isSidebarDisclosureRestoreState } from "../../../components/layout/sidebarChannelFocus";
import { writeSidebarCollapsedSection, writeSidebarCustomSectionCollapsed } from "../../../components/layout/sidebarCollapsedSections";
import type { SidebarCollapsedSection } from "../../../components/layout/sidebarCollapsedSections";
import type { CtxMenu } from "../sidebarContextMenu";
import { arraysEqual, reconcileOrderIds } from "../sidebarOrderIds";
import { expandSidebarSections } from "../expandSidebarSections";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import { useShortcutLayer } from "../../../features/shortcuts/useShortcutLayer";

/* oxlint-disable react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change, react-doctor/no-event-handler --
 * this state and these effects were the single Sidebar component's own (#proj-frontend:#27); the rules
 * read the values an earlier Sidebar hook passes in as props. */
/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * The Sidebar's effects and their callbacks: the inbox reset on a server
 * switch, closed DMs, the manual order ids, drag sensors, section toggles, the
 * cross-server unread summary, the route auto-expand, Escape on the menus, and
 * the long-press menu opener.
 */
export function useSidebarSync(data: SidebarData, view: SidebarViewState) {
  const {
    dmChannels, channels, channelRowsDisplayOnlyRef, userId, serverId, serversCount, sidebarOrder,
    updateSidebarOrder, hasLocalUnread, loadInbox, navigate, location, loadServerUnreadSummary, ctxMenu,
    setCtxMenu, setMoveToSectionMenuOpen, setMoveToSectionMenuPosition,
  } = data;
  const {
    setSectionCtxMenu, sectionCtxMenu, setSidebarSurfaceCtxMenu, sidebarSurfaceCtxMenu,
    setCollapsedCustomSections, setCtxMenuClickShielded, ctxMenuShieldTimerRef, setShowUserMenu,
    showUserMenu, setCollapsed,
  } = view;

  // Server-switch inbox reset. The first eligible run is skipped: boot is
  // covered by the rooms:joined authority load (or the offline fallback
  // armed in the realtime bootstrap); only actual server switches after that
  // must reset the inbox for the new server.
  const bootInboxArmedRef = useRef(false);
  useEffect(() => {
    if (!bootInboxArmedRef.current) {
      bootInboxArmedRef.current = true;
      return;
    }
    void loadInbox({ reset: true, reason: "initial" });
  }, [loadInbox, serverId]);

  // Closed DMs — server-synced via sidebarOrder for cross-device consistency.
  // Agent Lounge v0: a closed Lounge row is kept the same way, its channel id
  // in `hiddenDmIds` (the server accepts Lounge ids there).
  const closedDmIds = useMemo(() => new Set(sidebarOrder.hiddenDmIds), [sidebarOrder.hiddenDmIds]);
  const closeDm = useCallback((dmId: string) => {
    const current = sidebarOrder.hiddenDmIds;
    if (current.includes(dmId)) return;
    void updateSidebarOrder({ hiddenDmIds: [...current, dmId] });
    // Navigate away if the closed DM (or Lounge, on the channel route) is currently active
    const slug = useServerStore.getState().current?.slug;
    if (slug && (location.pathname === `/s/${slug}/dm/${dmId}` || location.pathname === `/s/${slug}/channel/${dmId}`)) {
      navigate(`/s/${slug}`);
    }
  }, [sidebarOrder.hiddenDmIds, updateSidebarOrder, location.pathname, navigate]);
  const reopenDm = useCallback((dmId: string) => {
    const current = sidebarOrder.hiddenDmIds;
    if (!current.includes(dmId)) return;
    void updateSidebarOrder({ hiddenDmIds: current.filter((id) => id !== dmId) });
  }, [sidebarOrder.hiddenDmIds, updateSidebarOrder]);

  const [channelOrderIds, setChannelOrderIds] = useState<string[]>([]);
  const [dmOrderIds, setDmOrderIds] = useState<string[]>([]);

  // raft-ui's touch rule (DS › States › Dragging on a touch screen): hold
  // still for the row's menu, hold and move to drag it.
  const dndSensors = useSensors(
    useSensor(NonTouchPointerSensor, { activationConstraint: { distance: 6 } }),
    useHoldThenMoveTouchSensor(),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const allChannelId = useMemo(() => channels.find((channel) => channel.name === "all")?.id ?? null, [channels]);

  useEffect(() => {
    const next = reconcileOrderIds(channels, sidebarOrder.channelOrder, allChannelId);
    setChannelOrderIds((prev) => arraysEqual(prev, next) ? prev : next);
  }, [sidebarOrder.channelOrder, channels, allChannelId]);

  useEffect(() => {
    const next = reconcileOrderIds(dmChannels, sidebarOrder.dmOrder);
    setDmOrderIds((prev) => arraysEqual(prev, next) ? prev : next);
  }, [sidebarOrder.dmOrder, dmChannels]);


  const toggleSection = useCallback((section: SidebarCollapsedSection) => {
    setCollapsed((prev) => {
      const nextValue = !prev[section];
      const next = { ...prev, [section]: nextValue };
      writeSidebarCollapsedSection(userId, section, nextValue);
      return next;
    });
  }, [userId]);

  const toggleCustomSection = useCallback((sectionId: string) => {
    setCollapsedCustomSections((current) => {
      const nextValue = !current[sectionId];
      writeSidebarCustomSectionCollapsed(userId, sectionId, nextValue);
      return { ...current, [sectionId]: nextValue };
    });
  }, [userId]);

  useEffect(() => {
    if (!userId || serversCount === 0) return;

    // No mount fetch here: App owns the single boot entry for the summary;
    // this effect keeps only the interval + focus/visibility/prefs triggers.
    // The 2-minute catch-all sweep below bounds OTHER servers' badge staleness
    // (socket cannot tell us those; #8359) — live edges eager-refresh (#8294).
    const intervalId = window.setInterval(() => {
      loadServerUnreadSummary();
    }, 120_000);
    const handleFocus = () => {
      loadServerUnreadSummary();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        loadServerUnreadSummary();
      }
    };
    const handleNotificationPrefsUpdated = () => {
      loadServerUnreadSummary();
    };

    window.addEventListener("focus", handleFocus);
    // Stryker disable next-line StringLiteral: pre-existing browser visibility wiring is outside the notification-prefs behavior slice.
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      // Stryker disable next-line StringLiteral: cleanup mirrors the pre-existing browser visibility listener above.
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    };
    // Depend on the server count, not the servers array identity: a store update
    // that merely re-hydrates the array used to tear this effect down and re-run
    // it, re-triggering the summary fetch (the extra "wave" per refresh).
  }, [userId, serversCount, loadServerUnreadSummary]);

  // Refresh server unread summary eagerly when unread counters change
  // (e.g. incoming message or mark-read), instead of waiting for polling.
  // Not on mount: App's boot fetch already reads it (one boot wave).
  const eagerSummaryMountedRef = useRef(false);
  useEffect(() => {
    if (!userId || serversCount === 0) return;
    if (!eagerSummaryMountedRef.current) {
      eagerSummaryMountedRef.current = true;
      return;
    }
    const timeoutId = window.setTimeout(() => {
      loadServerUnreadSummary();
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [hasLocalUnread, userId, serversCount, loadServerUnreadSummary]);

  const hasOtherServerUnread = useServerStore((s) => hasOtherServerActivityUnread(s.servers, s.current, s.serverUnreadCounts));

  const previousSidebarRouteRef = useRef({
    pathname: location.pathname,
    userId: userId,
  });

  // Reopening a hidden DM reads the latest sidebar order without making it a
  // trigger: the route reveal below must run only when the route changes.
  const reopenRouteDm = useEffectEvent((dmId: string) => reopenDm(dmId));

  // Auto-expand collapsed sections only for a navigation that happens while
  // the Sidebar is already mounted. On the first render, the route merely
  // describes the page being restored and must not override the user's saved
  // disclosure choices. Programmatic reveals stay transient: only an explicit
  // section-header click writes the preference.
  useEffect(() => {
    const path = location.pathname;
    const previousRoute = previousSidebarRouteRef.current;
    previousSidebarRouteRef.current = { pathname: path, userId: userId };
    if (
      path === previousRoute.pathname
      || userId !== previousRoute.userId
      || isSidebarDisclosureRestoreState(location.state)
    ) {
      return;
    }

    const channelMatch = path.match(/\/channel\/(.+)/);
    const dmMatch = path.match(/\/dm\/([^/]+)/);
    const agentMatch = path.match(/\/agent\/(.+)/);
    const machineMatch = path.match(/\/machine\/(.+)/);

    if (channelMatch) {
      setCollapsed((prev) => expandSidebarSections(prev, ["channels"]));
      // Reopen a closed Lounge opened on its channel route (a no-op for any
      // other channel: only DM and Lounge ids are in hiddenDmIds).
      const channelId = path.match(/\/channel\/([^/]+)/)?.[1];
      if (channelId) reopenRouteDm(channelId);
    } else if (dmMatch) {
      // Expand DMs section (reuses agents collapsed state)
      setCollapsed((prev) => expandSidebarSections(prev, ["agents"]));
      // Reopen DM if it was closed (e.g. navigated via Message button)
      reopenRouteDm(dmMatch[1]);
    } else if (agentMatch) {
      // Expand agents in Tab 1 and in Tab 2
      setCollapsed((prev) => expandSidebarSections(prev, ["agents", "machinesAgents"]));
    } else if (machineMatch) {
      setCollapsed((prev) => expandSidebarSections(prev, ["machinesAgents"]));
    }
  }, [location.pathname, location.state, userId]);

  // Close context menu on Escape. Outside-click is handled by the overlay
  // div in the portal (below) — using a document mousedown listener here
  // would race with iOS's synthetic mousedown after a long-press touchend,
  // closing the menu the instant it opens. The overlay pattern is the same
  // one MessageItem uses for its context menu.
  const clearCtxMenu = useCallback(() => setCtxMenu(null), []);
  const closeCtx = useCallback(() => {
    setCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
  }, []);
  // Each menu below is a layer on the registry's stack while open: Esc closes the innermost one (focus stays on
  // its trigger).
  useShortcutLayer("menu", !!ctxMenu, { onEscape: () => { closeCtx(); }, ignoreDefaultPrevented: true });

  // Stryker disable all: global Escape lifecycle is exercised by the Playwright proof; event-listener mutation is not stable in the focused DOM runner.
  const closeSectionCtx = useCallback(() => setSectionCtxMenu(null), []);
  useShortcutLayer("menu", !!sectionCtxMenu, { onEscape: () => { closeSectionCtx(); }, ignoreDefaultPrevented: true });

  const closeSidebarSurfaceCtx = useCallback(() => setSidebarSurfaceCtxMenu(null), []);
  useShortcutLayer("menu", !!sidebarSurfaceCtxMenu, { onEscape: () => { closeSidebarSurfaceCtx(); }, ignoreDefaultPrevented: true });

  // Stryker restore all

  // Close user menu on outside click or Escape
  useEffect(() => {
    if (!showUserMenu) return;
    const onMouseDown = () => setShowUserMenu(false);
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showUserMenu]);
  useShortcutLayer("menu", showUserMenu, { onEscape: () => { setShowUserMenu(false); }, ignoreDefaultPrevented: true });

  const markUnreadSidebarItemRead = useCallback((channelId: string) => {
    const messageStore = useMessageStore.getState();
    if (!messageStore.unreadCounts[channelId] && !messageStore.mentionFlags[channelId]) return;

    messageStore.clearUnread(channelId);
    void messageStore.markRead(channelId).catch(() => {
      void messageStore.loadUnreadCounts();
    });
  }, []);

  // Ref tracking which item is being long-pressed (set on touchstart).
  const longPressTargetRef = useRef<{ type: CtxMenu["type"]; id: string } | null>(null);

  const openCtxMenuAt = useCallback((x: number, y: number, type: CtxMenu["type"], id: string) => {
    if (type === "channel" && channelRowsDisplayOnlyRef.current) return;
    setCtxMenu({ x, y, type, id });
    // Shield against the phantom click that fires after the long-press
    // touchend on iOS PWA standalone mode. Without this, the synthetic
    // click lands on the overlay (or the first menu button, if the finger
    // happens to be over it) and closes the menu immediately.
    setCtxMenuClickShielded(true);
    if (ctxMenuShieldTimerRef.current) clearTimeout(ctxMenuShieldTimerRef.current);
    ctxMenuShieldTimerRef.current = setTimeout(() => {
      setCtxMenuClickShielded(false);
      ctxMenuShieldTimerRef.current = null;
    }, 500);
  }, []);

  // Long-press handler for touch devices. Memoized so useLongPress returns stable
  // method identities — which keeps `makeLongPressHandlers` and the `handleSelect*`
  // callbacks stable, which is what lets the memo'd row leaves skip re-render when
  // the parent re-renders (every message:new churns channels/dmChannels).
  // Stryker disable all: pre-existing long-press dispatch is outside the workspace mutation corpus.
  const onLongPress = useCallback((coords: { x: number; y: number }) => {
    if (longPressTargetRef.current) {
      openCtxMenuAt(coords.x, coords.y, longPressTargetRef.current.type, longPressTargetRef.current.id);
    }
  }, [openCtxMenuAt]);
  // Stryker restore all
  return {
    closedDmIds, closeDm, channelOrderIds, setChannelOrderIds, dmOrderIds, setDmOrderIds, dndSensors,
    allChannelId, toggleSection, toggleCustomSection, hasOtherServerUnread, clearCtxMenu, closeCtx,
    closeSectionCtx, closeSidebarSurfaceCtx, markUnreadSidebarItemRead, longPressTargetRef, onLongPress,
  };
}

export type SidebarSync = ReturnType<typeof useSidebarSync>;

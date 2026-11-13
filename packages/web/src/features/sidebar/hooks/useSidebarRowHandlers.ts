import { useCallback, useLayoutEffect } from "react";
import type { Channel } from "../../../store/channelStore";
import type { Agent } from "../../../store/agentStore";
import { useThreadStore } from "../../../store/threadStore";
import { useProfileStore } from "../../../store/profileStore";
import { opensProfileInPanel } from "../../members/useMembersProfileRedirect";
import { useLongPress } from "../../../hooks/useLongPress";
import { placeSidebarContextMenu } from "../../../components/layout/sidebarContextMenuPosition";
import type { CtxMenu } from "../sidebarContextMenu";
import type { SidebarSortSection } from "../sections/sidebarSortSections";
import type { SidebarData } from "./useSidebarData";
import type { SidebarViewState } from "./useSidebarViewState";
import type { SidebarSync } from "./useSidebarSync";

/* oxlint-disable react-hooks/exhaustive-deps -- the dependency arrays are the single Sidebar component's,
 * unchanged (#proj-frontend:#27). What the rule misses here are the useState setters and useRef objects
 * of earlier Sidebar hooks, which are stable across renders. */
/**
 * Row selection, DM opening and context-menu opening handlers, stable so the
 * memo'd rows skip re-renders, and the menus' on-screen placement.
 */
export function useSidebarRowHandlers(data: SidebarData, view: SidebarViewState, sync: SidebarSync) {
  const {
    channelRowsDisplayOnlyRef, setSidebarOpen, nav, ctxMenu, setCtxMenu, ctxMenuRef,
    setMoveToSectionMenuOpen, setMoveToSectionMenuPosition,
  } = data;
  const {
    setSectionCtxMenu, sectionCtxMenu, sectionCtxMenuRef, setSidebarSurfaceCtxMenu, sidebarSurfaceCtxMenu,
    sidebarSurfaceCtxMenuRef, setOpenSortMenu,
  } = view;
  const { markUnreadSidebarItemRead, longPressTargetRef, onLongPress } = sync;

  const channelLongPress = useLongPress(onLongPress);
  // useLongPress returns a NEW object literal each render but stable method refs;
  // destructure the stable members so downstream useCallbacks don't depend on the
  // unstable object identity.
  const longPressSuppressRef = channelLongPress.suppressClickRef;
  const { onTouchStart: lpTouchStart, onTouchEnd: lpTouchEnd, onTouchMove: lpTouchMove, onTouchCancel: lpTouchCancel } = channelLongPress;

  // Stryker disable all: pre-existing touch forwarding is outside the workspace mutation corpus.
  const makeLongPressHandlers = useCallback((type: CtxMenu["type"], id: string) => ({
    onTouchStart: (e: React.TouchEvent) => {
      longPressTargetRef.current = { type, id };
      lpTouchStart(e);
    },
    onTouchEnd: (e: React.TouchEvent) => lpTouchEnd(e),
    onTouchMove: (e: React.TouchEvent) => lpTouchMove(e),
    onTouchCancel: () => lpTouchCancel(),
  }), [lpTouchStart, lpTouchEnd, lpTouchMove, lpTouchCancel]);
  // Stryker restore all

  // Stryker disable all: route-specific host wiring is contract-pinned and browser-smoke verified.
  const handleSelectChannel = useCallback((channel: Channel, _clickCount = 1) => {
    if (longPressSuppressRef.current) return;
    markUnreadSidebarItemRead(channel.id);
    nav.toChannel(channel.id);
    setSidebarOpen(false);
  }, [longPressSuppressRef, markUnreadSidebarItemRead, nav, setSidebarOpen]);
  // Stryker restore all

  const openDmSurface = useCallback(
    (dmChannelId: string) => {
      markUnreadSidebarItemRead(dmChannelId);
      nav.toDm(dmChannelId);
      setSidebarOpen(false);
    },
    // Stryker disable next-line ArrayDeclaration: callback freshness is exercised by sidebar navigation DOM tests; replacing the dependency list is not observable in the focused mutation lifecycle.
    [markUnreadSidebarItemRead, nav, setSidebarOpen],
  );

  // Stryker disable all: route-specific host wiring is contract-pinned and browser-smoke verified.
  const handleSelectDm = useCallback((dmChannelId: string, _clickCount = 1) => {
    if (longPressSuppressRef.current) return;
    openDmSurface(dmChannelId);
  }, [longPressSuppressRef, openDmSurface]);
  // Stryker restore all

  // The computer open in the side panel (`?profile=computer:<id>`), selected in the list beside it.
  const openComputerId = useProfileStore((s) => (s.profileType === "computer" ? s.profileId : null));

  // Stryker disable all: pre-existing singleton-panel cleanup is outside the workspace mutation corpus.
  const closeRightPanel = useCallback(() => {
    useProfileStore.getState().closeProfile();
    useThreadStore.getState().closeThread();
  }, []);
  // Stryker restore all

  const handleSelectAgent = useCallback((agentId: string, _clickCount = 1) => {
    if (longPressSuppressRef.current) return;
    setSidebarOpen(false);
    // Where /agent/<id> would only redirect to the profile panel (desktop, not
    // the host app: useMembersProfileRedirect), open the panel over the page
    // the list sits beside. A phone keeps the profile as its own page.
    if (opensProfileInPanel()) {
      useThreadStore.getState().closeThread();
      useProfileStore.getState().openProfile("agent", agentId);
      return;
    }
    nav.toAgent(agentId);
    closeRightPanel();
  }, [closeRightPanel, longPressSuppressRef, nav, setSidebarOpen]);
  // Stryker restore all

  // Combined select for agent DM rows: open the existing DM if there is one,
  // otherwise navigate to the agent profile. Stable so <AgentDmRow> stays memo'd.
  // Stryker disable all: typed routing is covered by channel/agent browser smoke.
  const handleSelectAgentDm = useCallback((agent: Agent, dmId: string | undefined, clickCount = 1) => {
    if (dmId) handleSelectDm(dmId, clickCount);
    else handleSelectAgent(agent.id, clickCount);
  }, [handleSelectDm, handleSelectAgent]);
  // Stryker restore all

  // Agent Lounge v0: the Lounge row under an agent's DM row. It is listed
  // only once the Lounge exists, so it opens it directly.
  const handleSelectLounge = useCallback((loungeChannelId: string) => {
    if (longPressSuppressRef.current) return;
    markUnreadSidebarItemRead(loungeChannelId);
    nav.toChannel(loungeChannelId);
    setSidebarOpen(false);
  }, [longPressSuppressRef, markUnreadSidebarItemRead, nav, setSidebarOpen]);

  const handleSelectMachine = useCallback((machineId: string, _clickCount = 1) => {
    // Stryker disable all: route dispatch is browser-smoke verified.
    if (longPressSuppressRef.current) return;
    // Close first: on desktop the computer opens in the side panel
    // (computerPanel.ts), which a close after the navigation would shut.
    closeRightPanel();
    nav.toComputer(machineId);
    setSidebarOpen(false);
  }, [closeRightPanel, longPressSuppressRef, nav, setSidebarOpen]);
  // Stryker restore all

  // Stryker disable all: pre-existing context-menu dispatch is outside the workspace mutation corpus.
  const openCtxMenu = useCallback((e: React.MouseEvent, type: CtxMenu["type"], id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (type === "channel" && channelRowsDisplayOnlyRef.current) return;
    // Skip if useLongPress already opened the menu (prevents double-open on mobile)
    if (longPressSuppressRef.current) return;
    setSectionCtxMenu(null);
    setSidebarSurfaceCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setCtxMenu({ x: e.clientX, y: e.clientY, type, id });
  }, [longPressSuppressRef]);
  // Stryker restore all

  // Stryker disable all: pointer coordinates and portal placement are browser-smoke verified; clamping semantics live in placeSidebarContextMenu.
  const openSectionCtxMenu = useCallback((event: React.MouseEvent, section: SidebarSortSection | `custom:${string}`) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu(null);
    setSidebarSurfaceCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setOpenSortMenu(null);
    setSectionCtxMenu({ x: event.clientX, y: event.clientY, section });
  }, []);
  // Stryker restore all

  const openSidebarSurfaceCtxMenu = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select, [role='menuitem']")) return;
    event.preventDefault();
    setCtxMenu(null);
    setSectionCtxMenu(null);
    setMoveToSectionMenuOpen(false);
    setMoveToSectionMenuPosition(null);
    setOpenSortMenu(null);
    setSidebarSurfaceCtxMenu({ x: event.clientX, y: event.clientY });
  }, []);

  // Stryker disable all: pre-existing context-menu placement is outside the workspace mutation corpus.
  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const menuEl = ctxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: ctxMenu.x,
      y: ctxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === ctxMenu.x && next.y === ctxMenu.y) return;
    setCtxMenu((current) => {
      if (!current || current.type !== ctxMenu.type || current.id !== ctxMenu.id) return current;
      if (current.x !== ctxMenu.x || current.y !== ctxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [ctxMenu]);
  // Stryker restore all

  // Stryker disable all: section-menu placement reuses the pure, separately tested context-menu geometry and is verified in the browser proof.
  useLayoutEffect(() => {
    if (!sectionCtxMenu) return;
    const menuEl = sectionCtxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: sectionCtxMenu.x,
      y: sectionCtxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === sectionCtxMenu.x && next.y === sectionCtxMenu.y) return;
    setSectionCtxMenu((current) => {
      if (!current || current.section !== sectionCtxMenu.section) return current;
      if (current.x !== sectionCtxMenu.x || current.y !== sectionCtxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [sectionCtxMenu]);
  // Stryker restore all

  useLayoutEffect(() => {
    if (!sidebarSurfaceCtxMenu) return;
    const menuEl = sidebarSurfaceCtxMenuRef.current;
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const next = placeSidebarContextMenu({
      x: sidebarSurfaceCtxMenu.x,
      y: sidebarSurfaceCtxMenu.y,
      menuWidth: rect.width,
      menuHeight: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (next.x === sidebarSurfaceCtxMenu.x && next.y === sidebarSurfaceCtxMenu.y) return;
    setSidebarSurfaceCtxMenu((current) => {
      if (!current) return current;
      if (current.x !== sidebarSurfaceCtxMenu.x || current.y !== sidebarSurfaceCtxMenu.y) return current;
      return { ...current, ...next };
    });
  }, [sidebarSurfaceCtxMenu]);

  return {
    makeLongPressHandlers, handleSelectChannel, handleSelectDm, openComputerId, handleSelectAgentDm,
    handleSelectLounge, handleSelectMachine, openCtxMenu, openSectionCtxMenu, openSidebarSurfaceCtxMenu,
  };
}

export type SidebarRowHandlers = ReturnType<typeof useSidebarRowHandlers>;

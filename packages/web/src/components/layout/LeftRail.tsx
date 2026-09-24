import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isHostShell } from "../../embed";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Bookmark,
  BookOpenText,
  CheckSquare,
  CircleHelp,
  MessageSquare,
  Monitor,
  Network,
  Search,
  Settings,
  SquareSplitHorizontal,
  Users,
  UsersRound,
  Smartphone,
} from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { useMessageStore } from "../../store/messageStore";
import { useInboxStore } from "../../store/inboxStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "../../store/events/notificationPrefsEvents";
import api from "../../api/client";
import { useRailMode } from "../../hooks/useSidebarTab";
import { trackActivityOpen } from "../../analytics/activity";
import { hasOtherServerActivityUnread, parseServerUnreadSummaryRows } from "../../utils/serverUnreadSummary";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import { countMachinesNeedingAttention } from "../../utils/computerUpgradeIndicator";
import AttentionDot from "../ui/AttentionDot";
import { AvatarImageWithFallback } from "../ui/AvatarSlot";
import MenuItem from "../ui/MenuItem";
import SectionEyebrow from "../ui/SectionEyebrow";
import ServerSwitcherMenu from "../ui/ServerSwitcherMenu";
import Spinner from "../ui/Spinner";
import Tooltip from "../ui/Tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "raft-ui";
import NotificationTrigger from "./NotificationTrigger";
import {
  useWorkspaceGridNavigationStore,
} from "../workspace/workspaceGridNavigationStore";
import type {
  WorkspaceGridRailItem,
  WorkspaceGridRailMode,
  WorkspaceGridRailSide,
} from "../workspace/workspaceGridNavigationStore";
import {
  isWorkspaceRailRightEdge,
  shouldActivateWorkspaceRailDrag,
} from "../workspace/workspaceRailDrag";
import { SEARCH_FOCUS_REQUEST_EVENT } from "../../utils/searchFocusRequest";
import { hasChatAttentionUnread, selectChatAttentionChannelIds } from "../../utils/chatAttentionUnread";
import { useShallow } from "zustand/react/shallow";
import { WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useJoinCommunityFlow } from "../../hooks/useJoinCommunityFlow";
import { markMobileAppSeen, shouldShowMobileAppBadge } from "./mobileAppBadge";
import {
  CHINESE_COMMUNITY_PAGE_PATH,
  DEFAULT_COMMUNITY_SERVER_SLUG,
  shouldShowChineseCommunityEntry,
} from "../../utils/communityServers";

// Narrow vertical rail to the left of the Sidebar. Hosts, top to bottom:
// 1. Server avatar / switcher button (clicking opens a flyout to switch servers)
// 2. Rail mode buttons. Classic mode derives one selection from the URL;
//    Workspace keeps one independent selection per rail side so both Sidebars
//    can stay open around the editor surface.
//
// Rail mode is path-based: /channel/, /dm/, /threads, /tasks, /saved, /search
// are chat; /agent/, /human/, /members are members; /computer/, /computers
// are computers; /settings/, /release-notes are settings. Clicking a rail
// button restores that mode's last-visited path from localStorage memory,
// or falls back to the mode's canonical landing.
//
// Hidden on mobile root inline view: mobile already has its own bottom tab bar
// and the sidebar is the whole main area, so a second vertical rail there would
// just steal width.
interface LeftRailProps {
  hidden?: boolean;
  workspaceModeAvailable?: boolean;
  side?: WorkspaceGridRailSide;
}

export function LeftRail({ hidden, workspaceModeAvailable = false, side = "left" }: LeftRailProps) {
  // Display-language (react-intl) — layout namespace. Rail tab labels feed both
  // raft-ui Tooltip content and `aria-label`, so they must come from the catalog,
  // not literals.
  const { formatMessage } = useIntl();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const server = useServerStore((s) => s.current);
  const isGuest = server?.role === "guest";
  const servers = useServerStore((s) => s.servers);
  // Public discovery rows retain their gray row-level unread marker, but only
  // joined channels and DMs participate in the global pink Chat attention dot.
  // Keep the channel-id projection shallow so high-frequency channel activity
  // updates do not churn this rail subscription.
  const chatAttentionChannelIds = useChannelStore(useShallow((s) =>
    selectChatAttentionChannelIds(s.channels, s.dmChannels),
  ));
  const hasLocalChatUnread = useMessageStore((s) =>
    hasChatAttentionUnread(chatAttentionChannelIds, s.unreadCounts),
  );
  // Current-server Activity still needs the local boolean projection for the
  // immediate inbox transition before the cross-server summary poll lands.
  const hasActiveInboxUnread = useInboxStore((s) => s.activeUnreadCount > 0);
  const [computerAttentionCount, machineCount] = useMachineStore(useShallow((s) => [
    countMachinesNeedingAttention(s.machines, s.latestDaemonVersion),
    s.machines.length,
  ] as const));
  const computerAttentionTooltip = computerAttentionCount > 0
    ? formatMessage(
        { id: "layout.leftRail.computersNeedAttentionSummary" },
        { count: computerAttentionCount, total: machineCount },
      )
    : undefined;
  const { railMode, selectRailMode } = useRailMode();
  const workspaceEnabled = useWorkspaceGridNavigationStore((s) => s.active);
  const workspacePreferenceEnabled = useWorkspaceGridNavigationStore((s) => s.enabled);
  const workspaceSidebar = useWorkspaceGridNavigationStore((s) => s.sidebars[side]);
  const workspaceSettingsModalOpen = useWorkspaceGridNavigationStore((s) => s.settingsModalOpen);
  const workspaceSettingsModalSide = useWorkspaceGridNavigationStore((s) => s.settingsModalSide);
  const workspaceRailLayout = useWorkspaceGridNavigationStore((s) => s.railLayout);
  const workspaceRailDrag = useWorkspaceGridNavigationStore((s) => s.railDrag);
  const setWorkspacePreferenceEnabled = useWorkspaceGridNavigationStore((s) => s.setEnabled);
  const setWorkspaceRailMode = useWorkspaceGridNavigationStore((s) => s.setRailMode);
  const setWorkspaceSidebarCollapsed = useWorkspaceGridNavigationStore((s) => s.setSidebarCollapsed);
  const moveWorkspaceRailItem = useWorkspaceGridNavigationStore((s) => s.moveRailItem);
  const setWorkspaceRailDrag = useWorkspaceGridNavigationStore((s) => s.setRailDrag);
  const openWorkspaceSettingsModal = useWorkspaceGridNavigationStore((s) => s.openSettingsModal);

  const [showServerMenu, setShowServerMenu] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [serverUnreadCounts, setServerUnreadCounts] = useState<Record<string, ServerUnreadSummary>>({});
  const suppressRailClickRef = useRef(false);

  // One-shot "there is a mobile app now" dot. Read from storage rather than
  // held in a store: it is per user and per device by construction (see
  // mobileAppBadge.ts), and `currentUserId` arrives after the first render on a
  // cold load, so the initial value has to be recomputed once it lands.
  //
  // Initialised lazily, and the effect below is a genuine no-op on mount.
  // Both halves are load-bearing against `leftRailActivityDotSubscription`,
  // which budgets the rail's commits:
  //   - `useState(false)` + effect  → the effect commits on every mount
  //   - identity-guarded setState   → still commits; a bailed-out setState is
  //                                   not a free one
  // Only skipping the call entirely is free. The effect still has to exist,
  // because on a cold load the auth store hydrates after the rail mounts — the
  // lazy value would then be computed with no user and the dot would never
  // appear for that session.
  const [showMobileAppBadge, setShowMobileAppBadge] = useState(
    () => shouldShowMobileAppBadge(currentUserId),
  );
  const badgeUserIdRef = useRef(currentUserId);
  useEffect(() => {
    if (badgeUserIdRef.current === currentUserId) return;
    badgeUserIdRef.current = currentUserId;
    setShowMobileAppBadge(shouldShowMobileAppBadge(currentUserId));
  }, [currentUserId]);
  const dismissMobileAppBadge = () => {
    markMobileAppSeen(currentUserId);
    setShowMobileAppBadge(false);
  };

  const _pathBase = useMemo(() => (server ? `/s/${server.slug}` : ""), [server]);

  useEffect(() => {
    if (side !== "left") return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get("/servers/unread-summary");
        if (cancelled) return;
        setServerUnreadCounts(parseServerUnreadSummaryRows(data));
      } catch {
        // best-effort badge; ignore failures
      }
    };
    const handleNotificationPrefsUpdated = () => {
      void load();
    };
    void load();
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    };
    // Refresh the cross-server unread summary when local unread *appears or
    // clears* (flip), not on every inbound message. Local per-message churn was
    // never a precise signal for other servers' badges anyway — this is the same
    // best-effort trigger, minus the redundant per-message refetches.
  }, [hasLocalChatUnread, side]);

  const hasOtherServerUnread = useMemo(
    () => hasOtherServerActivityUnread(servers, server, serverUnreadCounts),
    [servers, server, serverUnreadCounts],
  );
  const currentServerActivityCount = server?.id
    ? serverUnreadCounts[server.id]?.activityUnreadCount
    : undefined;
  const hasActivityUnread = hasActiveInboxUnread || (currentServerActivityCount !== undefined && currentServerActivityCount > 0);
  // Chat dot tracks unread in joined channels and DMs; Activity dot tracks
  // the server-authoritative Activity count independently of the selected
  // Activity filter.
  // Before Activity earned its own rail
  // entry (stdrc #proj-activity:171042a3 6/20) the Chat dot summed both
  // signals so the user wouldn't miss inbox-only items; with Activity now
  // visible on the rail, the Chat dot returns to its narrower meaning.
  const hasChatUnread = hasLocalChatUnread;
  const wikiEnabled = useServerFeatureFlag(WIKI_FEATURE_FLAG_KEY).enabled;

  const selectWorkspaceView = (mode: NonNullable<WorkspaceGridRailMode>) => {
    const leavingWiki = railMode === "wiki";
    if (leavingWiki) selectRailMode("chat");
    if (!leavingWiki && workspaceSidebar.activeItem === mode && !workspaceSidebar.collapsed) {
      setWorkspaceSidebarCollapsed(true, currentUserId, side);
      return;
    }
    setWorkspaceRailMode(mode, side, currentUserId);
    setWorkspaceSidebarCollapsed(false, currentUserId, side);
    if (mode === "search") {
      requestAnimationFrame(() => document.dispatchEvent(new Event(SEARCH_FOCUS_REQUEST_EVENT)));
    }
  };

  const rawWorkspaceItems = workspaceRailLayout[side];
  const workspaceItems = rawWorkspaceItems.filter((item) => (
    (item !== "wiki" || wikiEnabled)
    && (!isGuest || (item !== "members" && item !== "humans" && item !== "computers"))
  ));
  const workspaceDropIndex = workspaceRailDrag?.targetSide === side
    ? workspaceRailDrag.targetIndex
    : null;
  const visibleWorkspaceDropIndex = workspaceDropIndex === null
    ? null
    : rawWorkspaceItems
        .slice(0, workspaceDropIndex)
        .filter((item) => (
          (item !== "wiki" || wikiEnabled)
          && (!isGuest || (item !== "members" && item !== "humans" && item !== "computers"))
        ))
        .length;

  const resolveRailTarget = (pointerX: number, pointerY: number) => {
    if (isWorkspaceRailRightEdge(pointerX, window.innerWidth)) {
      return { side: "right" as const, index: workspaceRailLayout.right.length };
    }
    const elements = document.elementsFromPoint(pointerX, pointerY) as HTMLElement[];
    const rail = elements.find((element) => element.dataset.workspaceRailSide === "left" || element.dataset.workspaceRailSide === "right");
    if (!rail) return null;
    const targetSide = rail.dataset.workspaceRailSide as WorkspaceGridRailSide;
    const slot = elements.find((element) => element.dataset.workspaceRailIndex !== undefined);
    if (slot && slot.dataset.workspaceRailSide === targetSide) {
      const index = Number(slot.dataset.workspaceRailIndex);
      const rect = slot.getBoundingClientRect();
      return { side: targetSide, index: pointerY > rect.top + rect.height / 2 ? index + 1 : index };
    }
    const slots = [...rail.querySelectorAll<HTMLElement>("[data-workspace-rail-index]")];
    const nextSlot = slots.find((candidate) => pointerY < candidate.getBoundingClientRect().top + candidate.getBoundingClientRect().height / 2);
    return {
      side: targetSide,
      index: nextSlot ? Number(nextSlot.dataset.workspaceRailIndex) : workspaceRailLayout[targetSide].length,
    };
  };

  const startRailPointerDrag = (event: React.PointerEvent<HTMLButtonElement>, item: WorkspaceGridRailItem) => {
    if (!workspaceEnabled || event.button !== 0) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let activated = false;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      document.documentElement.style.removeProperty("--workspace-rail-drag-x");
      document.documentElement.style.removeProperty("--workspace-rail-drag-y");
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    const finish = (commit: boolean) => {
      const drag = useWorkspaceGridNavigationStore.getState().railDrag;
      if (commit && drag?.targetSide && drag.targetIndex !== null) {
        moveWorkspaceRailItem(drag.item, drag.targetSide, drag.targetIndex, currentUserId);
      }
      setWorkspaceRailDrag(null);
      cleanup();
      requestAnimationFrame(() => {
        suppressRailClickRef.current = false;
      });
    };
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!activated && !shouldActivateWorkspaceRailDrag(startX, startY, pointerEvent.clientX, pointerEvent.clientY)) return;
      if (!activated) {
        activated = true;
        suppressRailClickRef.current = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      pointerEvent.preventDefault();
      document.documentElement.style.setProperty("--workspace-rail-drag-x", `${pointerEvent.clientX}px`);
      document.documentElement.style.setProperty("--workspace-rail-drag-y", `${pointerEvent.clientY}px`);
      const target = resolveRailTarget(pointerEvent.clientX, pointerEvent.clientY);
      const current = useWorkspaceGridNavigationStore.getState().railDrag;
      if (current?.targetSide === (target?.side ?? null) && current.targetIndex === (target?.index ?? null)) return;
      setWorkspaceRailDrag({
        item,
        sourceSide: side,
        pointerX: pointerEvent.clientX,
        pointerY: pointerEvent.clientY,
        targetSide: target?.side ?? null,
        targetIndex: target?.index ?? null,
      });
    };
    const handlePointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (activated) pointerEvent.preventDefault();
      finish(activated);
    };
    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      finish(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  };

  const renderWorkspaceRailButton = (item: WorkspaceGridRailItem) => {
    const active = !workspaceSidebar.collapsed && workspaceSidebar.activeItem === item;
    const common = {
      active,
      compact: true,
      testId: `${side === "left" ? "left" : "right"}-rail-tab-${item}`,
      tooltipSide: side === "left" ? "right" as const : "left" as const,
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => startRailPointerDrag(event, item),
      suppressClickRef: suppressRailClickRef,
    };
    if (item === "search") {
      return <RailTabButton {...common} icon={<Search size={18} />} label={formatMessage({ id: "layout.leftRail.tabSearch" })} onClick={() => selectWorkspaceView("search")} />;
    }
    if (item === "chat") {
      return (
        <RailTabButton
          {...common}
          icon={<MessageSquare size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabChat" })}
          showDot={hasChatUnread}
          dotInactiveOnly
          onClick={() => selectWorkspaceView("chat")}
        />
      );
    }
    if (item === "activity") {
      return (
        <RailTabButton
          {...common}
          icon={<Activity size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabActivity" })}
          showDot={hasActivityUnread}
          dotInactiveOnly
          onClick={(event) => {
            if (event.detail >= 2) return;
            trackActivityOpen("rail");
            selectWorkspaceView("activity");
          }}
          onDoubleClick={() => {
            useInboxStore.getState().setPendingFocusKind("first-unread");
            void useInboxStore.getState().loadInbox({ reset: true });
          }}
        />
      );
    }
    if (item === "tasks") {
      return <RailTabButton {...common} icon={<CheckSquare size={18} />} label={formatMessage({ id: "layout.leftRail.tabTasks" })} onClick={() => selectWorkspaceView("tasks")} />;
    }
    if (item === "wiki") {
      return (
        <RailTabButton
          {...common}
          active={railMode === "wiki"}
          onPointerDown={undefined}
          icon={<Network size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabWiki" })}
          onClick={() => selectRailMode("wiki")}
        />
      );
    }
    if (item === "saved") {
      return <RailTabButton {...common} icon={<Bookmark size={18} />} label={formatMessage({ id: "layout.leftRail.tabSaved" })} onClick={() => selectWorkspaceView("saved")} />;
    }
    if (item === "members") {
      return <RailTabButton {...common} icon={<Users size={18} />} label={formatMessage({ id: "layout.leftRail.tabMembers" })} onClick={() => selectWorkspaceView("members")} />;
    }
    if (item === "computers") {
      return (
        <RailTabButton
          {...common}
          icon={<Monitor size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabComputers" })}
          showDot={computerAttentionCount > 0}
          dotInactiveOnly
          dotTooltip={computerAttentionTooltip}
          onClick={() => selectWorkspaceView("computers")}
        />
      );
    }
    return <RailTabButton {...common} icon={<Users size={18} />} label={formatMessage({ id: "layout.leftRail.tabHumans" })} onClick={() => selectWorkspaceView("humans")} />;
  };

  // Outside-click + ESC dismissal lives inside <ServerSwitcherMenu>; the
  // trigger button below uses `onMouseDown={(e) => e.stopPropagation()}` so
  // toggling the menu doesn't re-fire the document mousedown listener and
  // close the just-opened menu.

  const serverInitial = (server?.name || "S").trim().charAt(0).toUpperCase() || "S";

  if (hidden) return null;
  if (side === "right" && !workspaceEnabled) return null;
  if (side === "right" && workspaceItems.length === 0 && workspaceRailDrag?.targetSide !== "right") {
    return (
      <div className="relative hidden h-full w-0 shrink-0 md:block">
        <div
          className={`absolute right-0 top-0 z-20 h-full w-6 ${workspaceRailDrag ? "pointer-events-auto" : "pointer-events-none"}`}
          data-workspace-rail-side="right"
          data-testid="workspace-secondary-rail-drop-edge"
        />
      </div>
    );
  }

  // HOST-SHELL EMBED: the native WebView owns its chrome; this rail is global app
  // navigation and must not render inside it.
  //
  // Placed AFTER the hooks, not before: an early return ahead of them calls hooks
  // conditionally and breaks the Rules of Hooks (oxlint react-doctor caught exactly
  // that on my first attempt). It is still on the RENDER PATH — the very first frame
  // already returns null — so there is no flash. An effect would paint the rail on
  // frame 1 and delete it on frame 2, which the user sees and no "final DOM"
  // assertion can catch.
  if (isHostShell()) return null;

  return (
    <>
      <div
        className={`relative hidden md:flex h-full shrink-0 flex-col items-center bg-soft-signal select-none pb-2 ${workspaceEnabled ? "w-12" : "w-[64px] [@media(max-height:600px)]:w-[50px]"} ${workspaceEnabled ? (side === "left" ? "border-r border-black/25" : "border-l border-black/25") : "border-r-2 border-black"} ${workspaceRailDrag?.targetSide === side ? "outline outline-1 outline-black/35 -outline-offset-1" : ""}`}
        data-workspace-rail-side={side}
        data-testid={`workspace-${side}-rail`}
      >
      {/* Server switcher (top) */}
      {side === "left" ? <div className={`relative flex w-full items-center justify-center ${workspaceEnabled ? "h-12 border-b border-black/25" : "h-panel-header border-b-2 border-black"}`}>
        <Tooltip
          content={server?.name || formatMessage({ id: "layout.leftRail.serverFallbackName" })}
          contentProps={{ side: "right", className: "bg-white" }}
        >
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setShowHelpMenu(false);
              setShowServerMenu((s) => !s);
            }}
            aria-label={formatMessage(
              { id: "layout.leftRail.switchServerAria" },
              { serverName: server?.name || formatMessage({ id: "layout.leftRail.serverFallbackName" }) },
            )}
            // Server-name button matches RailTabButton geometry: h-10 (40)
            // on tall viewports for visual weight, h-9 (36) on short to fit
            // the compact 48px h-panel-header. stdrc 2026-05-02
            // #proj-uiux:8e7df837 task #98 followup 54fbf722: "server name
            // 按钮怎么没修？" — keep server-initial in step with the rail
            // tabs, not pinned at size-icon-header (36 across all viewports).
            className={`relative inline-flex items-center justify-center border-2 border-black bg-black font-display font-bold text-soft-signal transition-all duration-100 ${workspaceEnabled ? "size-9 text-sm shadow-brutal-active hover:shadow-brutal-sm" : "size-10 text-base shadow-brutal-sm hover:shadow-brutal [@media(max-height:600px)]:h-9 [@media(max-height:600px)]:w-9"}`}
          >
            {hasOtherServerUnread && (
              <AttentionDot
                size="lg"
                // Must outrank the avatar image (`AvatarImageWithFallback` gives
                // its img `relative z-[1]`); without an explicit level the dot
                // is a z-auto positioned element and paints UNDER the image.
                className="absolute -right-1 -top-1 z-[2]"
                aria-hidden="true"
              />
            )}
            <AvatarImageWithFallback src={server?.avatarUrl} fallback={serverInitial} />
          </button>
        </Tooltip>

        <ServerSwitcherMenu
          open={showServerMenu}
          onClose={() => setShowServerMenu(false)}
          serverUnreadCounts={serverUnreadCounts}
          testId="desktop-server-switcher-menu"
          className="absolute left-full top-1 ml-2 w-64 max-h-[calc(100dvh-16px)]"
        />
      </div> : null}

      {/* Rail buttons (middle). Mutually-exclusive — at most one is
          highlighted at a time. Workspace keeps the URL stable while its
          Tasks overlay temporarily owns the active rail highlight. */}
      <div className="relative flex flex-1 flex-col items-center gap-1.5 py-2 w-full">
        {workspaceEnabled && visibleWorkspaceDropIndex !== null ? (
          <div
            className="pointer-events-none absolute left-0 right-0 top-2 z-10 h-0.5 bg-[rgb(0_150_190/0.55)] transition-transform duration-100 ease-out"
            style={{ transform: `translateY(calc(${visibleWorkspaceDropIndex} * 2.375rem - 0.25rem))` }}
            data-testid="workspace-rail-drop-indicator"
          />
        ) : null}
        {workspaceEnabled ? workspaceItems.map((item) => (
          <AnimatedRailSlot
            key={item}
            item={item}
            side={side}
            dropIndex={workspaceRailLayout[side].indexOf(item)}
          >
            {workspaceRailDrag?.item === item ? (
              <div
                className="size-8 border border-dashed border-black/55 bg-black/[0.06] transition-[opacity,transform] duration-100 ease-out"
                data-testid="workspace-rail-drop-placeholder"
              />
            ) : renderWorkspaceRailButton(item)}
          </AnimatedRailSlot>
        )) : (
          <>
            <RailTabButton icon={<Search size={18} />} label={formatMessage({ id: "layout.leftRail.tabSearch" })} active={railMode === "search"} onClick={() => selectRailMode("search")} testId="left-rail-tab-search" />
            <RailTabButton icon={<MessageSquare size={18} />} label={formatMessage({ id: "layout.leftRail.tabChat" })} active={railMode === "chat"} showDot={hasChatUnread} dotInactiveOnly onClick={() => selectRailMode("chat")} testId="left-rail-tab-chat" />
            <RailTabButton
              icon={<Activity size={18} />}
              label={formatMessage({ id: "layout.leftRail.tabActivity" })}
              active={railMode === "activity"}
              showDot={hasActivityUnread}
              dotInactiveOnly
              onClick={(event) => {
                if (event.detail >= 2) return;
                trackActivityOpen("rail");
                selectRailMode("activity");
              }}
              onDoubleClick={() => {
                useInboxStore.getState().setPendingFocusKind("first-unread");
                void useInboxStore.getState().loadInbox({ reset: true });
              }}
              testId="left-rail-tab-activity"
            />
            <RailTabButton icon={<CheckSquare size={18} />} label={formatMessage({ id: "layout.leftRail.tabTasks" })} active={railMode === "tasks"} onClick={() => selectRailMode("tasks")} testId="left-rail-tab-tasks" />
            {wikiEnabled && <RailTabButton icon={<Network size={18} />} label={formatMessage({ id: "layout.leftRail.tabWiki" })} active={railMode === "wiki"} onClick={() => selectRailMode("wiki")} testId="left-rail-tab-wiki" />}
            {!isGuest && <RailTabButton icon={<Users size={18} />} label={formatMessage({ id: "layout.leftRail.tabMembers" })} active={railMode === "members"} onClick={() => selectRailMode("members")} testId="left-rail-tab-members" />}
            {!isGuest && <RailTabButton
              icon={<Monitor size={18} />}
              label={formatMessage({ id: "layout.leftRail.tabComputers" })}
              active={railMode === "computers"}
              showDot={computerAttentionCount > 0}
              dotInactiveOnly
              dotTooltip={computerAttentionTooltip}
              onClick={() => selectRailMode("computers")}
              testId="left-rail-tab-computers"
            />}
          </>
        )}
        {workspaceEnabled ? (
          <div className="relative min-h-2 flex-1 w-full">
          </div>
        ) : null}
      </div>

      {/* Notification Center trigger — the permanent Bell sits above Help.
          Its pink dot is conditional, but the entry point and empty-state
          drawer remain available even with zero notifications. Originating direction:
          stdrc 2026-05-02 #proj-uiux:f87f6eb9 (task #94 "the top warning bar
          covers itself; collect everything into a popup hung off Settings").
          The popup floats to the right of the rail. */}
      {side === "left" ? <NotificationTrigger flavor="rail-bottom" /> : null}

      {side === "left" ? (
        <Popover open={showHelpMenu} onOpenChange={setShowHelpMenu}>
          <div className="relative flex h-11 w-full items-center justify-center">
            <PopoverTrigger
              openOnHover
              delay={0}
              closeDelay={120}
              render={(
                <RailTabButton
                  icon={<CircleHelp size={18} />}
                  label={formatMessage({ id: "layout.leftRail.tabHelp" })}
                  active={showHelpMenu}
                  onClick={() => setShowServerMenu(false)}
                  testId="left-rail-help"
                  ariaHasPopup="menu"
                  ariaExpanded={showHelpMenu}
                  showTooltip={false}
                  showDot={showMobileAppBadge}
                />
              )}
            />
            <HelpMenu
              servers={servers}
              onClose={() => setShowHelpMenu(false)}
              showMobileAppBadge={showMobileAppBadge}
              onMobileAppOpened={dismissMobileAppBadge}
            />
          </div>
        </Popover>
      ) : null}

      {side === "left" && workspaceModeAvailable ? (
        <div className="flex h-11 w-full items-center justify-center">
          <RailTabButton
            icon={<SquareSplitHorizontal size={18} />}
            label={workspaceEnabled ? formatMessage({ id: "layout.leftRail.exitWorkspace" }) : formatMessage({ id: "layout.leftRail.enterWorkspace" })}
            active={workspaceEnabled}
            activeVariant="depressed"
            onClick={() => setWorkspacePreferenceEnabled(!workspacePreferenceEnabled, currentUserId)}
            testId="workspace-mode-toggle"
          />
        </div>
      ) : null}

      {workspaceEnabled ? side === "left" ? (
        <div className="flex h-11 w-full items-center justify-center">
          <RailTabButton
            icon={<Settings size={18} />}
            label={formatMessage({ id: "layout.leftRail.tabSettings" })}
            active={workspaceSettingsModalOpen && workspaceSettingsModalSide === side}
            onClick={() => openWorkspaceSettingsModal(side)}
            testId="workspace-settings-trigger"
          />
        </div>
      ) : null : side === "left" ? (
        <div className="flex h-11 w-full items-center justify-center">
          <RailTabButton icon={<Settings size={18} />} label={formatMessage({ id: "layout.leftRail.tabSettings" })} active={railMode === "settings"} onClick={() => selectRailMode("settings")} testId="left-rail-settings" />
        </div>
      ) : null}
      </div>
      {workspaceRailDrag?.sourceSide === side ? createPortal(
        <div
          className="pointer-events-none fixed z-[200] flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center border border-black/40 bg-white opacity-90"
          style={{ left: "var(--workspace-rail-drag-x)", top: "var(--workspace-rail-drag-y)" }}
          data-testid="workspace-rail-drag-overlay"
        >
          {workspaceRailIcon(workspaceRailDrag.item)}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function workspaceRailIcon(item: WorkspaceGridRailItem) {
  if (item === "search") return <Search size={18} />;
  if (item === "chat") return <MessageSquare size={18} />;
  if (item === "activity") return <Activity size={18} />;
  if (item === "tasks") return <CheckSquare size={18} />;
  if (item === "wiki") return <Network size={18} />;
  if (item === "saved") return <Bookmark size={18} />;
  if (item === "members" || item === "humans") return <Users size={18} />;
  return <Monitor size={18} />;
}

function AnimatedRailSlot({
  children,
  item,
  side,
  dropIndex,
}: {
  children: React.ReactNode;
  item: WorkspaceGridRailItem;
  side: WorkspaceGridRailSide;
  dropIndex: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const previousTopRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const nextTop = element.getBoundingClientRect().top;
    const previousTop = previousTopRef.current;
    previousTopRef.current = nextTop;
    if (previousTop === null || previousTop === nextTop || typeof element.animate !== "function") return;
    element.animate(
      [{ transform: `translateY(${previousTop - nextTop}px)` }, { transform: "translateY(0)" }],
      { duration: 120, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  });
  return (
    <div
      ref={ref}
      className="relative"
      data-workspace-rail-side={side}
      data-workspace-rail-index={dropIndex >= 0 ? dropIndex : undefined}
      data-workspace-rail-item={item}
    >
      {children}
    </div>
  );
}

function HelpMenu({
  servers,
  onClose,
  showMobileAppBadge,
  onMobileAppOpened,
}: {
  servers: Server[];
  onClose: () => void;
  showMobileAppBadge: boolean;
  onMobileAppOpened: () => void;
}) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const serverSlug = useServerStore((state) => state.current?.slug ?? null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: () => {
      onCloseRef.current();
    },
    onError: (_error, _slug, message) => {
      onCloseRef.current();
      // Surfacing via alert matches the existing ServerSwitcherMenu join flow
      // until the app has one shared toast surface for low-frequency failures.
      // eslint-disable-next-line no-alert
      alert(message);
    },
  });

  const openDocumentation = () => {
    onCloseRef.current();
    window.open("https://docs.raft.build", "_blank", "noopener,noreferrer");
  };

  const openFeedback = () => {
    if (!serverSlug) return;
    onCloseRef.current();
    navigate(`/s/${serverSlug}/settings/feedback`);
  };
  const openMobileApp = () => {
    if (!serverSlug) return;
    // Mark seen on open, not on menu-open: the dot is announcing the mobile app,
    // and someone who opened Help to reach Feedback has not been told about it.
    onMobileAppOpened();
    onCloseRef.current();
    navigate(`/s/${serverSlug}/settings/about`);
  };

  const openCommunity = async () => {
    if (shouldShowChineseCommunityEntry()) {
      onCloseRef.current();
      navigate(`${CHINESE_COMMUNITY_PAGE_PATH}?from=help-menu`);
      return;
    }
    const joinedDefault = servers.find((candidate) => candidate.slug === DEFAULT_COMMUNITY_SERVER_SLUG);
    if (joinedDefault) {
      onCloseRef.current();
      navigate(`/s/${joinedDefault.slug}`);
      return;
    }
    const outcome = await communityJoinFlow.joinCommunity(DEFAULT_COMMUNITY_SERVER_SLUG);
    if (outcome.status === "agreement_required") onCloseRef.current();
  };

  return (
    <>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        initialFocus={(openType) => openType === "keyboard"}
        role="menu"
        aria-label={formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
        data-testid="left-rail-help-menu"
        className="w-80 overflow-hidden p-0"
      >
          <div className="flex items-center border-b-2 border-black bg-brutal-cream px-3 py-2">
            <SectionEyebrow>
              {formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
            </SectionEyebrow>
          </div>
          <MenuItem
            icon={<BookOpenText size={14} className="shrink-0" />}
            trailing={<ArrowUpRight size={14} className="shrink-0" />}
            onClick={openDocumentation}
          >
            {formatMessage({ id: "layout.leftRail.helpDocumentation" })}
          </MenuItem>
          {/* Signpost only — the content lives in Settings so there is one host
              to keep current, not two that can drift (@huxijin, #wg-download-mobile). */}
          {serverSlug ? (
            <MenuItem
              icon={<Smartphone size={14} className="shrink-0" />}
              // `lg` is the canonical dot; `sm` is compact-only, for parents
              // that physically cannot fit 10×10. A menu row fits it easily —
              // I reached for `sm` to make it feel less shouty, which is the
              // priority axis the design system explicitly does not have. At
              // 4×4 it rendered as a speck that read as a rendering artefact
              // rather than a signal (@wenyi, preview review).
              trailing={showMobileAppBadge
                ? (
                  <AttentionDot
                    className="shrink-0"
                    aria-hidden="true"
                    data-testid="help-menu-mobile-app-badge"
                  />
                )
                : undefined}
              onClick={openMobileApp}
              data-testid="help-menu-mobile-app"
            >
              {formatMessage({ id: "layout.leftRail.helpMobileApp" })}
            </MenuItem>
          ) : null}
          {serverSlug ? (
            <MenuItem
              icon={<MessageSquare size={14} className="shrink-0" />}
              onClick={openFeedback}
            >
              {formatMessage({ id: "settings.about.feedbackTitle" })}
            </MenuItem>
          ) : null}
          <MenuItem
            icon={communityJoinFlow.joiningCommunitySlug
              ? <Spinner size="sm" aria-hidden="true" />
              : <UsersRound size={14} className="shrink-0" />}
            onClick={() => void openCommunity()}
            disabled={communityJoinFlow.joiningCommunitySlug !== null}
          >
            {communityJoinFlow.joiningCommunitySlug
              ? formatMessage({ id: "layout.leftRail.helpCommunityJoining" })
              : formatMessage({
                  id: shouldShowChineseCommunityEntry()
                    ? "layout.leftRail.helpChineseCommunity"
                    : "layout.leftRail.helpCommunity",
                })}
          </MenuItem>
      </PopoverContent>
      {communityJoinFlow.agreementDialog}
    </>
  );
}

type RailTabButtonProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children" | "onClick" | "onDoubleClick" | "aria-label" | "aria-haspopup" | "aria-expanded"
> & {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  showDot?: boolean;
  dotInactiveOnly?: boolean;
  dotTone?: string;
  dotTooltip?: string;
  tooltipSide?: "left" | "right";
  onClick: (event: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  testId?: string;
  suppressClickRef?: React.MutableRefObject<boolean>;
  buttonRef?: React.Ref<HTMLButtonElement>;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  compact?: boolean;
  activeVariant?: "default" | "depressed";
  showTooltip?: boolean;
};

const RailTabButton = forwardRef<HTMLButtonElement, RailTabButtonProps>(function RailTabButton({
  icon,
  label,
  active,
  showDot,
  dotInactiveOnly,
  dotTone,
  dotTooltip,
  tooltipSide = "right",
  onClick,
  onDoubleClick,
  testId,
  onPointerDown,
  suppressClickRef,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  compact = false,
  activeVariant = "default",
  showTooltip = true,
  className = "",
  ...buttonProps
}, forwardedRef) {
  const dotVisible = Boolean(showDot && (!dotInactiveOnly || !active));
  const button = (
    <button
      {...buttonProps}
      ref={(node) => {
        setReactRef(buttonRef, node);
        setReactRef(forwardedRef, node);
      }}
      type="button"
      onClick={(event) => {
        if (!suppressClickRef?.current) onClick(event);
      }}
      onDoubleClick={onDoubleClick}
      aria-label={label}
      aria-pressed={active}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      data-testid={testId}
      onPointerDown={onPointerDown}
      // RailTabButton size — h-10 (40) on tall viewports for visual weight
      // matching the original brutal aesthetic; shrinks to h-9 (36) on
      // short viewports (max-h:600) to fit the compact 48px h-panel-header
      // and stay aligned with size-icon-header (36) used by main panel
      // header icons. stdrc 2026-05-02 #proj-uiux:8e7df837 task #98:
      // "正常桌面上还是原来的大小比较合适，只在缩窄 rail 和 header 的时候
      // 应该缩按钮".
      className={`relative inline-flex ${compact ? "size-8" : "size-10 [@media(max-height:600px)]:h-9 [@media(max-height:600px)]:w-9"} items-center justify-center border-2 transition-colors ${
        active
          ? activeVariant === "depressed"
            ? "border-black bg-workspace-mode-active shadow-workspace-mode-active"
            : "border-black bg-white shadow-brutal-sm"
          : "border-transparent hover:border-black hover:bg-white"
      } ${className}`}
    >
      <span className="relative inline-flex items-center justify-center">
        {icon}
        {dotVisible && (
          <AttentionDot
            size="lg"
            className="pointer-events-none absolute -right-1 -top-1"
            tone={dotTone}
            aria-hidden="true"
          />
        )}
      </span>
    </button>
  );

  return showTooltip ? (
    <Tooltip
      content={dotVisible && dotTooltip ? dotTooltip : label}
      contentProps={{ side: tooltipSide, className: "bg-white" }}
    >
      {button}
    </Tooltip>
  ) : button;
});

function setReactRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

export default LeftRail;

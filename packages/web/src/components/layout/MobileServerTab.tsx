import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { closestCenter, DndContext, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { Blocks, Monitor, Plus, Settings, UserPlus, Users } from "lucide-react";
import { AvatarBadge, MobileNavLabel, PopoverSeparator, Status } from "@botiverse/raft-ui";
import { ArtifactIcon } from "@botiverse/ricons";
import type { AvatarBadgeOffset } from "@botiverse/raft-ui";
import {
  MobileNavServerItem,
  MobileNavServerPopover,
  MobileNavServerPopoverContent,
  MobileNavServerPopoverDestination,
  MobileNavServerPopoverDestinations,
  MobileNavServerPopoverGroup,
  MobileNavServerPopoverList,
  MobileNavServerPopoverRow,
  MobileNavServerPopoverRowLabel,
  TOUCH_DRAG_HOLD_MS,
  useHoldThenMoveTouchSensor,
} from "@botiverse/raft-ui/wip";
import { trackNavEntrySelected } from "../../analytics/navigation";
import { markComputerAttentionSeenNow } from "../../hooks/useComputerAttentionDot";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { NonTouchPointerSensor, SORTABLE_KEYBOARD_SENSOR_OPTIONS } from "../../lib/dndSensors";
import { tabHomeFor, useMobileNavStore } from "../../store/mobileNavStore";
import type { MobileTabId } from "../../store/mobileNavStore";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { hasOtherServerActivityUnread } from "../../utils/serverUnreadSummary";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import { touchDragRegion } from "../../utils/touchDragRegion";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import { ServerTabRowContent } from "./ServerTabRowContent";
import { dismissLayerProps } from "../ui/dismissLayer";
import { useServerSwitcher } from "../ui/useServerSwitcher";
import { useArtifactsRailShown } from "./artifactsRailEntry";
import { useAppsPageAttention, useComputersPageAttention, useSettingsPageAttention } from "./serverPagesAttention";
import { useShellPending } from "./shellPending";

// Raft DS › Navigation › "The server tab on a phone" (stdrc 2026-10-22, D1a)
// and MobileNav › "The server tab": the tab bar's last slot is the current
// server, its avatar where the other tabs have an icon and its name as the
// label. It took More's place. It is the one tab that opens a popover, not a
// page, so it is never selected; a press and a long press both open it
// (raft-ui MobileNavServerItem). The popover, top to bottom:
//  1. the server list as the Home switcher has it (useServerSwitcher: the same
//     servers in the same dragged order, the same unread rules), scrolling
//     inside the popover; a long press then a move drags a row to reorder,
//     saved to the one order every server list reads;
//  2. the switcher's footer actions, one line each;
//  3. the server's own pages, Artifacts (where the rail has it, guests
//     included: #proj-workspace:#203), Members, Computers, Apps and Settings,
//     in one row of equal buttons, each a pushed page with Back (guests have
//     no Members, Computers or Apps).
// Switching keeps the current tab, and coming back from one of the server's
// pages gives focus back to this tab.

/** The attention pixel's centre on the avatar's top-right corner (DS MobileNav › States). */
const TOP_RIGHT: AvatarBadgeOffset = ["100%", 0];

function serverInitial(server: Pick<Server, "name"> | null | undefined): string {
  return (server?.name ?? "").trim().charAt(0).toUpperCase() || "S";
}

// The system's own long-press menu (Android) would cover the row being held.
function blockSystemMenu(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

function SortableServerTabRow({
  server,
  isCurrent,
  unreadSummary,
  disabled,
  onSelect,
}: {
  server: Server;
  isCurrent: boolean;
  unreadSummary?: ServerUnreadSummary;
  disabled: boolean;
  onSelect: (server: Server) => void;
}) {
  // The whole row is the drag handle: there is no grip here, a finger holds
  // the row and then moves it (raft-ui's hold-then-move touch sensor), and a
  // mouse drags it by 6px. dnd-kit's own attributes are left off: without a
  // keyboard sensor they would only rename the row's role.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: server.id, disabled });
  const press = useRef<{ at: number; touch: boolean } | null>(null);
  const transformValue = CSS.Transform.toString(transform ? { ...transform, x: 0 } : null);
  const style = useMemo(() => ({
    transform: transformValue,
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? "var(--z-index-raised)" : undefined,
  }), [isDragging, transformValue, transition]);

  const sortablePointerDown = listeners?.onPointerDown;
  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    press.current = { at: event.timeStamp, touch: event.pointerType !== "mouse" };
    sortablePointerDown?.(event);
  }, [sortablePointerDown]);
  // A finger that held still and lifted picked the row up without moving it:
  // that is not a press, so it does not switch servers.
  const handleClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const started = press.current;
    press.current = null;
    if (started?.touch && event.timeStamp - started.at >= TOUCH_DRAG_HOLD_MS) return;
    onSelect(server);
  }, [onSelect, server]);

  return (
    <MobileNavServerPopoverRow
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onContextMenu={blockSystemMenu}
      disabled={disabled}
      aria-current={isCurrent ? "true" : undefined}
      data-server-id={server.id}
      data-testid="mobile-server-tab-server"
      className="[-webkit-touch-callout:none] disabled:opacity-60"
    >
      <ServerTabRowContent server={server} isCurrent={isCurrent} unreadSummary={unreadSummary} />
    </MobileNavServerPopoverRow>
  );
}

export function MobileServerTab({ mobileTab }: { mobileTab: MobileTabId | null }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const [open, setOpen] = useState(false);
  const tabRef = useRef<HTMLButtonElement>(null);
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const close = useCallback(() => setOpen(false), []);
  const {
    current: server,
    servers,
    sortableServerIds,
    handleServerDragEnd,
    hostedSwitchPending,
    hostedSwitchError,
    selectServer,
    joinOptions,
    joinCommunity,
    switchOrCreate,
    canInviteHuman,
    inviteHuman,
    dialogs,
  } = useServerSwitcher({ onClose: close, replace: true });
  const dndSensors = useSensors(
    useSensor(NonTouchPointerSensor, { activationConstraint: { distance: 6 } }),
    useHoldThenMoveTouchSensor(),
    useSensor(KeyboardSensor, SORTABLE_KEYBOARD_SENSOR_OPTIONS),
  );
  const computers = useComputersPageAttention();
  const apps = useAppsPageAttention();
  const settings = useSettingsPageAttention();
  const showArtifacts = useArtifactsRailShown(useShellPending());

  // Back from Members, Computers or Settings brings the bar back: the tab
  // that opened them takes focus again.
  const locationKey = useLocation().key;
  // Only on mount: the bar is away while a pushed page is up and mounts again
  // when people come back, on the entry the popover was opened on.
  const mountKey = useRef(locationKey);
  useEffect(() => {
    if (useMobileNavStore.getState().consumeServerTabFocus(mountKey.current)) tabRef.current?.focus();
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    // The slot More had: opening the server tab is still the bar's last entry.
    if (next) trackNavEntrySelected("more", "mobile_tab_bar", false);
    setOpen(next);
  }, []);

  // Switching keeps the tab: Activity in one server goes to Activity in the
  // next, so people go on with the same thing there.
  const tab = mobileTab ?? "chat";
  const handleSelectServer = useCallback((selected: Server) => {
    selectServer(selected, tabHomeFor(tab, `/s/${selected.slug}`));
  }, [selectServer, tab]);

  const openServerPage = useCallback((page: "artifacts" | "members" | "computers" | "apps" | "settings") => {
    trackNavEntrySelected(page, "mobile_more", false);
    useMobileNavStore.getState().requestServerTabFocus(locationKey);
    setOpen(false);
    if (page === "artifacts") nav.toArtifacts();
    else if (page === "members") nav.toMembers();
    else if (page === "computers") {
      // Opening Computers sees every computer's current attention state.
      markComputerAttentionSeenNow();
      nav.toComputers();
    } else if (page === "apps") nav.toApps();
    else nav.toSettings();
  }, [locationKey, nav]);
  const openArtifacts = useCallback(() => openServerPage("artifacts"), [openServerPage]);
  const openMembers = useCallback(() => openServerPage("members"), [openServerPage]);
  const openComputers = useCallback(() => openServerPage("computers"), [openServerPage]);
  const openApps = useCallback(() => openServerPage("apps"), [openServerPage]);
  const openSettings = useCallback(() => openServerPage("settings"), [openServerPage]);
  const handleJoinCommunity = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const option = joinOptions.find((candidate) => candidate.slug === event.currentTarget.dataset.slug);
    if (option) joinCommunity(option.slug);
  }, [joinCommunity, joinOptions]);

  const serverName = server?.name || formatMessage({ id: "layout.sidebar.serverFallbackName" });
  // One mark, one meaning: the avatar's dot is another server's unread items
  // only, as on Home's workspace button. The server's own pages carry their
  // news on their buttons below.
  const otherServerUnread = hasOtherServerActivityUnread(servers, server, serverUnreadCounts);
  const isGuest = server?.role === "guest";

  return (
    <>
      <MobileNavServerPopover open={open} onOpenChange={handleOpenChange}>
        <MobileNavServerItem
          ref={tabRef}
          aria-label={otherServerUnread
            ? formatMessage({ id: "layout.mobileTabBar.serverTabOtherUnread" }, { name: serverName })
            : serverName}
          data-testid="mobile-tab-server"
        >
          <AvatarSlot
            context="compact-list"
            type="server"
            serverAvatarUrl={server?.avatarUrl}
            serverInitial={serverInitial(server)}
            corner={otherServerUnread ? (
              <AvatarBadge
                offset={TOP_RIGHT}
                data-testid="mobile-tab-server-unread-dot"
                render={<Status aria-hidden variant="accent" size="sm" />}
              />
            ) : undefined}
          />
          <MobileNavLabel>{serverName}</MobileNavLabel>
        </MobileNavServerItem>
        <MobileNavServerPopoverContent
          aria-label={formatMessage({ id: "layout.mobileTabBar.serverPopover" })}
          data-testid="mobile-server-tab-popover"
          {...dismissLayerProps}
        >
          {hostedSwitchError ? (
            <div className="shrink-0 p-1 pb-0">
              <Banner intent="warning" density="sm">{hostedSwitchError}</Banner>
            </div>
          ) : null}
          <MobileNavServerPopoverList ref={touchDragRegion} data-testid="mobile-server-tab-list">
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleServerDragEnd}>
              <SortableContext items={sortableServerIds} strategy={verticalListSortingStrategy}>
                {servers.map((candidate) => (
                  <SortableServerTabRow
                    key={candidate.id}
                    server={candidate}
                    isCurrent={candidate.id === server?.id}
                    unreadSummary={serverUnreadCounts[candidate.id]}
                    disabled={hostedSwitchPending}
                    onSelect={handleSelectServer}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </MobileNavServerPopoverList>
          <PopoverSeparator />
          <MobileNavServerPopoverGroup data-testid="mobile-server-tab-actions">
            {joinOptions.map((option) => (
              <MobileNavServerPopoverRow key={option.slug} data-slug={option.slug} onClick={handleJoinCommunity}>
                <Plus />
                <MobileNavServerPopoverRowLabel>{option.label}</MobileNavServerPopoverRowLabel>
              </MobileNavServerPopoverRow>
            ))}
            <MobileNavServerPopoverRow onClick={switchOrCreate}>
              <Plus />
              <MobileNavServerPopoverRowLabel>{formatMessage({ id: "ui.serverSwitcher.switchOrCreate" })}</MobileNavServerPopoverRowLabel>
            </MobileNavServerPopoverRow>
            {canInviteHuman ? (
              <MobileNavServerPopoverRow data-testid="mobile-server-tab-invite" onClick={inviteHuman}>
                <UserPlus />
                <MobileNavServerPopoverRowLabel>{formatMessage({ id: "layout.sidebar.inviteHuman" })}</MobileNavServerPopoverRowLabel>
              </MobileNavServerPopoverRow>
            ) : null}
          </MobileNavServerPopoverGroup>
          <PopoverSeparator />
          {/* The server's own pages, at the very bottom, nearest the tab bar.
              Artifacts comes first, as on the rail, and has the rail's gate:
              the server shows a guest what its guest scope allows. Guests have
              no Members, Computers or Apps; Settings (their account, Sign Out)
              stays theirs. */}
          <MobileNavServerPopoverDestinations
            aria-label={serverName}
            data-testid="mobile-server-tab-pages"
          >
            {showArtifacts ? (
              <MobileNavServerPopoverDestination data-testid="mobile-server-tab-artifacts" onClick={openArtifacts}>
                <ArtifactIcon />
                <span>{formatMessage({ id: "layout.leftRail.tabArtifacts" })}</span>
              </MobileNavServerPopoverDestination>
            ) : null}
            {isGuest ? null : (
              <>
                <MobileNavServerPopoverDestination data-testid="mobile-server-tab-members" onClick={openMembers}>
                  <Users />
                  <span>{formatMessage({ id: "layout.sidebar.headerMembers" })}</span>
                </MobileNavServerPopoverDestination>
                <MobileNavServerPopoverDestination
                  data-testid="mobile-server-tab-computers"
                  aria-label={computers.lit ? computers.label : undefined}
                  onClick={openComputers}
                >
                  <Monitor />
                  <span>{formatMessage({ id: "layout.sidebar.headerComputers" })}</span>
                  {computers.lit ? <Status aria-hidden variant="accent" size="sm" data-testid="computers-attention-dot" /> : null}
                </MobileNavServerPopoverDestination>
                {/* Apps (#proj-apps task #22): its dot is for owners and admins
                    while an App waits for them; never on the server avatar. */}
                <MobileNavServerPopoverDestination
                  data-testid="mobile-server-tab-apps"
                  aria-label={apps.lit ? apps.label : undefined}
                  onClick={openApps}
                >
                  <Blocks />
                  <span>{formatMessage({ id: "apps.page.title" })}</span>
                  {apps.lit ? <Status aria-hidden variant="accent" size="sm" data-testid="apps-attention-dot" /> : null}
                </MobileNavServerPopoverDestination>
              </>
            )}
            <MobileNavServerPopoverDestination
              data-testid="mobile-server-tab-settings"
              aria-label={settings.lit ? settings.label : undefined}
              onClick={openSettings}
            >
              <Settings />
              <span>{formatMessage({ id: "layout.sidebar.headerSettings" })}</span>
              {settings.lit ? <Status aria-hidden variant="accent" size="sm" data-testid="settings-attention-dot" /> : null}
            </MobileNavServerPopoverDestination>
          </MobileNavServerPopoverDestinations>
        </MobileNavServerPopoverContent>
      </MobileNavServerPopover>
      {dialogs}
    </>
  );
}

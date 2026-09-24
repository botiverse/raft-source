import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { Check, GripVertical, Plus } from "lucide-react";
import { Badge } from "raft-ui";
import { useServerStore } from "../../store/serverStore";
import type { CommunityServerSlug, Server } from "../../store/serverStore";
import { serverPersistence } from "../../store/serverPersistenceRegistry";
import { useJoinCommunityFlow } from "../../hooks/useJoinCommunityFlow";
import {
  DEFAULT_COMMUNITY_SERVER_SLUG,
  hasJoinedCommunity,
} from "../../utils/communityServers";
import {
  getServerSwitcherTarget,
  openServerSwitcherAuxClickTarget,
  openServerSwitcherDesktopTarget,
} from "../../utils/serverSwitcherNavigation";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import AvatarSlot from "./AvatarSlot";
import ContextMenuDivider from "./ContextMenuDivider";
import { requestHostedOnboardingServerSwitch } from "../../embed/hostBridge";

/**
 * Shared dropdown content for the "switch server" surfaces. The same menu
 * — a list of joined servers + "Join community" + "Switch or create
 * server" — is reachable from two callsites:
 *
 *  - **Desktop LeftRail** — flyout anchored to the top-left server-initial
 *    button. Positioned `absolute left-full top-1 ml-2`, fixed width.
 *  - **Mobile Sidebar navbar pill** — drop-down anchored under the
 *    ServerName pill on the Chat home tab. Positioned
 *    `absolute top-full left-2 right-2 mt-1`, fluid width.
 *
 * Both used to inline 70+ lines of identical JSX (server list + the two
 * footer buttons) and identical state plumbing (outside-click + ESC). They
 * drifted (LeftRail rendered the current server's own unread badge, mobile
 * Sidebar didn't) — this primitive collapses the duplication and pins the
 * canonical behavior.
 *
 * Trigger button + positioning live at the callsite. The primitive owns:
 *  - The shared card container (`card-brutal z-50 flex flex-col overflow-hidden`)
 *  - The server list with current-server check + per-row unread badge
 *  - Join community actions (global plus Chinese community for Chinese-language browsers)
 *  - The "Switch or create server" button
 *  - Outside-click + ESC dismiss
 *
 * Canonical behavior:
 *  - **Current server row hides its own unread count.** A "this server has
 *    N unread" badge inside this server's own switcher menu is redundant —
 *    you're already here. stdrc decision C 2026-05-14
 *    `#proj-uiux:24e533e3` task #234.
 *  - Selecting another server navigates to that server's last remembered
 *    surface, falling back to `/s/${slug}`; ServerResolver flips `current`
 *    once the route lands. The store is not updated directly, the URL is
 *    the source of truth.
 *
 * Trigger contract: callsite's trigger button must `e.stopPropagation()` on
 * `onMouseDown` so the document mousedown listener inside this primitive
 * doesn't fire on the same tap that toggles `open` and immediately close
 * the just-opened menu.
 */
export interface ServerSwitcherMenuProps {
  open: boolean;
  onClose: () => void;
  /** Positioning + sizing classes added to the outer card. */
  className?: string;
  /** Server unread counts keyed by server id. Fetched at the callsite. */
  serverUnreadCounts: Record<string, ServerUnreadSummary>;
  /** Test id on the outer card. Defaults to `server-switcher-menu`. */
  testId?: string;
  /**
   * Desktop restores the last surface visited in the selected server. Mobile
   * treats a server switch as a root-context change instead: replace the old
   * server entry with the selected server's Home so a later channel Back
   * cannot cross into the previous server.
   */
  navigationMode?: "restore-surface" | "replace-with-home";
}

function SortableServerRow({
  server,
  currentServerId,
  unreadSummary,
  targetHref,
  onSelect,
  onAuxSelect,
}: {
  server: Server;
  currentServerId: string | null;
  unreadSummary?: ServerUnreadSummary;
  targetHref: string;
  onSelect: (server: Server, targetHref: string) => void;
  onAuxSelect: (event: ReactMouseEvent, server: Server, targetHref: string) => void;
}) {
  const intl = useIntl();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: server.id });
  const verticalTransform = transform ? { ...transform, x: 0 } : null;
  const style = {
    transform: CSS.Transform.toString(verticalTransform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const isCurrent = server.id === currentServerId;
  const initial = (server.name || "S").trim().charAt(0).toUpperCase() || "S";
  // Activity's server summary is the cross-surface authority. An absent field
  // is unknown, so do not substitute the broader legacy sidebar count.
  const unread = unreadSummary?.activityUnreadCount;
  const isMuted = unreadSummary?.serverPushMuted === true;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onAuxClick={(event) => onAuxSelect(event, server, targetHref)}
      className="relative flex h-12 w-full items-stretch text-sm font-medium text-black transition-colors hover:bg-soft-signal"
    >
      <a
        href={targetHref}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            if (openServerSwitcherDesktopTarget(server.id)) event.preventDefault();
            return;
          }
          event.preventDefault();
          onSelect(server, targetHref);
        }}
        className={`flex min-w-0 flex-1 items-center gap-2 py-0 pl-3 pr-1 text-left ${
          isCurrent ? "font-bold" : ""
        }`}
      >
        <Check size={14} className={`shrink-0 ${isCurrent ? "opacity-100" : "opacity-0"}`} />
        <AvatarSlot context="surface-list" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={initial} />
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate">{server.name}</div>
          <div className="truncate font-mono text-xs text-black/40">/{server.slug}</div>
        </div>
        {!isCurrent && unread !== undefined && unread > 0 && (
          isMuted ? (
            <span
              className="ml-auto shrink-0 font-mono text-[10px] font-medium leading-none text-black/50"
              title={intl.formatMessage({ id: "ui.serverSwitcher.notificationsMuted" })}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : (
            <Badge variant="accent" uppercase={false} className="ml-auto h-auto min-w-0 shrink-0 justify-center rounded px-1.5 py-0.5 leading-none text-white">
              {unread > 99 ? "99+" : unread}
            </Badge>
          )
        )}
      </a>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "ui.serverSwitcher.reorderServer" }, { name: server.name })}
        {...attributes}
        {...listeners}
        className="flex w-6 shrink-0 touch-none cursor-grab items-center justify-center text-black/45 hover:text-black active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
    </div>
  );
}

export default function ServerSwitcherMenu({
  open,
  onClose,
  className,
  serverUnreadCounts,
  testId = "server-switcher-menu",
  navigationMode = "restore-surface",
}: ServerSwitcherMenuProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const server = useServerStore((s) => s.current);
  const servers = useServerStore((s) => s.servers);
  const updateServerOrder = useServerStore((s) => s.updateServerOrder);
  const [hostedSwitchPending, setHostedSwitchPending] = useState(false);
  const [hostedSwitchError, setHostedSwitchError] = useState("");
  const hostedSwitchTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 500, tolerance: 10 } }),
  );
  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: () => {
      onClose();
    },
    onError: (_error, _slug, message) => {
      onClose();
      // Surfacing via alert matches the other low-frequency
      // sidebar failure modes until we have a shared toast system.
      // eslint-disable-next-line no-alert
      alert(message);
    },
  });

  // Callsites pass `onClose` as an inline arrow, which means a fresh
  // function ref on every parent render. If we depended on `onClose`
  // directly the dismiss effect would detach+reattach the document
  // listeners on every parent render. Park the latest `onClose` in a
  // ref and depend only on `open`. Bugen nit 2 review of PR #1786.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => () => {
    if (hostedSwitchTimeoutRef.current !== null) clearClockTimeout(hostedSwitchTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", onMouseDown);
    // keydown-focus-on-open
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Move focus into the menu on open so a focused background element can't
  // swallow keys meant for it, and so Escape/Tab work immediately. Guarded so
  // we don't steal focus from a menu item that already grabbed it.
  useLayoutEffect(() => {
    if (!open) return;
    const m = menuRef.current;
    if (m && !m.contains(document.activeElement)) m.focus();
  }, [open]);

  const handleSelectServer = useCallback((selected: Server, targetHref: string) => {
    const isCurrent = selected.id === server?.id;
    if (!isCurrent) {
      const outcome = requestHostedOnboardingServerSwitch(selected.id);
      if (outcome === "sent") {
        setHostedSwitchError("");
        setHostedSwitchPending(true);
        hostedSwitchTimeoutRef.current = setClockTimeout(() => {
          hostedSwitchTimeoutRef.current = null;
          setHostedSwitchPending(false);
          setHostedSwitchError(intl.formatMessage({ id: "pages.serverSelector.switchFailed" }));
        }, 5000);
        return;
      }
      if (outcome === "failed") {
        setHostedSwitchError(intl.formatMessage({ id: "pages.serverSelector.switchFailed" }));
        return;
      }
      // Let the URL be the source of truth; ServerResolver will switch the
      // current server after the route changes.
      navigate(targetHref, navigationMode === "replace-with-home" ? { replace: true } : undefined);
    }
    onClose();
  }, [intl, navigate, navigationMode, onClose, server?.id]);

  const handleAuxSelectServer = (event: ReactMouseEvent, selected: Server, targetHref: string) => {
    openServerSwitcherAuxClickTarget(event, selected.id, selected.slug, { targetHref });
  };

  const handleServerDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const oldIndex = servers.findIndex((candidate) => candidate.id === activeId);
    const newIndex = servers.findIndex((candidate) => candidate.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(servers, oldIndex, newIndex).map((candidate) => candidate.id);
    void updateServerOrder(reordered);
  }, [servers, updateServerOrder]);

  if (!open) return null;

  const joinOptions: Array<
    { kind: "community-server"; slug: CommunityServerSlug; label: string }
  > = [];
  if (!hasJoinedCommunity(servers, DEFAULT_COMMUNITY_SERVER_SLUG)) {
    joinOptions.push({ kind: "community-server", slug: DEFAULT_COMMUNITY_SERVER_SLUG, label: intl.formatMessage({ id: "ui.serverSwitcher.joinCommunity" }) });
  }

  const handleJoinCommunity = async (slug: CommunityServerSlug) => {
    await communityJoinFlow.joinCommunity(slug);
  };

  return (
    <div
      ref={menuRef}
      tabIndex={-1}
      data-testid={testId}
      className={`card-brutal z-50 flex flex-col overflow-hidden outline-none ${className ?? ""}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {hostedSwitchError ? (
        <div role="alert" className="m-2 border-2 border-black bg-brutal-orange/20 p-2 text-xs font-bold">
          {hostedSwitchError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleServerDragEnd}>
          <SortableContext items={servers.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {servers.map((s) => (
              <div key={s.id} aria-disabled={hostedSwitchPending || undefined} className={hostedSwitchPending ? "pointer-events-none opacity-60" : ""}>
                <SortableServerRow
                  server={s}
                  currentServerId={server?.id ?? null}
                  unreadSummary={serverUnreadCounts[s.id]}
                  targetHref={navigationMode === "replace-with-home"
                    ? `/s/${s.slug}`
                    : getServerSwitcherTarget(s.slug)}
                  onSelect={handleSelectServer}
                  onAuxSelect={handleAuxSelectServer}
                />
              </div>
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <ContextMenuDivider />

      {/* Community actions sit ABOVE "Switch or create server" — the ordering
          mirrors mobile Sidebar in PR #1234 (task #136). */}
      {joinOptions.map((option) => (
        <button
          key={option.slug}
          onClick={() => {
            void handleJoinCommunity(option.slug);
          }}
          className="flex w-full items-center justify-start gap-2 px-3 py-2 [@media(max-height:600px)]:py-1 text-left text-sm font-bold text-black hover:bg-brutal-pink transition-colors"
        >
          <Plus size={14} />
          <span className="min-w-0 flex-1 text-left">{option.label}</span>
        </button>
      ))}

      {communityJoinFlow.agreementDialog}

      <button
        onClick={() => {
          onClose();
          serverPersistence.clearLastServerSlug();
          navigate("/");
        }}
        className="flex w-full items-center justify-start gap-2 px-3 py-2 [@media(max-height:600px)]:py-1 text-left text-sm font-bold text-black hover:bg-brutal-pink transition-colors"
      >
        <Plus size={14} />
        <span className="min-w-0 flex-1 text-left">{intl.formatMessage({ id: "ui.serverSwitcher.switchOrCreate" })}</span>
      </button>
    </div>
  );
}

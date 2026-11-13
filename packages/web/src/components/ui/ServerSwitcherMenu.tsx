import { useCallback, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { NonTouchPointerSensor, SORTABLE_KEYBOARD_SENSOR_OPTIONS } from "../../lib/dndSensors";
import { ServerSwitcherRowLink } from "./ServerSwitcherRowLink";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useIntl } from "react-intl";
import { GripVertical, Plus, UserPlus } from "lucide-react";
import { PopoverContent, ScrollArea } from "@botiverse/raft-ui";
import { useHoldThenMoveTouchSensor } from "@botiverse/raft-ui/wip";
import type { PopoverContentProps } from "@botiverse/raft-ui";
import Banner from "./Banner";
import type { Server } from "../../store/serverStore";
import {
  getServerSwitcherTarget,
  openServerSwitcherAuxClickTarget,
} from "../../utils/serverSwitcherNavigation";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import { touchDragRegion } from "../../utils/touchDragRegion";
import ContextMenuDivider from "./ContextMenuDivider";
import { useServerSwitcher } from "./useServerSwitcher";
import { dismissLayerProps } from "./dismissLayer";

/**
 * The workspace switcher: the joined workspaces, Join Community, Switch or
 * Create Server and Invite People. One list for every trigger — the desktop
 * rail's workspace block, the web top bar's workspace button and the phone
 * Home pill.
 *
 * It is the content of a raft-ui Popover. Render it inside the caller's
 * `<Popover open onOpenChange>` next to its `<PopoverTrigger>`: the popover
 * owns the trigger toggle, outside presses and Escape, and puts the list in a
 * portal placed against the trigger (or `anchor`), kept on screen and never
 * taller than the space it has, so the list scrolls inside and the footer
 * stays reachable. Opening it never moves the page.
 *
 * Rules:
 *  - The current workspace's row hides its own unread count: you are already
 *    there.
 *  - Selecting another workspace navigates to its last remembered surface,
 *    falling back to `/s/${slug}`; ServerResolver flips `current` once the
 *    route lands. The URL is the source of truth, the store is not updated
 *    directly.
 *
 * Raft Design System › Select (the workspace list): every workspace is the
 * ink tile with yellow initials (AvatarSlot `type="server"`); the workspace
 * you are in carries a trailing ink check and bold name; another
 * workspace's unread is the pink count badge (a muted one the gray mono
 * count); rows are 8px-radius menu items with the yellow-soft highlight.
 */
export interface ServerSwitcherMenuProps
  extends Pick<PopoverContentProps, "anchor" | "side" | "align" | "sideOffset" | "alignOffset"> {
  /** Closes the menu (the caller's Popover state) once an action in it is done. */
  onClose: () => void;
  /** Width classes for the menu. */
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
  const transformValue = CSS.Transform.toString(transform ? { ...transform, x: 0 } : null);
  const style = useMemo(() => ({
    transform: transformValue,
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? "var(--z-index-raised)" : undefined,
  }), [isDragging, transformValue, transition]);
  const isCurrent = server.id === currentServerId;
  const handleAuxClick = useCallback((event: ReactMouseEvent) => onAuxSelect(event, server, targetHref), [onAuxSelect, server, targetHref]);

  // The yellow-soft highlight follows the pointer or KEYBOARD focus only. The
  // popover moves focus into its first row when it opens, so `focus-within`
  // lit that row after every mouse open, as if it were hovered.
  return (
    <div
      ref={setNodeRef}
      style={style}
      onAuxClick={handleAuxClick}
      className="group/server-row relative flex h-12 md:pointer-fine:h-10 w-full items-stretch rounded-chip text-callout font-medium text-foreground transition-colors hover:bg-brand-soft has-[:focus-visible]:bg-brand-soft"
    >
      <ServerSwitcherRowLink server={server} isCurrent={isCurrent} unreadSummary={unreadSummary} targetHref={targetHref} onSelect={onSelect} />
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "ui.serverSwitcher.reorderServer" }, { name: server.name })}
        {...attributes}
        {...listeners}
        className="flex w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-chip text-foreground-hint outline-none group-hover/server-row:text-foreground-muted focus-visible:shadow-focus active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
    </div>
  );
}

// The footer actions are DS menu items: 36 tall, 14/20 500 ink, a 16px ink-2
// icon, the yellow-soft highlight on hover and keyboard focus.
const SWITCHER_ACTION_CLASS = "flex min-h-option w-full items-center justify-start gap-2.5 rounded-chip px-2.5 py-option-inset [@media(max-height:600px)]:min-h-8 [@media(max-height:600px)]:py-1 text-left text-callout font-medium text-foreground outline-none transition-colors hover:bg-brand-soft focus-visible:bg-brand-soft [&>svg]:text-foreground-muted";

function handleAuxSelectServer(event: ReactMouseEvent, selected: Server, targetHref: string) {
  openServerSwitcherAuxClickTarget(event, selected.slug, { targetHref });
}

export default function ServerSwitcherMenu({
  onClose,
  className,
  serverUnreadCounts,
  testId = "server-switcher-menu",
  navigationMode = "restore-surface",
  anchor,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  alignOffset = 0,
}: ServerSwitcherMenuProps) {
  const intl = useIntl();
  const {
    current: server,
    servers,
    sortableServerIds,
    handleServerDragEnd,
    hostedSwitchPending,
    hostedSwitchError,
    selectServer: handleSelectServer,
    joinOptions,
    joinCommunity,
    switchOrCreate,
    canInviteHuman,
    inviteHuman,
    dialogs,
  } = useServerSwitcher({ onClose, replace: navigationMode === "replace-with-home" });
  const dndSensors = useSensors(
    useSensor(NonTouchPointerSensor, { activationConstraint: { distance: 6 } }),
    useHoldThenMoveTouchSensor(),
    useSensor(KeyboardSensor, SORTABLE_KEYBOARD_SENSOR_OPTIONS),
  );

  // The dialogs sit beside the popup, not in it: they outlive the menu, which
  // closes as soon as one of them opens.
  return (
    <>
    <PopoverContent
      anchor={anchor}
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      collisionPadding={8}
      data-testid={testId}
      {...dismissLayerProps}
      className={`flex flex-col p-1 ${className ?? ""}`}
    >
      {hostedSwitchError ? (
        <div className="shrink-0 p-1 pb-1.5">
          <Banner intent="warning" density="sm">
            {hostedSwitchError}
          </Banner>
        </div>
      ) : null}
      <ScrollArea ref={touchDragRegion} overscroll="contain" className="min-h-0 flex-1">
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleServerDragEnd}>
          <SortableContext items={sortableServerIds} strategy={verticalListSortingStrategy}>
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
      </ScrollArea>

      <ContextMenuDivider />

      {/* Community actions sit above Switch or Create Server. */}
      {joinOptions.map((option) => (
        <button
          key={option.slug}
          onClick={() => joinCommunity(option.slug)}
          className={SWITCHER_ACTION_CLASS}
        >
          <Plus size={16} />
          <span className="min-w-0 flex-1 text-left">{option.label}</span>
        </button>
      ))}

      <button
        onClick={switchOrCreate}
        className={SWITCHER_ACTION_CLASS}
      >
        <Plus size={16} />
        <span className="min-w-0 flex-1 text-left">{intl.formatMessage({ id: "ui.serverSwitcher.switchOrCreate" })}</span>
      </button>

      {/* Invite Human sits right under Switch or Create Server
          (useServerSwitcher). */}
      {canInviteHuman ? (
        <button
          data-testid="server-switcher-invite"
          onClick={inviteHuman}
          className={SWITCHER_ACTION_CLASS}
        >
          <UserPlus size={16} />
          <span className="min-w-0 flex-1 text-left">{intl.formatMessage({ id: "layout.sidebar.inviteHuman" })}</span>
        </button>
      ) : null}
    </PopoverContent>
    {dialogs}
    </>
  );
}

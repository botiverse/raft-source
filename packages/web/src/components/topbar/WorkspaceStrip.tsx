// One-click workspace switching in the top bar, shared by the web top bar and
// the desktop title bar.
// - Avatars follow the switcher's own order; the current workspace is marked
//   in place, never moved.
// - How many show is decided by space alone, no fixed cap: the strip fills the
//   bar from the current-name button up to the end of the left region. The
//   rest stay in the menu.
// - Reorder by drag, built on dnd-kit — the same library and order as the
//   switcher menu: activation distance (a click still switches), a floating
//   drag overlay with a faded placeholder, neighbours slide aside, horizontal
//   axis only and clamped to the strip, drop animation, Esc cancels, and
//   keyboard reordering (Space to pick up, arrows to move, Space to drop).

import { useCallback, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Button, TooltipProvider } from "@botiverse/raft-ui";
import AvatarSlot from "../ui/AvatarSlot";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { getServerSwitcherTarget } from "../../utils/serverSwitcherNavigation";
import { STRIP_DRAG_THRESHOLD_PX, reorderAfterDrag, stripItems } from "./workspaceStripLayout";
import { WorkspaceStripButton, workspaceInitial } from "./WorkspaceStripButton";
import { WorkspaceStripCurrentMark } from "./WorkspaceStripCurrentMark";
import { WorkspaceStripSortableAvatar } from "./WorkspaceStripSortableAvatar";

const DND_MODIFIERS = [restrictToHorizontalAxis, restrictToParentElement];
// Space picks up / drops, Esc cancels; Enter stays "switch to this workspace"
// — dnd-kit's default also starts a drag on Enter.
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
};
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: STRIP_DRAG_THRESHOLD_PX } };

type DragId = { id: unknown };

// Logos are <img>, which the browser drags natively by default: pressing and
// moving on one started an image drag that stole the pointer, so image avatars
// could not be reordered. Turn native dragging off and let the button receive
// the events, as dnd-kit's docs recommend.
function preventNativeDrag(event: DragEvent) {
  event.preventDefault();
}

export function WorkspaceStrip({ count: n, shortcutModifier = null, otherUnread = false }: {
  /** How many avatars fit (stripCapacity, decided by the bar): 0 hides the strip. */
  count: number;
  /** Another workspace with no avatar in the strip has unread: the current
   *  workspace's avatar carries that dot. */
  otherUnread?: boolean;
  /** The host's "switch to workspace N" modifier ("⌘", "Ctrl+"): where it is
   *  set, the tooltips show ⌘N / Ctrl+N, drawn by KbdShortcut for the
   *  platform (the host's modifier is the platform's command key). Only the
   *  desktop app has that shortcut; in a browser ⌘1…⌘9 switch browser tabs,
   *  so the web passes nothing. */
  shortcutModifier?: string | null;
}) {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const currentId = useServerStore((s) => s.current?.id ?? null);
  const updateServerOrder = useServerStore((s) => s.updateServerOrder);
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  // A drag that ends over an avatar can be followed by that avatar's click;
  // ignore clicks for the rest of that event turn only (never longer).
  const justDragged = useRef(false);
  // While a drag is live (incl. the Space keyup that picked it up), clicks
  // never switch.
  const dragging = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  const { head, tail } = useMemo(() => {
    const { items, currentOutside } = stripItems(servers, currentId, n);
    // The out-of-range current workspace (last slot, after the divider) is not
    // part of the sortable head: its position in the list isn't the strip's.
    return currentOutside
      ? { head: items.slice(0, -1), tail: items[items.length - 1] ?? null }
      : { head: items, tail: null };
  }, [servers, currentId, n]);
  const headIds = useMemo(() => head.map((s) => s.id), [head]);
  // ⌘1…⌘9 by the switcher's order, one object per workspace, so an avatar's props stay the same between renders.
  const shortcuts = useMemo(() => new Map<string, ShortcutCombo>(
    shortcutModifier ? servers.slice(0, 9).map((server, index) => [server.id, { mod: true, key: String(index + 1) }]) : [],
  ), [servers, shortcutModifier]);
  const active = activeId ? servers.find((s) => s.id === activeId) ?? null : null;

  const onPick = useCallback((server: Server) => {
    if (dragging.current || justDragged.current || server.id === currentId) return;
    navigate(getServerSwitcherTarget(server.slug));
  }, [currentId, navigate]);
  const onDragStart = useCallback((event: DragStartEvent) => {
    dragging.current = true;
    setActiveId(String(event.active.id));
  }, []);
  const finishDrag = useCallback(() => {
    dragging.current = false;
    setActiveId(null);
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
  }, []);
  const onDragEnd = useCallback((event: DragEndEvent) => {
    finishDrag();
    if (!event.over || event.active.id === event.over.id) return;
    const order = servers.map((s) => s.id);
    const from = order.indexOf(String(event.active.id));
    const to = order.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    void updateServerOrder(reorderAfterDrag(order, from, to - from));
  }, [finishDrag, servers, updateServerOrder]);

  const accessibility = useMemo(() => {
    const nameOf = (id: unknown) => servers.find((s) => s.id === String(id))?.name ?? "";
    return {
      screenReaderInstructions: { draggable: formatMessage({ id: "ui.workspaceStrip.dragInstructions" }) },
      announcements: {
        onDragStart: ({ active: dragged }: { active: DragId }) =>
          formatMessage({ id: "ui.workspaceStrip.pickedUp" }, { name: nameOf(dragged.id) }),
        onDragOver: ({ active: dragged, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "ui.workspaceStrip.over" }, { name: nameOf(dragged.id), target: nameOf(over.id) })
          : formatMessage({ id: "ui.workspaceStrip.notOver" }, { name: nameOf(dragged.id) })),
        onDragEnd: ({ active: dragged, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "ui.workspaceStrip.droppedAt" }, { name: nameOf(dragged.id), target: nameOf(over.id) })
          : formatMessage({ id: "ui.workspaceStrip.dropped" }, { name: nameOf(dragged.id) })),
        onDragCancel: ({ active: dragged }: { active: DragId }) =>
          formatMessage({ id: "ui.workspaceStrip.cancelled" }, { name: nameOf(dragged.id) }),
      },
    };
  }, [formatMessage, servers]);

  if (head.length === 0 && !tail) return null;

  const shortcutFor = (server: Server) => shortcuts.get(server.id) ?? null;

  return (
    <TooltipProvider>
      <div
        className="flex shrink-0 items-center gap-1 pl-2 [&_img]:pointer-events-none [&_img]:select-none [&_img]:[-webkit-user-drag:none]"
        data-testid="desktop-workspace-strip"
        role="toolbar"
        aria-label={formatMessage({ id: "ui.workspaceStrip.label" })}
        onDragStart={preventNativeDrag}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={DND_MODIFIERS}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={finishDrag}
          accessibility={accessibility}
        >
          <SortableContext items={headIds} strategy={horizontalListSortingStrategy}>
            <div className="flex items-center gap-1">
              {head.map((server) => (
                <WorkspaceStripSortableAvatar
                  key={server.id}
                  server={server}
                  isCurrent={server.id === currentId}
                  otherUnread={otherUnread}
                  hasUnread={(serverUnreadCounts[server.id]?.activityUnreadCount ?? 0) > 0}
                  shortcut={shortcutFor(server)}
                  sortable={head.length > 1}
                  hideTooltip={activeId !== null}
                  onPick={onPick}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay>
            {active ? (
              <div className="flex scale-110 items-center rounded-sticker shadow-float">
                <Button variant="ghost" size="icon-md" tabIndex={-1} aria-hidden>
                  <AvatarSlot context="creator-link" type="server" serverAvatarUrl={active.avatarUrl} serverInitial={workspaceInitial(active)} />
                </Button>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {tail ? (
          <>
            <span aria-hidden className="h-4 w-px bg-line-seam" />
            <div className="group/ws relative flex items-center" data-workspace-id={tail.id}>
              <WorkspaceStripButton server={tail} isCurrent otherUnread={otherUnread} shortcut={shortcutFor(tail)} hideTooltip={false} onPick={onPick} />
              <WorkspaceStripCurrentMark on />
            </div>
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

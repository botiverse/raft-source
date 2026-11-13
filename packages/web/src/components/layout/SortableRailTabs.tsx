// The rail's navigation tabs (search, chat, activity, …) in the person's own
// order. Drag one to reorder; the order is saved on the account, one order for
// every server. Built like the workspace strip's reordering: a drag starts only
// past a short distance (a click still opens the tab), neighbours slide aside,
// vertical axis only and clamped to the rail, Esc cancels, and keyboard
// reordering (Space to pick up, arrows to move, Space to drop; Enter opens).

import { useCallback, useMemo, useRef } from "react";
import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { normalizeRailTabOrder } from "@botiverse/raft-shared";
import type { RailTabId } from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";

const DND_MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];
// Space picks up / drops, Esc cancels; Enter stays "open this tab" — dnd-kit's
// default also starts a drag on Enter.
const KEYBOARD_SENSOR_OPTIONS = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
};
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };

type DragId = { id: unknown };

/** dnd-kit's attributes and listeners, without the props a rail tab button
 *  sets itself. */
type RailTabDragProps = Omit<
  HTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "onDoubleClick" | "aria-label" | "aria-haspopup" | "aria-expanded" | "aria-pressed" | "aria-roledescription"
>;

export type RailTabDrag = {
  /** dnd-kit's attributes and listeners, for the tab's button. */
  dragProps: RailTabDragProps;
  /** Wraps the tab's click so the click that ends a drag does not open it. */
  guardClick: (onClick: (event: MouseEvent) => void) => (event: MouseEvent) => void;
};

export type RailTab = {
  id: RailTabId;
  label: string;
  render: (drag: RailTabDrag) => ReactNode;
};

export function SortableRailTabs({ tabs }: { tabs: readonly RailTab[] }) {
  const { formatMessage } = useIntl();
  const savedOrder = useAuthStore((s) => s.user?.railTabOrder ?? null);
  const updateRailTabOrder = useAuthStore((s) => s.updateRailTabOrder);
  const fullOrder = useMemo(() => normalizeRailTabOrder(savedOrder), [savedOrder]);
  const orderedTabs = useMemo(() => {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    return fullOrder.flatMap((id) => byId.get(id) ?? []);
  }, [fullOrder, tabs]);
  const ids = useMemo(() => orderedTabs.map((tab) => tab.id), [orderedTabs]);

  // A drag that ends over a tab can be followed by that tab's click; ignore
  // clicks for the rest of that event turn only. While a drag is live (incl.
  // the Space keyup that picked it up), clicks never open a tab.
  const dragging = useRef(false);
  const justDragged = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );
  const onDragStart = useCallback(() => {
    dragging.current = true;
  }, []);
  const finishDrag = useCallback(() => {
    dragging.current = false;
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
  }, []);
  const onDragEnd = useCallback((event: DragEndEvent) => {
    finishDrag();
    if (!event.over || event.active.id === event.over.id) return;
    // Move within the full order, so tabs this person can't see (a guest's
    // Members) keep their place.
    const from = fullOrder.indexOf(event.active.id as RailTabId);
    const to = fullOrder.indexOf(event.over.id as RailTabId);
    if (from < 0 || to < 0) return;
    void updateRailTabOrder(arrayMove(fullOrder, from, to));
  }, [finishDrag, fullOrder, updateRailTabOrder]);
  const guardClick = useCallback((onClick: (event: MouseEvent) => void) => (event: MouseEvent) => {
    if (dragging.current || justDragged.current) return;
    onClick(event);
  }, []);

  const accessibility = useMemo(() => {
    const nameOf = (id: unknown) => tabs.find((tab) => tab.id === id)?.label ?? "";
    return {
      screenReaderInstructions: { draggable: formatMessage({ id: "layout.leftRail.dragInstructions" }) },
      announcements: {
        onDragStart: ({ active }: { active: DragId }) =>
          formatMessage({ id: "layout.leftRail.dragPickedUp" }, { name: nameOf(active.id) }),
        onDragOver: ({ active, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "layout.leftRail.dragOver" }, { name: nameOf(active.id), target: nameOf(over.id) })
          : formatMessage({ id: "layout.leftRail.dragNotOver" }, { name: nameOf(active.id) })),
        onDragEnd: ({ active, over }: { active: DragId; over: DragId | null }) => (over
          ? formatMessage({ id: "layout.leftRail.dragDroppedAt" }, { name: nameOf(active.id), target: nameOf(over.id) })
          : formatMessage({ id: "layout.leftRail.dragDropped" }, { name: nameOf(active.id) })),
        onDragCancel: ({ active }: { active: DragId }) =>
          formatMessage({ id: "layout.leftRail.dragCancelled" }, { name: nameOf(active.id) }),
      },
    };
  }, [formatMessage, tabs]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={DND_MODIFIERS}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={finishDrag}
      accessibility={accessibility}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {orderedTabs.map((tab) => (
          <SortableRailTab key={tab.id} tab={tab} guardClick={guardClick} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRailTab({ tab, guardClick }: { tab: RailTab; guardClick: RailTabDrag["guardClick"] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const dragProps = useMemo<RailTabDragProps>(() => {
    // dnd-kit's attributes carry `aria-pressed` (undefined unless mid-drag).
    // Spread onto the tab it would override AppRailItem's
    // `aria-pressed={selected}`, so the open tab would stop reading as
    // pressed. The tab's own selected state owns aria-pressed.
    // They also carry `aria-roledescription="sortable"`, which makes a
    // screen reader announce each tab as "sortable" instead of a button.
    // The drag instructions still reach it through `aria-describedby`.
    const {
      "aria-pressed": _dragPressed,
      "aria-roledescription": _dragRoleDescription,
      ...dragAttributes
    } = attributes;
    return { ...dragAttributes, ...listeners };
  }, [attributes, listeners]);
  const style = useMemo(() => ({ transform: CSS.Translate.toString(transform), transition }), [transform, transition]);
  // The tab's own content, kept while only the transform changes: dnd-kit renders the dragged tab on every pointer
  // move and each tab on every change of the tab under it; the button underneath renders only when its tab or the
  // drag's props change.
  const content = useMemo(() => tab.render({ dragProps, guardClick }), [dragProps, guardClick, tab]);
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex justify-center ${isDragging ? "z-raised" : ""}`}
      data-rail-tab-id={tab.id}
    >
      {content}
    </div>
  );
}

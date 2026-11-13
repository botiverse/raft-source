import { hasSidebarPinnedRef, removeSidebarPinnedRef, upsertSidebarPinnedRef } from "../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../utils/sidebarPinnedRefs";

export type SidebarSectionItemKind = "channel" | "agent";

export interface SidebarCustomSection {
  id: string;
  name: string;
  emoji: string | null;
  sortMode: "manual" | "recent" | "az";
}

export interface SidebarSectionPlacement {
  kind: SidebarSectionItemKind;
  id: string;
  sectionId: string;
  position: number;
}

export const SIDEBAR_SYSTEM_SECTION_IDS = [
  "system:pinned",
  "system:joint",
  "system:channels",
  "system:dms",
] as const;

export function normalizeSidebarCustomSections(value: unknown): SidebarCustomSection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SidebarCustomSection => {
    if (!item || typeof item !== "object") return false;
    const section = item as Record<string, unknown>;
    return typeof section.id === "string"
      && typeof section.name === "string"
      && (section.emoji === null || typeof section.emoji === "string")
      && (section.sortMode === "manual" || section.sortMode === "recent" || section.sortMode === "az");
  });
}

export function normalizeSidebarSectionPlacements(value: unknown): SidebarSectionPlacement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SidebarSectionPlacement => {
    if (!item || typeof item !== "object") return false;
    const placement = item as Record<string, unknown>;
    return (placement.kind === "channel" || placement.kind === "agent")
      && typeof placement.id === "string"
      && typeof placement.sectionId === "string"
      && typeof placement.position === "number";
  });
}

export function normalizeSidebarSectionOrder(value: unknown, sections: SidebarCustomSection[]): string[] {
  const customIds = new Set(sections.map((section) => section.id));
  const allowedIds = new Set<string>([...SIDEBAR_SYSTEM_SECTION_IDS, ...customIds]);
  const input = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [...input, ...SIDEBAR_SYSTEM_SECTION_IDS, ...sections.map((section) => section.id)]) {
    if (!allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }
  return orderedIds;
}

export function reorderSidebarSectionOrder(order: string[], activeId: string, overId: string): string[] {
  const oldIndex = order.indexOf(activeId);
  const newIndex = order.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return order;
  const next = [...order];
  const [active] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, active);
  return next;
}

export function sidebarSectionItemKey(kind: SidebarSectionItemKind, id: string): string {
  return `${kind}:${id}`;
}

export function moveSidebarItemToCustomSection(
  placements: SidebarSectionPlacement[],
  item: Pick<SidebarSectionPlacement, "kind" | "id">,
  sectionId: string,
): SidebarSectionPlacement[] {
  return moveSidebarItemToCustomSectionAtPosition(
    placements,
    item,
    sectionId,
    Number.POSITIVE_INFINITY,
  );
}

export function moveSidebarItemToCustomSectionAtPosition(
  placements: SidebarSectionPlacement[],
  item: Pick<SidebarSectionPlacement, "kind" | "id">,
  sectionId: string,
  requestedPosition: number,
): SidebarSectionPlacement[] {
  const itemKey = sidebarSectionItemKey(item.kind, item.id);
  const withoutItem = placements.filter((placement) => sidebarSectionItemKey(placement.kind, placement.id) !== itemKey);
  const destination = withoutItem
    .filter((placement) => placement.sectionId === sectionId)
    .sort((a, b) => a.position - b.position);
  const position = Math.max(0, Math.min(Math.trunc(requestedPosition), destination.length));
  destination.splice(position, 0, { ...item, sectionId, position });
  const reindexedDestination = destination.map((placement, index) => ({ ...placement, position: index }));
  return [
    ...withoutItem.filter((placement) => placement.sectionId !== sectionId),
    ...reindexedDestination,
  ];
}

export function removeSidebarItemPlacement(
  placements: SidebarSectionPlacement[],
  item: Pick<SidebarSectionPlacement, "kind" | "id">,
): SidebarSectionPlacement[] {
  const itemKey = sidebarSectionItemKey(item.kind, item.id);
  if (!placements.some((placement) => sidebarSectionItemKey(placement.kind, placement.id) === itemKey)) {
    return placements;
  }
  return placements.filter((placement) => sidebarSectionItemKey(placement.kind, placement.id) !== itemKey);
}

// ---------------------------------------------------------------------------
// Placement moves shared by the sidebar (row menu, drag and drop, section
// dialogs) and channel settings › Move to section. Pinned is the system
// section `system:pinned` (a pinned ref); a custom section is a placement.
// Each returns the sidebar-order fields to write.
// ---------------------------------------------------------------------------

export interface SidebarPlacementState {
  pinned: SidebarPinnedRef[];
  sectionPlacements: SidebarSectionPlacement[];
}

export interface SidebarSectionsState extends SidebarPlacementState {
  customSections: SidebarCustomSection[];
  sectionOrder: string[];
}

type SidebarItem = Pick<SidebarSectionPlacement, "kind" | "id">;

/** Pin the item and take it out of any custom section. */
export function sidebarMoveToPinnedUpdate(state: SidebarPlacementState, item: SidebarItem, ref: SidebarPinnedRef): SidebarPlacementState {
  return {
    sectionPlacements: removeSidebarItemPlacement(state.sectionPlacements, item),
    pinned: hasSidebarPinnedRef(state.pinned, ref) ? state.pinned : upsertSidebarPinnedRef(state.pinned, ref),
  };
}

/** Place the item last in a custom section and unpin it (`ref`, when it can be pinned). */
export function sidebarMoveToCustomSectionUpdate(
  state: SidebarPlacementState,
  item: SidebarItem,
  sectionId: string,
  ref: SidebarPinnedRef | null,
): SidebarPlacementState {
  return {
    sectionPlacements: moveSidebarItemToCustomSection(state.sectionPlacements, item, sectionId),
    pinned: ref ? removeSidebarPinnedRef(state.pinned, ref) : state.pinned,
  };
}

/**
 * Back to the item's home section: drop its placement and its pin, writing
 * only what changes (Remove from Section writes only the placements). Empty
 * when it is already home.
 */
export function sidebarMoveToHomeUpdate(
  state: SidebarPlacementState,
  item: SidebarItem,
  ref: SidebarPinnedRef | null,
): Partial<SidebarPlacementState> {
  const sectionPlacements = removeSidebarItemPlacement(state.sectionPlacements, item);
  return {
    ...(sectionPlacements === state.sectionPlacements ? {} : { sectionPlacements }),
    ...(ref && hasSidebarPinnedRef(state.pinned, ref) ? { pinned: removeSidebarPinnedRef(state.pinned, ref) } : {}),
  };
}

/**
 * Add a custom section, before `insertBefore` (a sectionOrder key) or last,
 * optionally with `moveItem` placed in it and unpinned.
 */
export function sidebarCreateSectionUpdate(
  state: SidebarSectionsState,
  section: SidebarCustomSection,
  { insertBefore, moveItem, moveItemRef = null }: { insertBefore?: string; moveItem?: SidebarItem; moveItemRef?: SidebarPinnedRef | null } = {},
): SidebarSectionsState {
  const { sectionOrder } = state;
  const insertAt = insertBefore ? sectionOrder.indexOf(insertBefore) : -1;
  const nextSectionOrder = insertAt >= 0
    ? [...sectionOrder.slice(0, insertAt), section.id, ...sectionOrder.slice(insertAt)]
    : [...sectionOrder, section.id];
  return {
    customSections: [...state.customSections, section],
    sectionOrder: nextSectionOrder,
    sectionPlacements: moveItem
      ? moveSidebarItemToCustomSection(state.sectionPlacements, moveItem, section.id)
      : state.sectionPlacements,
    pinned: moveItemRef ? removeSidebarPinnedRef(state.pinned, moveItemRef) : state.pinned,
  };
}

/**
 * The section an item is shown in, as a sectionOrder key. Pinned wins over a
 * placement, as the sidebar renders it (a pinned item is skipped in its
 * custom section); a placement in a deleted section counts as home.
 */
export function sidebarItemSectionKey({
  pinned,
  placementSectionId,
  customSections,
  homeKey,
}: {
  pinned: boolean;
  placementSectionId: string | null;
  customSections: SidebarCustomSection[];
  homeKey: string;
}): string {
  if (pinned) return "system:pinned";
  if (placementSectionId && customSections.some((section) => section.id === placementSectionId)) return placementSectionId;
  return homeKey;
}

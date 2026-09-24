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

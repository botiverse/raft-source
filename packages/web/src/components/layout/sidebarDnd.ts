export type SidebarDndContainerKind =
  | "pinned"
  | "custom"
  | "jointChannels"
  | "channels"
  | "dms";

export interface SidebarDndContainerData {
  type: "container";
  containerId: string;
  kind: SidebarDndContainerKind;
  manual: boolean;
}

export interface SidebarDndItemData {
  type: "item";
  containerId: string;
  itemId: string;
}

export type SidebarDndData = SidebarDndContainerData | SidebarDndItemData;
export type SidebarDndProjection = Record<string, string[]>;

const CONTAINER_PREFIX = "sidebar:container:";

export const SIDEBAR_PINNED_CONTAINER_ID = `${CONTAINER_PREFIX}pinned`;
export const SIDEBAR_JOINT_CHANNELS_CONTAINER_ID = `${CONTAINER_PREFIX}joint-channels`;
export const SIDEBAR_CHANNELS_CONTAINER_ID = `${CONTAINER_PREFIX}channels`;
export const SIDEBAR_DMS_CONTAINER_ID = `${CONTAINER_PREFIX}dms`;

export function isSidebarDndData(value: unknown): value is SidebarDndData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<SidebarDndData>;
  if (typeof data.containerId !== "string") return false;
  if (data.type === "container") {
    return typeof data.kind === "string" && typeof data.manual === "boolean";
  }
  return data.type === "item" && typeof data.itemId === "string";
}

export function sidebarCustomContainerId(sectionId: string): string {
  return `${CONTAINER_PREFIX}custom:${sectionId}`;
}

export function sidebarCustomSectionId(containerId: string): string | null {
  const prefix = `${CONTAINER_PREFIX}custom:`;
  return containerId.startsWith(prefix) ? containerId.slice(prefix.length) : null;
}

export function findSidebarDndContainer(
  projection: SidebarDndProjection,
  itemId: string,
): string | null {
  for (const [containerId, itemIds] of Object.entries(projection)) {
    if (itemIds.includes(itemId)) return containerId;
  }
  return null;
}

export function moveSidebarDndItem(
  projection: SidebarDndProjection,
  activeId: string,
  destinationContainerId: string,
  destinationIndex: number,
): SidebarDndProjection {
  const sourceContainerId = findSidebarDndContainer(projection, activeId);
  if (!sourceContainerId || !projection[destinationContainerId]) return projection;

  const sourceItems = projection[sourceContainerId];
  const sourceIndex = sourceItems.indexOf(activeId);
  if (sourceIndex === -1) return projection;

  const nextSourceItems = sourceItems.filter((itemId) => itemId !== activeId);
  const destinationItems = sourceContainerId === destinationContainerId
    ? nextSourceItems
    : projection[destinationContainerId].filter((itemId) => itemId !== activeId);
  const boundedIndex = Math.max(0, Math.min(Math.trunc(destinationIndex), destinationItems.length));

  if (
    sourceContainerId === destinationContainerId
    && sourceIndex === boundedIndex
  ) {
    return projection;
  }

  const nextDestinationItems = [...destinationItems];
  nextDestinationItems.splice(boundedIndex, 0, activeId);

  return {
    ...projection,
    ...(sourceContainerId === destinationContainerId
      ? { [sourceContainerId]: nextDestinationItems }
      : {
          [sourceContainerId]: nextSourceItems,
          [destinationContainerId]: nextDestinationItems,
        }),
  };
}

export function replaceSidebarSubsetOrder(
  fullOrder: string[],
  previousSubset: string[],
  nextSubset: string[],
): string[] {
  const subsetIds = new Set(previousSubset);
  let nextIndex = 0;
  const nextOrder = fullOrder.map((id) => {
    if (!subsetIds.has(id)) return id;
    const replacement = nextSubset[nextIndex];
    nextIndex += 1;
    return replacement ?? id;
  });

  for (; nextIndex < nextSubset.length; nextIndex += 1) {
    nextOrder.push(nextSubset[nextIndex]);
  }
  return nextOrder;
}

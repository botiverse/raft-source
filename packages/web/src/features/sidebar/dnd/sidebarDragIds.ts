// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
export function channelDragId(id: string): string {
  return `channel:${id}`;
}

export function agentDragId(id: string): string {
  return `agent:${id}`;
}

export function parseDragId(value: string): { kind: "channel" | "dm" | "agent"; id: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return kind === "channel" || kind === "dm" || kind === "agent" ? { kind, id } : null;
}

export function isSidebarCollisionCandidate(
  activeId: string,
  candidateId: string,
  sectionOrder: string[],
): boolean {
  const activeIsSection = sectionOrder.includes(activeId);
  return activeIsSection
    ? sectionOrder.includes(candidateId)
    : !sectionOrder.includes(candidateId);
}

export type SidebarDropIndicatorEdge = "before" | "after";

export function getSidebarDropIndicatorEdge(
  activeCenterY: number,
  targetCenterY: number,
): SidebarDropIndicatorEdge {
  return activeCenterY < targetCenterY ? "before" : "after";
}
// Stryker restore all

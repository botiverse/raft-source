export function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

export function reconcileOrderIds<T extends { id: string }>(
  items: T[],
  storedIds: string[],
  pinnedId?: string | null,
): string[] {
  const itemIds = new Set(items.map((item) => item.id));
  const next: string[] = [];

  if (pinnedId && itemIds.has(pinnedId)) next.push(pinnedId);

  for (const id of storedIds) {
    if (id === pinnedId) continue;
    if (itemIds.has(id) && !next.includes(id)) next.push(id);
  }

  for (const item of items) {
    if (item.id === pinnedId) continue;
    if (!next.includes(item.id)) next.push(item.id);
  }

  return next;
}

export function orderByIds<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const itemMap = new Map(items.map((item) => [item.id, item]));
  return orderedIds.map((id) => itemMap.get(id)).filter((item): item is T => !!item);
}

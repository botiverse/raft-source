export type SidebarPinnedKind = "channel" | "agent" | "human";

export interface SidebarPinnedRef {
  kind: SidebarPinnedKind;
  id: string;
}

const VALID_KINDS = new Set<SidebarPinnedKind>(["channel", "agent", "human"]);

export function sidebarPinnedRefKey(ref: SidebarPinnedRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseSidebarPinnedRefKey(key: string): SidebarPinnedRef | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!VALID_KINDS.has(kind as SidebarPinnedKind)) return null;
  return { kind: kind as SidebarPinnedKind, id };
}

function isSidebarPinnedRef(value: unknown): value is SidebarPinnedRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; id?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.kind === "string" &&
    VALID_KINDS.has(candidate.kind as SidebarPinnedKind)
  );
}

export function normalizeSidebarPinnedRefs(value: unknown): SidebarPinnedRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: SidebarPinnedRef[] = [];
  for (const item of value) {
    if (!isSidebarPinnedRef(item)) continue;
    const ref = { kind: item.kind, id: item.id };
    const key = sidebarPinnedRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

export function sidebarPinnedRefsEqual(a: SidebarPinnedRef[], b: SidebarPinnedRef[]): boolean {
  return a.length === b.length && a.every((ref, index) => sidebarPinnedRefKey(ref) === sidebarPinnedRefKey(b[index]));
}

export function hasSidebarPinnedRef(refs: SidebarPinnedRef[], ref: SidebarPinnedRef): boolean {
  const key = sidebarPinnedRefKey(ref);
  return refs.some((item) => sidebarPinnedRefKey(item) === key);
}

export function upsertSidebarPinnedRef(refs: SidebarPinnedRef[], ref: SidebarPinnedRef): SidebarPinnedRef[] {
  if (hasSidebarPinnedRef(refs, ref)) return refs;
  return [...refs, ref];
}

export function removeSidebarPinnedRef(refs: SidebarPinnedRef[], ref: SidebarPinnedRef): SidebarPinnedRef[] {
  const key = sidebarPinnedRefKey(ref);
  return refs.filter((item) => sidebarPinnedRefKey(item) !== key);
}

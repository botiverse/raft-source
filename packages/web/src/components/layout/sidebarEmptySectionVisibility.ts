// A single global display preference (not per-server): when on, sidebar sections
// that currently hold nothing — empty Pinned, empty joined-channels, empty custom
// sections, empty DMs — are dropped entirely (header + empty-state help), instead
// of showing a header over a hint line. Empty-vs-not is still evaluated per server
// at render time; only the on/off choice is stored.
const STORAGE_KEY = "slock:sidebarHideEmptySections";

type SidebarVisibilityStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): SidebarVisibilityStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// Default OFF everywhere, desktop included: empty sections stay visible so their
// create affordances remain discoverable. (#7608 had made desktop default ON;
// that default was never written to storage, so only users who explicitly chose
// a value keep "on".) A stored choice always wins.
export function defaultHideEmptySidebarSections(): boolean {
  return false;
}

export function readHideEmptySidebarSections(
  storage?: SidebarVisibilityStorage,
  fallback: boolean = defaultHideEmptySidebarSections(),
): boolean {
  const target = storage ?? getDefaultStorage();
  if (!target) return fallback;
  try {
    const stored = target.getItem(STORAGE_KEY);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

export function writeHideEmptySidebarSections(
  hide: boolean,
  storage?: SidebarVisibilityStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!target) return;
  try {
    target.setItem(STORAGE_KEY, String(hide));
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

export function shouldHideEmptySidebarSection({
  hideEmptySections,
  loading,
  itemCount,
  dragActive = false,
  dragStartedInSection = false,
  revealWhileDragging = false,
}: {
  hideEmptySections: boolean;
  loading: boolean;
  itemCount: number;
  dragActive?: boolean;
  dragStartedInSection?: boolean;
  revealWhileDragging?: boolean;
}): boolean {
  if (!hideEmptySections || loading || itemCount > 0) return false;
  if (dragActive && (dragStartedInSection || revealWhileDragging)) return false;
  return true;
}

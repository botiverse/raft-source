// How many rows each sidebar section held the last time it loaded on a server,
// so while it loads again its skeleton draws that many rows and the real rows
// replace them in place instead of pushing the sections below down (layout
// shift on cold and warm starts). One entry per (user, server, section):
// `slock:sidebarRowCount:{userId}:{serverId}:{section}`. Only counts are
// stored, never names.

export type SidebarRowCountSection = "pinned" | "jointChannels" | "channels" | "dms";

export type SidebarSectionRowCounts = Record<SidebarRowCountSection, number | null>;

const STORAGE_PREFIX = "slock:sidebarRowCount";

const STORAGE_SECTION_IDS: Record<SidebarRowCountSection, string> = {
  pinned: "pinned",
  jointChannels: "joint-channels",
  channels: "channels",
  dms: "direct-messages",
};

/** More rows than any sidebar shows at once: the rest is below the fold. */
export const SIDEBAR_ROW_COUNT_MAX = 30;

const UNKNOWN_ROW_COUNTS: SidebarSectionRowCounts = {
  pinned: null,
  jointChannels: null,
  channels: null,
  dms: null,
};

type SidebarRowCountStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): SidebarRowCountStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function sidebarSectionRowCountStorageKey(
  userId: string,
  serverId: string,
  section: SidebarRowCountSection,
): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:${STORAGE_SECTION_IDS[section]}`;
}

function clampRowCount(count: number): number {
  return Math.min(Math.max(Math.floor(count), 0), SIDEBAR_ROW_COUNT_MAX);
}

/** The remembered counts; null for a section never loaded here (or unreadable). */
export function readSidebarSectionRowCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  storage?: SidebarRowCountStorage,
): SidebarSectionRowCounts {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return UNKNOWN_ROW_COUNTS;

  const result = { ...UNKNOWN_ROW_COUNTS };
  for (const section of Object.keys(STORAGE_SECTION_IDS) as SidebarRowCountSection[]) {
    try {
      const stored = target.getItem(sidebarSectionRowCountStorageKey(userId, serverId, section));
      const count = stored === null ? NaN : Number(stored);
      if (Number.isFinite(count)) result[section] = clampRowCount(count);
    } catch {
      return UNKNOWN_ROW_COUNTS;
    }
  }
  return result;
}

export function writeSidebarSectionRowCounts(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  counts: Record<SidebarRowCountSection, number>,
  storage?: SidebarRowCountStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return;

  for (const section of Object.keys(STORAGE_SECTION_IDS) as SidebarRowCountSection[]) {
    const key = sidebarSectionRowCountStorageKey(userId, serverId, section);
    const value = String(clampRowCount(counts[section]));
    try {
      if (target.getItem(key) !== value) target.setItem(key, value);
    } catch {
      // Storage can be unavailable in private/embedded browser contexts.
      return;
    }
  }
}

// The Computers rail's rows the last time its list loaded on a server, so its
// skeleton draws that many two-line rows while the list loads again.
// `slock:sidebarRowCount:{userId}:{serverId}:computers`. A count only.

export function sidebarComputerRowCountStorageKey(userId: string, serverId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:computers`;
}

/** The remembered count; null when never loaded here (or unreadable). */
export function readSidebarComputerRowCount(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  storage?: SidebarRowCountStorage,
): number | null {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return null;
  try {
    const stored = target.getItem(sidebarComputerRowCountStorageKey(userId, serverId));
    const count = stored === null ? NaN : Number(stored);
    return Number.isFinite(count) ? clampRowCount(count) : null;
  } catch {
    return null;
  }
}

export function writeSidebarComputerRowCount(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  count: number,
  storage?: SidebarRowCountStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return;
  const key = sidebarComputerRowCountStorageKey(userId, serverId);
  const value = String(clampRowCount(count));
  try {
    if (target.getItem(key) !== value) target.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/**
 * The skeleton rows a still-loading section draws: the remembered count, or
 * `fallback` when this section has never loaded on this server.
 */
export function sidebarSkeletonRows(remembered: number | null, fallback: number): number {
  return remembered ?? fallback;
}

// Whether each entry row that appears only once an answer arrives (Drafts:
// its server flag; Assistant: the assistant API) was shown the last time it
// was known on this server, so on the next start it is drawn from the outset
// instead of pushing everything below it down when the answer lands.
// `slock:sidebarEntry:{userId}:{serverId}:{entry}` = "1" | "0".

export type SidebarEntryRow = "drafts" | "assistant";

const ENTRY_STORAGE_PREFIX = "slock:sidebarEntry";

export function sidebarEntryStorageKey(
  userId: string,
  serverId: string,
  entry: SidebarEntryRow,
): string {
  return `${ENTRY_STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(serverId)}:${entry}`;
}

/** Whether the row was shown last time; null when never known here (or unreadable). */
export function readSidebarEntryShown(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  entry: SidebarEntryRow,
  storage?: SidebarRowCountStorage,
): boolean | null {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return null;
  try {
    const stored = target.getItem(sidebarEntryStorageKey(userId, serverId, entry));
    return stored === "1" ? true : stored === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeSidebarEntryShown(
  userId: string | null | undefined,
  serverId: string | null | undefined,
  entry: SidebarEntryRow,
  shown: boolean,
  storage?: SidebarRowCountStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !serverId || !target) return;
  const key = sidebarEntryStorageKey(userId, serverId, entry);
  const value = shown ? "1" : "0";
  try {
    if (target.getItem(key) !== value) target.setItem(key, value);
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/**
 * Whether an entry row shows: the answer once known; until then what was shown
 * last time, and hidden when that was never known.
 */
export function sidebarEntryShown(answer: boolean | null, remembered: boolean | null): boolean {
  return answer ?? remembered ?? false;
}

/**
 * The skeleton rows a held section draws: the remembered count, or when this
 * section has never loaded here, `fallback` or the rows it already has if more
 * (up to SIDEBAR_ROW_COUNT_MAX), so holding it does not make it shorter.
 */
export function sidebarHeldSkeletonRows(
  remembered: number | null,
  fallback: number,
  currentRows: number,
): number {
  return remembered ?? clampRowCount(Math.max(fallback, currentRows));
}

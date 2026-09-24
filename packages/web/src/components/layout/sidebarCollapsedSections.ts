export interface SidebarCollapsedSections {
  pinned: boolean;
  jointChannels: boolean;
  channels: boolean;
  humans: boolean;
  agents: boolean;
  machinesAgents: boolean;
}

export type SidebarCollapsedSection = keyof SidebarCollapsedSections;

const STORAGE_PREFIX = "slock:sidebarCollapsed";
const CUSTOM_SECTION_STORAGE_SUFFIX = "custom";

const STORAGE_SECTION_IDS: Record<SidebarCollapsedSection, string> = {
  pinned: "pinned",
  jointChannels: "joint-channels",
  channels: "channels",
  humans: "humans",
  agents: "direct-messages",
  machinesAgents: "members-agents",
};

export const DEFAULT_SIDEBAR_COLLAPSED_SECTIONS: SidebarCollapsedSections = {
  pinned: false,
  jointChannels: false,
  channels: false,
  humans: false,
  agents: false,
  machinesAgents: false,
};

type SidebarCollapsedStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): SidebarCollapsedStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function sidebarCollapsedSectionStorageKey(
  userId: string,
  section: SidebarCollapsedSection,
): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${STORAGE_SECTION_IDS[section]}`;
}

export function readSidebarCollapsedSections(
  userId: string | undefined,
  storage?: SidebarCollapsedStorage,
): SidebarCollapsedSections {
  const target = storage ?? getDefaultStorage();
  const result = { ...DEFAULT_SIDEBAR_COLLAPSED_SECTIONS };
  if (!userId || !target) return result;

  for (const section of Object.keys(STORAGE_SECTION_IDS) as SidebarCollapsedSection[]) {
    try {
      const stored = target.getItem(sidebarCollapsedSectionStorageKey(userId, section));
      if (stored === "true") result[section] = true;
      if (stored === "false") result[section] = false;
    } catch {
      return { ...DEFAULT_SIDEBAR_COLLAPSED_SECTIONS };
    }
  }

  return result;
}

export function writeSidebarCollapsedSection(
  userId: string | undefined,
  section: SidebarCollapsedSection,
  collapsed: boolean,
  storage?: SidebarCollapsedStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !target) return;

  try {
    target.setItem(sidebarCollapsedSectionStorageKey(userId, section), String(collapsed));
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/**
 * Custom sidebar sections use server-synchronised UUIDs, so their disclosure
 * preference is kept separately from the fixed system-section preferences.
 * Storing by section id means renaming or reordering a section does not lose
 * the user's choice.
 */
export function sidebarCustomSectionCollapsedStorageKey(userId: string, sectionId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${CUSTOM_SECTION_STORAGE_SUFFIX}:${encodeURIComponent(sectionId)}`;
}

export function readSidebarCustomSectionCollapsed(
  userId: string | undefined,
  sectionId: string,
  storage?: SidebarCollapsedStorage,
): boolean {
  const target = storage ?? getDefaultStorage();
  if (!userId || !sectionId || !target) return false;

  try {
    return target.getItem(sidebarCustomSectionCollapsedStorageKey(userId, sectionId)) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCustomSectionCollapsed(
  userId: string | undefined,
  sectionId: string,
  collapsed: boolean,
  storage?: SidebarCollapsedStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !sectionId || !target) return;

  try {
    target.setItem(sidebarCustomSectionCollapsedStorageKey(userId, sectionId), String(collapsed));
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

/**
 * Members-rail agent machine groups are keyed by the server-side machine id
 * (stable across renames), so disclosure preference survives the machine being
 * renamed. Agents without a machine share the "__no_machine__" group key.
 */
const AGENT_MACHINE_GROUP_STORAGE_SUFFIX = "agent-machine-group";

export function sidebarAgentMachineGroupCollapsedStorageKey(userId: string, machineKey: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${AGENT_MACHINE_GROUP_STORAGE_SUFFIX}:${encodeURIComponent(machineKey)}`;
}

export function readSidebarAgentMachineGroupCollapsed(
  userId: string | undefined,
  machineKey: string,
  storage?: SidebarCollapsedStorage,
): boolean {
  const target = storage ?? getDefaultStorage();
  if (!userId || !machineKey || !target) return false;

  try {
    return target.getItem(sidebarAgentMachineGroupCollapsedStorageKey(userId, machineKey)) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarAgentMachineGroupCollapsed(
  userId: string | undefined,
  machineKey: string,
  collapsed: boolean,
  storage?: SidebarCollapsedStorage,
): void {
  const target = storage ?? getDefaultStorage();
  if (!userId || !machineKey || !target) return;

  try {
    target.setItem(sidebarAgentMachineGroupCollapsedStorageKey(userId, machineKey), String(collapsed));
  } catch {
    // Storage can be unavailable in private/embedded browser contexts.
  }
}

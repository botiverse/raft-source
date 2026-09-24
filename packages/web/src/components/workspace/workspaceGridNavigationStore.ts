import { create } from "zustand";

export type WorkspaceGridRailMode =
  | "chat"
  | "search"
  | "saved"
  | "activity"
  | "tasks"
  | "wiki"
  | "members"
  | "humans"
  | "computers"
  | null;

export type WorkspaceGridRailSide = "left" | "right";
export type WorkspaceGridRailItem = Exclude<WorkspaceGridRailMode, null>;

export interface WorkspaceGridRailLayout {
  left: WorkspaceGridRailItem[];
  right: WorkspaceGridRailItem[];
}

export interface WorkspaceGridSidebarState {
  activeItem: WorkspaceGridRailMode;
  collapsed: boolean;
}

export type WorkspaceGridSidebars = Record<WorkspaceGridRailSide, WorkspaceGridSidebarState>;
export type WorkspaceGridSidebarWidths = Record<WorkspaceGridRailSide, number>;

export interface WorkspaceGridRailDragState {
  item: WorkspaceGridRailItem;
  sourceSide: WorkspaceGridRailSide;
  pointerX: number;
  pointerY: number;
  targetSide: WorkspaceGridRailSide | null;
  targetIndex: number | null;
}

export const DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT: WorkspaceGridRailLayout = {
  left: ["search", "chat", "activity", "tasks", "wiki", "saved", "members", "computers"],
  right: [],
};

export const DEFAULT_WORKSPACE_GRID_SIDEBARS: WorkspaceGridSidebars = {
  left: { activeItem: "chat", collapsed: false },
  right: { activeItem: null, collapsed: true },
};

export const DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH = 240;
export const MIN_WORKSPACE_GRID_SIDEBAR_WIDTH = 200;
export const MAX_WORKSPACE_GRID_SIDEBAR_WIDTH = 420;

export function maxWorkspaceGridSidebarWidth(viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth) {
  return Math.max(MIN_WORKSPACE_GRID_SIDEBAR_WIDTH, Math.min(MAX_WORKSPACE_GRID_SIDEBAR_WIDTH, Math.floor(viewportWidth * 0.4)));
}

export function normalizeWorkspaceGridSidebarWidth(value: unknown, viewportWidth?: number) {
  const max = maxWorkspaceGridSidebarWidth(viewportWidth);
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH;
  return Math.max(MIN_WORKSPACE_GRID_SIDEBAR_WIDTH, Math.min(max, Math.round(value)));
}

const WORKSPACE_GRID_RAIL_ITEMS = new Set<WorkspaceGridRailItem>(DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT.left);

export interface WorkspaceGridNavigationState {
  active: boolean;
  enabled: boolean;
  hydratedUserId: string | null;
  sidebarCollapsed: boolean;
  railMode: WorkspaceGridRailMode;
  activeRailSide: WorkspaceGridRailSide;
  railLayout: WorkspaceGridRailLayout;
  sidebars: WorkspaceGridSidebars;
  sidebarWidths: WorkspaceGridSidebarWidths;
  settingsModalOpen: boolean;
  settingsModalSide: WorkspaceGridRailSide;
  railDrag: WorkspaceGridRailDragState | null;
  activeRefKey: string | null;
  activeAncestorRefKey: string | null;
  hydrate: (userId: string | null) => void;
  setEnabled: (enabled: boolean, userId: string | null) => void;
  setActive: (active: boolean) => void;
  setSidebarCollapsed: (sidebarCollapsed: boolean, userId: string | null, side?: WorkspaceGridRailSide) => void;
  setRailMode: (railMode: WorkspaceGridRailMode, side?: WorkspaceGridRailSide, userId?: string | null) => void;
  moveRailItem: (item: WorkspaceGridRailItem, side: WorkspaceGridRailSide, index: number, userId: string | null) => void;
  setSidebarWidth: (side: WorkspaceGridRailSide, width: number, userId: string | null) => void;
  setRailDrag: (railDrag: WorkspaceGridRailDragState | null) => void;
  openSettingsModal: (side: WorkspaceGridRailSide) => void;
  closeSettingsModal: () => void;
  setActiveRefKey: (activeRefKey: string | null) => void;
  setActiveAncestorRefKey: (activeAncestorRefKey: string | null) => void;
}

function preferenceKey(userId: string) {
  return `raft:workspace-grid-mode:${userId}`;
}

export function normalizeWorkspaceGridRailLayout(value: unknown): WorkspaceGridRailLayout {
  const candidate = value && typeof value === "object"
    ? value as Partial<Record<WorkspaceGridRailSide, unknown>>
    : {};
  const seen = new Set<WorkspaceGridRailItem>();
  const readSide = (side: WorkspaceGridRailSide) => Array.isArray(candidate[side])
    ? candidate[side].filter((item): item is WorkspaceGridRailItem => {
        if (typeof item !== "string" || !WORKSPACE_GRID_RAIL_ITEMS.has(item as WorkspaceGridRailItem)) return false;
        const railItem = item as WorkspaceGridRailItem;
        if (railItem === "wiki" && side === "right") return false;
        if (seen.has(railItem)) return false;
        seen.add(railItem);
        return true;
      })
    : [];
  const left = readSide("left");
  const right = readSide("right");

  // Wiki is a gated, fixed left-rail entry. Existing saved layouts predate it,
  // so hydrate it immediately below Tasks (or before Members as a fallback)
  // instead of appending it after the user's existing navigation.
  if (!seen.has("wiki")) {
    const tasksIndex = left.indexOf("tasks");
    const membersIndex = left.indexOf("members");
    const wikiIndex = tasksIndex >= 0 ? tasksIndex + 1 : membersIndex;
    if (wikiIndex >= 0) {
      left.splice(wikiIndex, 0, "wiki");
      seen.add("wiki");
    }
  }
  for (const item of DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT.left) {
    if (!seen.has(item)) left.push(item);
  }
  return { left, right };
}

export function moveWorkspaceGridRailItem(
  layout: WorkspaceGridRailLayout,
  item: WorkspaceGridRailItem,
  side: WorkspaceGridRailSide,
  index: number,
): WorkspaceGridRailLayout {
  if (item === "wiki") return layout;
  const source = layout.left.includes(item) ? "left" : "right";
  const sourceIndex = layout[source].indexOf(item);
  const left = layout.left.filter((candidate) => candidate !== item);
  const right = layout.right.filter((candidate) => candidate !== item);
  const target = side === "left" ? left : right;
  const adjustedIndex = source === side && sourceIndex < index ? index - 1 : index;
  target.splice(Math.max(0, Math.min(adjustedIndex, target.length)), 0, item);
  return { left, right };
}

function firstSidebarItem(items: WorkspaceGridRailItem[]): WorkspaceGridRailMode {
  return items[0] ?? null;
}

function normalizeWorkspaceGridSidebars(
  value: unknown,
  railLayout: WorkspaceGridRailLayout,
  legacyCollapsed: boolean,
): WorkspaceGridSidebars {
  if (!value || typeof value !== "object") {
    const chatSide: WorkspaceGridRailSide = railLayout.right.includes("chat") ? "right" : "left";
    return {
      left: {
        activeItem: chatSide === "left" ? "chat" : null,
        collapsed: chatSide === "left" ? legacyCollapsed : true,
      },
      right: {
        activeItem: chatSide === "right" ? "chat" : null,
        collapsed: chatSide === "right" ? legacyCollapsed : true,
      },
    };
  }
  const candidate = value as Partial<Record<WorkspaceGridRailSide, unknown>>;
  const readSide = (side: WorkspaceGridRailSide): WorkspaceGridSidebarState => {
    const sideValue = candidate[side] && typeof candidate[side] === "object"
      ? candidate[side] as { activeItem?: unknown; collapsed?: unknown }
      : {};
    const activeItem = typeof sideValue.activeItem === "string"
      && railLayout[side].includes(sideValue.activeItem as WorkspaceGridRailItem)
      ? sideValue.activeItem as WorkspaceGridRailMode
      : null;
    return {
      activeItem,
      collapsed: activeItem === null || sideValue.collapsed === true,
    };
  };
  return { left: readSide("left"), right: readSide("right") };
}

function readPreference(userId: string): {
  enabled: boolean;
  sidebarCollapsed: boolean;
  railLayout: WorkspaceGridRailLayout;
  sidebars: WorkspaceGridSidebars;
  sidebarWidths: WorkspaceGridSidebarWidths;
} {
  try {
    const raw = localStorage.getItem(preferenceKey(userId));
    if (!raw) return {
      enabled: false,
      sidebarCollapsed: false,
      railLayout: normalizeWorkspaceGridRailLayout(null),
      sidebars: DEFAULT_WORKSPACE_GRID_SIDEBARS,
      sidebarWidths: { left: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH, right: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH },
    };
    const value = JSON.parse(raw) as {
      enabled?: unknown;
      sidebarCollapsed?: unknown;
      railLayout?: unknown;
      sidebars?: unknown;
      sidebarWidths?: Partial<Record<WorkspaceGridRailSide, unknown>>;
    };
    const railLayout = normalizeWorkspaceGridRailLayout(value.railLayout);
    const sidebarCollapsed = value.sidebarCollapsed === true;
    return {
      enabled: value.enabled === true,
      sidebarCollapsed,
      railLayout,
      sidebars: normalizeWorkspaceGridSidebars(value.sidebars, railLayout, sidebarCollapsed),
      sidebarWidths: {
        left: normalizeWorkspaceGridSidebarWidth(value.sidebarWidths?.left),
        right: normalizeWorkspaceGridSidebarWidth(value.sidebarWidths?.right),
      },
    };
  } catch {
    return {
      enabled: false,
      sidebarCollapsed: false,
      railLayout: normalizeWorkspaceGridRailLayout(null),
      sidebars: DEFAULT_WORKSPACE_GRID_SIDEBARS,
      sidebarWidths: { left: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH, right: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH },
    };
  }
}

function writePreference(
  userId: string | null,
  preference: Pick<WorkspaceGridNavigationState, "enabled" | "sidebarCollapsed" | "railLayout" | "sidebars" | "sidebarWidths">,
) {
  if (!userId) return;
  try {
    localStorage.setItem(preferenceKey(userId), JSON.stringify({
      enabled: preference.enabled,
      sidebarCollapsed: preference.sidebarCollapsed,
      railLayout: preference.railLayout,
      sidebars: preference.sidebars,
      sidebarWidths: preference.sidebarWidths,
    }));
  } catch {
    // The in-memory mode remains usable when browser storage is unavailable.
  }
}

export const useWorkspaceGridNavigationStore = create<WorkspaceGridNavigationState>((set) => ({
  active: false,
  enabled: false,
  hydratedUserId: null,
  sidebarCollapsed: false,
  railMode: null,
  activeRailSide: "left",
  railLayout: normalizeWorkspaceGridRailLayout(null),
  sidebars: DEFAULT_WORKSPACE_GRID_SIDEBARS,
  sidebarWidths: { left: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH, right: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH },
  settingsModalOpen: false,
  settingsModalSide: "left",
  railDrag: null,
  activeRefKey: null,
  activeAncestorRefKey: null,
  hydrate: (userId) => set((state) => {
    if (!userId) return {
      active: false,
      enabled: false,
      hydratedUserId: null,
      sidebarCollapsed: false,
      railMode: null,
      activeRailSide: "left",
      railLayout: normalizeWorkspaceGridRailLayout(null),
      sidebars: DEFAULT_WORKSPACE_GRID_SIDEBARS,
      sidebarWidths: { left: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH, right: DEFAULT_WORKSPACE_GRID_SIDEBAR_WIDTH },
      settingsModalOpen: false,
      settingsModalSide: "left",
      railDrag: null,
      activeRefKey: null,
      activeAncestorRefKey: null,
    };
    if (state.hydratedUserId === userId) return state;
    const preference = readPreference(userId);
    return {
      ...preference,
      active: false,
      hydratedUserId: userId,
      railMode: preference.sidebars.left.activeItem ?? preference.sidebars.right.activeItem,
      sidebarCollapsed: preference.sidebars.left.collapsed,
      activeRailSide: preference.sidebars.left.activeItem ? "left" : "right",
      settingsModalOpen: false,
      settingsModalSide: "left",
      railDrag: null,
      activeRefKey: null,
      activeAncestorRefKey: null,
    };
  }),
  setEnabled: (enabled, userId) => set((state) => {
    const next = {
      enabled,
      active: enabled ? state.active : false,
      railMode: enabled ? state.railMode : null,
      activeRefKey: enabled ? state.activeRefKey : null,
      activeAncestorRefKey: enabled ? state.activeAncestorRefKey : null,
      settingsModalOpen: enabled ? state.settingsModalOpen : false,
      railDrag: null,
    };
    writePreference(userId, { ...state, ...next });
    return next;
  }),
  setActive: (active) => set((state) => {
    const chatSide: WorkspaceGridRailSide = state.railLayout.right.includes("chat") ? "right" : "left";
    const hasOpenSidebar = Object.values(state.sidebars).some((sidebar) => sidebar.activeItem && !sidebar.collapsed);
    const sidebars = active && !hasOpenSidebar
      ? { ...state.sidebars, [chatSide]: { activeItem: "chat" as const, collapsed: false } }
      : state.sidebars;
    const activeRailSide = active && !hasOpenSidebar ? chatSide : state.activeRailSide;
    const railMode = active ? sidebars[activeRailSide].activeItem ?? sidebars[chatSide].activeItem : null;
    return {
      active,
      railMode,
      sidebarCollapsed: active ? sidebars[activeRailSide].collapsed : state.sidebarCollapsed,
      activeRailSide,
      sidebars,
      activeRefKey: active ? state.activeRefKey : null,
      activeAncestorRefKey: active ? state.activeAncestorRefKey : null,
      settingsModalOpen: active ? state.settingsModalOpen : false,
      railDrag: null,
    };
  }),
  setSidebarCollapsed: (sidebarCollapsed, userId, side) => set((state) => {
    const targetSide = side ?? state.activeRailSide;
    const sidebars = {
      ...state.sidebars,
      [targetSide]: { ...state.sidebars[targetSide], collapsed: sidebarCollapsed },
    };
    const next = { sidebarCollapsed, activeRailSide: targetSide, sidebars };
    writePreference(userId, { ...state, ...next });
    return next;
  }),
  setRailMode: (railMode, activeRailSide = "left", userId = null) => set((state) => {
    const sidebars = {
      ...state.sidebars,
      [activeRailSide]: {
        activeItem: railMode,
        collapsed: railMode === null ? state.sidebars[activeRailSide].collapsed : false,
      },
    };
    const next = {
      railMode,
      activeRailSide,
      sidebarCollapsed: railMode === null ? state.sidebars[activeRailSide].collapsed : false,
      sidebars,
    };
    writePreference(userId, { ...state, ...next });
    return next;
  }),
  moveRailItem: (item, side, index, userId) => set((state) => {
    const source = state.railLayout.left.includes(item) ? "left" : "right";
    const railLayout = moveWorkspaceGridRailItem(state.railLayout, item, side, index);
    let sidebars = state.sidebars;
    if (source !== side && state.sidebars[source].activeItem === item) {
      sidebars = {
        ...state.sidebars,
        [source]: {
          activeItem: firstSidebarItem(railLayout[source]),
          collapsed: firstSidebarItem(railLayout[source]) === null ? true : state.sidebars[source].collapsed,
        },
        [side]: { activeItem: item, collapsed: false },
      };
    }
    const movedActiveItem = state.sidebars[source].activeItem === item;
    const next = {
      railLayout,
      sidebars,
      railMode: movedActiveItem ? item : state.railMode,
      activeRailSide: movedActiveItem ? side : state.activeRailSide,
      sidebarCollapsed: movedActiveItem ? false : state.sidebarCollapsed,
    };
    writePreference(userId, { ...state, ...next });
    return next;
  }),
  setSidebarWidth: (side, width, userId) => set((state) => {
    const sidebarWidths = { ...state.sidebarWidths, [side]: normalizeWorkspaceGridSidebarWidth(width) };
    writePreference(userId, { ...state, sidebarWidths });
    return { sidebarWidths };
  }),
  setRailDrag: (railDrag) => set({ railDrag }),
  openSettingsModal: (settingsModalSide) => set({ settingsModalOpen: true, settingsModalSide }),
  closeSettingsModal: () => set({ settingsModalOpen: false }),
  setActiveRefKey: (activeRefKey) => set({ activeRefKey }),
  setActiveAncestorRefKey: (activeAncestorRefKey) => set({ activeAncestorRefKey }),
}));

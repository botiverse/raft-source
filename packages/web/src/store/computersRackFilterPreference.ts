import { create } from "zustand";
import { RUNTIME_ACCOUNT_USAGE_PROVIDERS } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";

/**
 * What the Computers overview shows besides its sort
 * (computersRackSortPreference): the search, the Status and Runtime filters,
 * and the grouping (Raft DS › Raft Chat › Computers). The grouping is how
 * people like to see the list, so it is kept in this browser's localStorage,
 * like the sort and the list / cards choice; the search and the filters are
 * what they look for now, so they last as long as the page, on one server:
 * another server's computers start from no search and no filter. Desktop and
 * phone share it.
 */
export type ComputersRackStatusFilter = "all" | "online" | "offline" | "attention";
export type ComputersRackRuntimeFilter = RuntimeAccountUsageProvider | "other";
export type ComputersRackGroupBy = "none" | "provider" | "prefix";

export const COMPUTERS_RACK_STATUS_FILTERS: readonly ComputersRackStatusFilter[] = ["all", "online", "offline", "attention"];
export const COMPUTERS_RACK_RUNTIME_FILTERS: readonly ComputersRackRuntimeFilter[] = [...RUNTIME_ACCOUNT_USAGE_PROVIDERS, "other"];
export const COMPUTERS_RACK_GROUP_BYS: readonly ComputersRackGroupBy[] = ["none", "prefix", "provider"];

export interface ComputersRackFilters {
  query: string;
  status: ComputersRackStatusFilter;
  runtimes: readonly ComputersRackRuntimeFilter[];
  groupBy: ComputersRackGroupBy;
}

export const COMPUTERS_RACK_GROUP_STORAGE_KEY = "raft_computers_rack_group";

const DEFAULTS: ComputersRackFilters = { query: "", status: "all", runtimes: [], groupBy: "none" };

function readStoredGroup(): ComputersRackGroupBy {
  try {
    const raw = window.localStorage.getItem(COMPUTERS_RACK_GROUP_STORAGE_KEY);
    return COMPUTERS_RACK_GROUP_BYS.find((groupBy) => groupBy === raw) ?? DEFAULTS.groupBy;
  } catch {
    // Storage blocked: the default.
    return DEFAULTS.groupBy;
  }
}

function writeStoredGroup(groupBy: ComputersRackGroupBy): void {
  try {
    window.localStorage.setItem(COMPUTERS_RACK_GROUP_STORAGE_KEY, groupBy);
  } catch {
    // Storage blocked or full: the choice holds for this page only.
  }
}

interface ComputersRackFilterStore extends ComputersRackFilters {
  set: (next: Partial<ComputersRackFilters>) => void;
  /** Clear all: the search, Status and Runtime; the grouping (and the sort and view) stay. */
  clearFilters: () => void;
}

export const useComputersRackFilters = create<ComputersRackFilterStore>((set) => ({
  ...DEFAULTS,
  groupBy: typeof window === "undefined" ? DEFAULTS.groupBy : readStoredGroup(),
  set: (next) => {
    set(next);
    if (next.groupBy !== undefined) writeStoredGroup(next.groupBy);
  },
  clearFilters: () => {
    set({ query: DEFAULTS.query, status: DEFAULTS.status, runtimes: DEFAULTS.runtimes });
  },
}));

// Another server: its computers, so none of this server's search or filters.
let filteredServerId = useServerStore.getState().current?.id ?? null;
useServerStore.subscribe((state) => {
  const serverId = state.current?.id ?? null;
  if (serverId === filteredServerId) return;
  filteredServerId = serverId;
  useComputersRackFilters.getState().clearFilters();
});

/** Whether Clear all shows: the search, Status or Runtime differs from its default. */
export function hasActiveRackFilters(filters: Pick<ComputersRackFilters, "query" | "status" | "runtimes">): boolean {
  return filters.query.trim() !== "" || filters.status !== "all" || filters.runtimes.length > 0;
}

/** Tests and visual cases: the defaults (the stored grouping too), or these values, with nothing stored. */
export function resetComputersRackFiltersForTests(next: Partial<ComputersRackFilters> = {}): void {
  useComputersRackFilters.setState({ ...DEFAULTS, ...next });
}

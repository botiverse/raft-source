import { useMemo } from "react";
import type { IntlShape } from "react-intl";
import { useShallow } from "zustand/react/shallow";
import { hasActiveRackFilters, useComputersRackFilters } from "../../store/computersRackFilterPreference";
import type { ComputersRackGroupBy, ComputersRackRuntimeFilter, ComputersRackStatusFilter } from "../../store/computersRackFilterPreference";
import { useComputersRackSort } from "../../store/computersRackSortPreference";
import type { ComputersRackSort, ComputersRackSortDirection, ComputersRackSortKey } from "../../store/computersRackSortPreference";
import { rackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import type { RackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import type { MessageId } from "../../i18n/messages";
import { RACK_PROVIDER_NAMES, effectiveRuntimeFilter, runtimeFilterOptions } from "./computersRackFilter";
import { effectiveRackSort, firstSortDirection, parseRemainingSortKey, remainingSortKey } from "./computersRackSort";
import { useOrderedMachines } from "./useOrderedMachines";

/**
 * What the Computers toolbar (ComputersRackToolbar) reads and says: the
 * computers' runtime columns, the filters, the sort, and the words for each
 * choice.
 */

type FormatMessage = IntlShape["formatMessage"];

const STATUS_LABEL_IDS = {
  all: "machine.rack.filter.status.all",
  online: "machine.rack.filter.status.online",
  offline: "machine.rack.filter.status.offline",
  attention: "machine.rack.filter.status.attention",
} as const satisfies Record<ComputersRackStatusFilter, string>;

const GROUP_LABEL_IDS = {
  none: "machine.rack.group.none",
  provider: "machine.rack.group.provider",
  prefix: "machine.rack.group.prefix",
} as const satisfies Record<ComputersRackGroupBy, string>;

export function statusFilterLabel(status: ComputersRackStatusFilter, formatMessage: FormatMessage): string {
  return formatMessage({ id: STATUS_LABEL_IDS[status] });
}

export function groupByLabel(groupBy: ComputersRackGroupBy, formatMessage: FormatMessage): string {
  return formatMessage({ id: GROUP_LABEL_IDS[groupBy] });
}

export function runtimeFilterLabel(runtime: ComputersRackRuntimeFilter, formatMessage: FormatMessage): string {
  return runtime === "other" ? formatMessage({ id: "machine.rack.filter.runtime.other" }) : RACK_PROVIDER_NAMES[runtime];
}

/**
 * What the Sort offers: a key, or "default", no sort (the list's own order,
 * the viewer's computers first), said "Mine first".
 */
export type RackSortChoice = ComputersRackSortKey | "default";

/** The sort keys that are not a runtime's: each is said by its own words. */
type PlainSortKey = Exclude<RackSortChoice, `remaining:${string}`>;

const PLAIN_SORT_LABEL_IDS: Record<PlainSortKey, MessageId> = {
  default: "machine.rack.sort.default",
  name: "machine.rack.sort.name",
  disk: "machine.rack.sort.disk",
  memory: "machine.rack.sort.memory",
};

function isPlainSortKey(key: RackSortChoice): key is PlainSortKey {
  return Object.prototype.hasOwnProperty.call(PLAIN_SORT_LABEL_IDS, key);
}

/** "Claude Code remaining", "Disk used", "Name", "Mine first". */
export function sortKeyLabel(key: RackSortChoice, formatMessage: FormatMessage): string {
  if (isPlainSortKey(key)) return formatMessage({ id: PLAIN_SORT_LABEL_IDS[key] });
  const provider = parseRemainingSortKey(key);
  return provider ? formatMessage({ id: "machine.rack.sort.remaining" }, { runtime: RACK_PROVIDER_NAMES[provider] }) : key;
}

/** A to Z / Z to A for the name, Most / Least remaining first for a runtime, Most / Least used first for Disk and Memory. */
export function sortDirectionLabel(key: ComputersRackSortKey, direction: ComputersRackSortDirection, formatMessage: FormatMessage): string {
  const desc = direction === "desc";
  if (key === "name") return formatMessage({ id: desc ? "machine.rack.sort.nameDesc" : "machine.rack.sort.nameAsc" });
  if (parseRemainingSortKey(key)) return formatMessage({ id: desc ? "machine.rack.sort.remainingDesc" : "machine.rack.sort.remainingAsc" });
  return formatMessage({ id: desc ? "machine.rack.sort.usedDesc" : "machine.rack.sort.usedAsc" });
}

/** The Sort's choices, in sections: Mine first (the default) and Name; what each runtime these computers have has left; Disk, Memory. */
export function sortMenuSections(columns: RackRuntimeColumns): RackSortChoice[][] {
  const sections: RackSortChoice[][] = [["default", "name"], columns.usage.map((column) => remainingSortKey(column.provider)), ["disk", "memory"]];
  return sections.filter((keys) => keys.length > 0);
}

/** A new key starts at its own first direction: A to Z, the most remaining or the most used first; "default" is no sort. */
export function chooseRackSortKey(key: RackSortChoice): ComputersRackSort | null {
  return key === "default" ? null : { key, direction: firstSortDirection(key) };
}

/** The choice the Sort shows as checked. */
export function rackSortChoice(sort: ComputersRackSort | null): RackSortChoice {
  return sort?.key ?? "default";
}

/** What the toolbar reads: the computers' columns, the filters (Runtime as it applies), the sort. */
export function useRackToolbarModel() {
  const machines = useOrderedMachines();
  const columns = useMemo(() => rackRuntimeColumns(machines), [machines]);
  const runtimeOptions = useMemo(() => runtimeFilterOptions(columns), [columns]);
  const stored = useComputersRackFilters(useShallow((s) => ({
    query: s.query,
    status: s.status,
    runtimes: s.runtimes,
    groupBy: s.groupBy,
  })));
  const filters = useMemo(
    () => ({ ...stored, runtimes: effectiveRuntimeFilter(stored.runtimes, runtimeOptions) }),
    [runtimeOptions, stored],
  );
  const setFilters = useComputersRackFilters((s) => s.set);
  const clearFilters = useComputersRackFilters((s) => s.clearFilters);
  const storedSort = useComputersRackSort();
  const sort = effectiveRackSort(storedSort, columns);
  return {
    /** Every computer of the server, before the search and the filters. */
    computerCount: machines.length,
    columns,
    runtimeOptions,
    filters,
    setFilters,
    clearFilters,
    filtered: hasActiveRackFilters(filters),
    sort,
  };
}

export type RackToolbarModel = ReturnType<typeof useRackToolbarModel>;

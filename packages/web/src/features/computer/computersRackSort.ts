import { RUNTIME_ACCOUNT_USAGE_PROVIDERS } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import type { Machine } from "../../store/machineStore";
import type { ComputersRackSort, ComputersRackSortDirection, ComputersRackSortKey } from "../../store/computersRackSortPreference";
import { liveDiskStatus, liveMemoryStatus } from "../../components/agentMigration/targetComputerInfo";
import { rackProviderRuntime } from "../../components/machine/rack/rackRuntimeColumns";
import { allModelsUsageAccount } from "../../components/machine/bulkChangeModelPlan";
import type { RackRuntimeColumns, RackUsageResults } from "../../components/machine/rack/rackRuntimeColumns";

/**
 * Sorting the Computers (Raft DS › Table › Sorting): the toolbar's Sort and
 * the list's headings (raft-ui TableSortButton) share one choice, which the
 * cards and the phone follow too. With no sort chosen (the default, the
 * menu's "Mine first") the list keeps the Computers list's own order: this
 * device, then the viewer's own computers, then the rest
 * (sidebarMachineOrder.ts; artin, #triage:#332), and no heading is marked.
 * Numbers (Disk
 * and Memory used, a runtime's remaining quota) start high to low, text (the
 * name) A to Z (`firstSortDirection`). A computer with no value for the key
 * (offline, nothing to read, an account that needs signing in again) is last
 * either way. Ties keep the list's own order (the sidebar's).
 */

export function remainingSortKey(provider: RuntimeAccountUsageProvider): ComputersRackSortKey {
  return `remaining:${provider}`;
}

/** A remaining key's provider; null for any other key. */
export function parseRemainingSortKey(key: ComputersRackSortKey): RuntimeAccountUsageProvider | null {
  if (!key.startsWith("remaining:")) return null;
  return RUNTIME_ACCOUNT_USAGE_PROVIDERS.find((provider) => key === `remaining:${provider}`) ?? null;
}

export function firstSortDirection(key: ComputersRackSortKey): ComputersRackSortDirection {
  return key === "name" ? "asc" : "desc";
}

/**
 * The stored sort if these computers still have its runtime (a runtime comes
 * and goes with its computers); else null, no sort: the list's own order
 * (this device, the viewer's own, the rest).
 */
export function effectiveRackSort(sort: ComputersRackSort | null, columns: RackRuntimeColumns): ComputersRackSort | null {
  if (!sort) return null;
  const provider = parseRemainingSortKey(sort.key);
  if (!provider) return sort;
  return columns.usage.some((column) => column.provider === provider) ? sort : null;
}

type UsageResult = NonNullable<RackUsageResults[RuntimeAccountUsageProvider]>;

/**
 * What a provider's accounts on a computer have left, 0 to 1: the tightest
 * account, and in each account its tightest window. Windows are read by what
 * they say (their status and used ratio), never by their place or name; only
 * `ok` and `limit_reached` windows count, a `limit_reached` one without a
 * ratio as fully used. An account that is rate limited has nothing left (0);
 * one that needs signing in again, is unsupported or failed says nothing, as
 * does one with no window to read. Null: nothing to read for any account.
 */
export function rackRemaining(result: UsageResult | null | undefined): number | null {
  if (!result || result.snapshot === null) return null;
  let tightest: number | null = null;
  for (const reported of result.snapshot.accounts) {
    // The cell's basis: all models, never the OAuth apps' window (allModelsUsageAccount).
    const { account } = allModelsUsageAccount(reported);
    let remaining: number | null = null;
    if (account.health === "rate_limited") {
      remaining = 0;
    } else if (account.health === "ok") {
      const used = account.windows
        .filter((window) => window.status === "ok" || window.status === "limit_reached")
        .map((window) => (typeof window.usedRatio === "number" ? window.usedRatio : window.status === "limit_reached" ? 1 : null))
        .filter((ratio): ratio is number => ratio !== null);
      if (used.length > 0) remaining = Math.max(0, 1 - Math.max(...used));
    }
    if (remaining !== null && (tightest === null || remaining < tightest)) tightest = remaining;
  }
  return tightest;
}

function usedRatio(status: { availableBytes: number; totalBytes: number } | null): number | null {
  if (!status || status.totalBytes <= 0) return null;
  return 1 - status.availableBytes / status.totalBytes;
}

function machineName(machine: Machine): string | null {
  return machine.name?.trim() || machine.hostname?.trim() || null;
}

type SortValue = string | number | null;

export function rackSortValue(
  machine: Machine,
  key: ComputersRackSortKey,
  usage: ReadonlyMap<string, RackUsageResults | null>,
): SortValue {
  if (key === "name") return machineName(machine);
  if (key === "disk") return usedRatio(liveDiskStatus(machine));
  if (key === "memory") return usedRatio(liveMemoryStatus(machine));
  const provider = parseRemainingSortKey(key);
  // A computer without the runtime has nothing left of it to sort by.
  if (!provider || !rackProviderRuntime(machine, provider)) return null;
  return rackRemaining(usage.get(machine.id)?.[provider]);
}

/** `machines` in `sort`'s order. */
export function sortRackMachines(
  machines: readonly Machine[],
  sort: ComputersRackSort,
  usage: ReadonlyMap<string, RackUsageResults | null>,
  locale: string,
): readonly Machine[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const sign = sort.direction === "asc" ? 1 : -1;
  const keyed = machines.map((machine) => ({ machine, value: rackSortValue(machine, sort.key, usage) }));
  keyed.sort((a, b) => {
    // No value is last in both directions.
    if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? 1 : -1;
    const order = typeof a.value === "string" && typeof b.value === "string"
      ? collator.compare(a.value, b.value)
      : Number(a.value) - Number(b.value);
    return sign * order;
  });
  return keyed.map(({ machine }) => machine);
}

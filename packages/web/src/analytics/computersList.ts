// The Computers page's events (cindyz, 2026-11-12, #proj-analytics:a559ea75):
// what the page showed when it opened, each control the person changed, and
// each computer they opened. Called from the controls' own handlers; the
// snapshot from the page's toolbar, which is on screen as long as the page is
// (features/computer/useComputersListViewed.ts).
// Enums, booleans and counts only: no computer id, name or host name, never
// the search text or its length (registry: COMPUTERS_LIST_*).
import { COMPUTERS_LIST_MAX_COUNT, COMPUTERS_LIST_SORT_RUNTIMES } from "@botiverse/raft-shared";
import type { ProductEventProperties } from "@botiverse/raft-shared";
import type { ComputersRackSort, ComputersRackSortKey } from "../store/computersRackSortPreference";
import { trackEvent } from "./track";

export type ComputersListViewed = ProductEventProperties<"computers_list_viewed">;
export type ComputersListControlChanged = ProductEventProperties<"computers_list_control_changed">;
export type ComputersListComputerOpened = ProductEventProperties<"computers_list_computer_opened">;

/** A count as the registry takes it: a whole number from 0 to its max. */
function count(value: number): number {
  return Math.max(0, Math.min(COMPUTERS_LIST_MAX_COUNT, Math.trunc(value)));
}

/** Counting never reaches the page: a handler that calls these goes on whatever happens here. */
function quietly(send: () => void): void {
  try {
    send();
  } catch {
    // Not counted.
  }
}

/**
 * A sort key as the events say it: a runtime's `remaining:<provider>` is
 * `remaining` and its provider, apart; "default" is no sort (Mine first).
 * A remaining key whose provider the registry does not list (a provider the
 * web learned before the registry did) is still `remaining`, with no runtime:
 * the sort is said as what it is, and only the part that cannot be said is
 * left out. It is never reported as `default`.
 */
export function computersListSortKey(key: ComputersRackSortKey | "default"): {
  key: ComputersListViewed["sort_key"];
  runtime?: NonNullable<ComputersListViewed["sort_runtime"]>;
} {
  if (key === "default" || key === "name" || key === "disk" || key === "memory") return { key };
  const runtime = COMPUTERS_LIST_SORT_RUNTIMES.find((provider) => key === `remaining:${provider}`);
  return runtime ? { key: "remaining", runtime } : { key: "remaining" };
}

/** The sort the page stands at, for the snapshot: no direction and no runtime where it has none. */
export function computersListSort(sort: ComputersRackSort | null): Pick<ComputersListViewed, "sort_key" | "sort_direction" | "sort_runtime"> {
  if (!sort) return { sort_key: "default" };
  const { key, runtime } = computersListSortKey(sort.key);
  return { sort_key: key, sort_direction: sort.direction, ...(runtime ? { sort_runtime: runtime } : {}) };
}

/** The Computers page showed its list (or that there are no computers): what it stood at. */
export function trackComputersListViewed(viewed: ComputersListViewed): void {
  quietly(() => trackEvent("computers_list_viewed", {
    ...viewed,
    computer_count: count(viewed.computer_count),
    online_count: count(viewed.online_count),
    own_count: count(viewed.own_count),
  }));
}

/** The person changed one control of the Computers page. */
export function trackComputersListControlChanged(changed: ComputersListControlChanged): void {
  quietly(() => trackEvent("computers_list_control_changed", { ...changed, computer_count: count(changed.computer_count) }));
}

/** The person opened a computer from the list. `position`: its place among the rows shown, from 1; left out when not known. */
export function trackComputersListComputerOpened(opened: ComputersListComputerOpened): void {
  const { position, ...rest } = opened;
  quietly(() => trackEvent("computers_list_computer_opened", {
    ...rest,
    ...(position !== undefined && position >= 1 ? { position: Math.max(1, count(position)) } : {}),
  }));
}

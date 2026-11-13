import { useEffect, useRef } from "react";
import { computersListSort, trackComputersListViewed } from "../../analytics/computersList";
import { sidebarMachineTier } from "../../components/layout/sidebarMachineOrder";
import { useLocalComputerIdentitySettled, useLocalComputerMachineId } from "../../components/machine/localComputer/localComputerStore";
import { rackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import { useAuthStore } from "../../store/authStore";
import { useComputersRackFilters } from "../../store/computersRackFilterPreference";
import { readComputersRackSort } from "../../store/computersRackSortPreference";
import { readComputersRackView } from "../../store/computersRackViewPreference";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { effectiveRuntimeFilter, runtimeFilterOptions } from "./computersRackFilter";
import { effectiveRackSort } from "./computersRackSort";
import type { RackVariant } from "./computersRackTypes";

/**
 * `computers_list_viewed`: once each time the Computers page is on screen
 * with a server's list loaded (the "no computers" state too, with counts of
 * 0; not while it loads, not the load-error state), what it stands at: the
 * view, the grouping and the sort kept in this browser, whether a search or a
 * filter was already standing, and how many computers the server has, before
 * any search or filter. Once per stay on a server per mount (it remembers the last server only, so
 * A, B, then A again sends A's twice): a later render, a filter
 * or the side panel sends nothing more; another server on the same mount is
 * another view, sent once that server's list has loaded (the machine store
 * goes back to loading in the same step as the switch, so the counts are
 * never the server before's).
 *
 * Called by the page's toolbar (ComputersRackToolbar), which is on screen
 * exactly as long as the page is, desktop and phone, and not for the phone's
 * attention list. Not by the phone's page itself: that page is in the first
 * download and this reads the rack's filter and sort stores, which are not.
 *
 * It subscribes to when to send (the server, the list's load state, the
 * local identity); what it sends is read from the stores at that moment.
 * On Raft Desktop it waits until which machine the app runs on is settled,
 * so `own_count` counts this device.
 */
export function useComputersListViewed(variant: RackVariant): void {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const loaded = useMachineStore((s) => !s.loading && s.loadStatus === "loaded");
  const identitySettled = useLocalComputerIdentitySettled();
  const localMachineId = useLocalComputerMachineId();
  /** The server the snapshot was last sent for, on this mount. */
  const sentFor = useRef<string | null>(null);
  // Counting on display, with nothing to undo: no cleanup. The ref holds through a re-run (StrictMode, the list loading again).
  useEffect(() => {
    if (!serverId || !loaded || !identitySettled || sentFor.current === serverId) return;
    sentFor.current = serverId;
    const { machines } = useMachineStore.getState();
    const userId = useAuthStore.getState().user?.id ?? null;
    const filters = useComputersRackFilters.getState();
    // The sort and the Runtime filter as they apply: only for runtimes these computers have (as the list reads them).
    const columns = rackRuntimeColumns(machines);
    const runtimes = effectiveRuntimeFilter(filters.runtimes, runtimeFilterOptions(columns));
    trackComputersListViewed({
      variant,
      view: readComputersRackView(),
      group_by: filters.groupBy,
      ...computersListSort(effectiveRackSort(readComputersRackSort(), columns)),
      computer_count: machines.length,
      online_count: machines.filter((machine) => machine.status === "online").length,
      own_count: machines.filter((machine) => sidebarMachineTier(machine, localMachineId, userId) !== 2).length,
      filtered: filters.status !== "all" || runtimes.length > 0,
      searched: filters.query.trim() !== "",
    });
  }, [identitySettled, loaded, localMachineId, serverId, variant]);
}

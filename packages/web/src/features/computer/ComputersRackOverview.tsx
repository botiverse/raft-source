import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Monitor, RefreshCw } from "lucide-react";
import { Button, PanelScrollViewport } from "@botiverse/raft-ui";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useComputersRackView } from "../../store/computersRackViewPreference";
import { useMachineStore } from "../../store/machineStore";
import EmptyState from "../../components/ui/EmptyState";
import PanelHeader from "../../components/ui/PanelHeader";
import { ComputersRackList } from "./ComputersRackList";
import { ComputersRackCounts } from "./ComputersRackCounts";
import { ComputersRackToolbar } from "./ComputersRackToolbar";
import { ComputersAttentionSummary } from "./ComputersAttentionSummary";
import { useThisDeviceListEntry } from "../../components/machine/localComputer/useThisDeviceListEntry";
import { useOpenAddComputer } from "../../components/machine/localComputer/useOpenAddComputer";
import { useRememberComputersRack } from "./computersRackRemembered";

/**
 * Desktop Computers overview: the Computers page, a full page beside the
 * rail; a computer opens in the side panel beside it.
 */
export function ComputersRackOverview() {
  const { formatMessage } = useIntl();
  const view = useComputersRackView();
  const machinesLoading = useMachineStore((s) => s.loading);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const machineCount = useMachineStore((s) => s.machines.length);
  const loadMachines = useMachineStore((s) => s.loadMachines);
  const { capabilities } = useServerPermissions();
  // Add Computer asks where the computer is first (useOpenAddComputer).
  const openAddMachine = useOpenAddComputer();
  // On Raft Desktop the This device row shows even with no computers yet.
  const thisDeviceEntry = useThisDeviceListEntry();
  const loadedEmpty = !machinesLoading && machineLoadStatus === "loaded" && machineCount === 0 && thisDeviceEntry?.kind !== "unattached";
  // An emptied server draws no placeholders next time (the list, which remembers its rows, is not mounted).
  useRememberComputersRack("rows", loadedEmpty ? 0 : null);
  const retryLoadMachines = useCallback(() => {
    void loadMachines();
  }, [loadMachines]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col font-sans" data-testid="computers-rack-overview">
      <PanelHeader
        title={formatMessage({ id: "machine.mobile.title" })}
        titleSuffix={machineCount > 0 ? <ComputersRackCounts className="ml-2" /> : undefined}
      />
      {/* Search, filters, grouping, sort, the view and Add computer (ComputersRackToolbar), above the
          scroller so they stay put while the list scrolls; the head holds only the title and the
          count (Raft DS › Page structure › A page of a list). The toolbar shows with the page, empty or
          errored too, so Add computer is always at its end. */}
      <ComputersRackToolbar onAdd={capabilities.registerMachines ? openAddMachine : undefined} />
      {/* #68: what needs a person and what is waiting, from the server's summary (nothing from an older server). */}
      <ComputersAttentionSummary />
      {/* The page's one scroller, the panel's raft-ui ScrollArea. Both ways:
          a list row's fixed identity and action columns can be wider than a
          narrow window, as with the native scroller before. */}
      <PanelScrollViewport orientation="both" className="flex-1 bg-layer-canvas" data-testid="computers-rack-overview-scroll">
        {/* The phone panel's load-error state, with the same retry. */}
        {!machinesLoading && machineLoadStatus === "error" && machineCount === 0 ? (
          <EmptyState
            className="flex flex-col items-center justify-center py-16"
            icon={<Monitor size={36} />}
            title={formatMessage({ id: "machine.mobile.loadErrorTitle" })}
            description={formatMessage({ id: "machine.mobile.loadErrorDescription" })}
            action={(
              <Button size="md" variant="outline" onClick={retryLoadMachines} data-testid="computers-rack-retry">
                <RefreshCw size={16} />
                {formatMessage({ id: "machine.mobile.retry" })}
              </Button>
            )}
          />
        ) : loadedEmpty ? (
          <EmptyState
            className="flex flex-col items-center justify-center py-16"
            icon={<Monitor size={36} />}
            title={formatMessage({ id: "emptyState.noComputersTitle" })}
            description={formatMessage({ id: "machine.mobile.emptyDescription" })}
          />
        ) : (
          <ComputersRackList variant="desktop" view={view} />
        )}
      </PanelScrollViewport>
    </div>
  );
}

import type { ReactNode } from "react";
import { groupSidebarMachineIds } from "../../../components/layout/sidebarMachineOrder";
import { useThisDeviceListEntry } from "../../../components/machine/localComputer/useThisDeviceListEntry";
import ThisComputerSidebarRow from "../../../components/machine/localComputer/ThisComputerSidebarRow";
import { SidebarCellList } from "../rows/SidebarCellList";
import { ComputerRow } from "./ComputerRow";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * The Computers rail's rows: one list. Inside a host app (Raft Desktop) the
 * machine it runs on always leads (design §4.1): its own machine row, marked
 * "This device" beside its name (ThisDeviceBadge), when it is one of this
 * server's computers; otherwise the This Mac row with Add to this server
 * (ThisComputerSidebarRow). No group headings: one computer needs no
 * section of its own. Without a host it is exactly the rows'
 * SidebarCellList, and `empty` while there are none. Its own component, so a
 * host status change re-renders this list and not the Sidebar.
 */
export function ComputersRailList({ machineIds, isSelected, onSelect, empty }: {
  machineIds: readonly string[];
  isSelected: (machineId: string) => boolean;
  onSelect: (machineId: string, clickCount: number) => void;
  empty: ReactNode;
}) {
  const entry = useThisDeviceListEntry();
  const { thisDevice, others } = groupSidebarMachineIds(machineIds, entry?.kind === "attached" ? entry.machineId : null);
  if (entry?.kind !== "unattached" && machineIds.length === 0) return <>{empty}</>;
  const row = (machineId: string, problem = false) => (
    <ComputerRow key={machineId} machineId={machineId} selected={isSelected(machineId)} onSelect={onSelect} problem={problem} />
  );
  return (
    <SidebarCellList data-testid="computers-rail-list">
      {thisDevice ? row(thisDevice, entry?.host.self.state.problem === true) : null}
      {/* Keyed by server: an add in flight, done or failed belongs to its server. */}
      {entry?.kind === "unattached" ? <ThisComputerSidebarRow key={entry.server.slug} host={entry.host} server={entry.server} /> : null}
      {others.map((machineId) => row(machineId))}
    </SidebarCellList>
  );
}
// Stryker restore all

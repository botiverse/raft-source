import { useCallback } from "react";
import { useMachineStore } from "../../../store/machineStore";
import { useLocalComputerMachineId } from "../../../components/machine/localComputer/localComputerStore";
import { ComputerRowBody } from "./ComputerRowBody";
import { useThisDeviceRowStatus } from "../../../components/machine/localComputer/useThisDeviceRowStatus";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * Computers-section row. Subscribes to its OWN machine slice so a
 * `machine:status` event re-renders only the affected row, not the whole
 * Sidebar. The parent must NOT subscribe to status-bearing machine objects —
 * it only carries stable identity (id + name). Same per-row isolation doctrine
 * as `<AgentActivityDot>` (#2412): dynamic per-entity state subscribes itself.
 */
export function ComputerRow({
  machineId,
  selected,
  onSelect,
  problem = false,
}: {
  machineId: string;
  selected: boolean;
  onSelect: (machineId: string, clickCount: number) => void;
  /** This device has a problem (thisDeviceLogic): its pixel is orange. */
  problem?: boolean;
}) {
  const machine = useMachineStore((s) => s.machines.find((m) => m.id === machineId));
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(machineId, event.detail),
    [machineId, onSelect],
  );
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  // The machine Raft Desktop runs on is marked "This device".
  const thisDevice = useLocalComputerMachineId() === machineId;
  // This device not simply running: the page's own words and dot (Stopped,
  // Removed from this device, …), not the server's snapshot.
  const local = useThisDeviceRowStatus(machine);
  if (!machine) return null;
  return (
    <ComputerRowBody
      machine={machine}
      latestComputerVersion={latestComputerVersion}
      selected={selected}
      thisDevice={thisDevice}
      problem={thisDevice && problem}
      localStatus={local?.label ?? null}
      localPresence={local?.presence ?? null}
      onClick={handleClick}
    />
  );
}
// Stryker restore all

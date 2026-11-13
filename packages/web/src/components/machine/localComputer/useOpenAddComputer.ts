// The Add Computer button (the Computers rail's +, the Computers page). It
// opens Add Computer's dialog, which asks where the computer is first (This
// computer on Raft Desktop / Another computer of my own / Raft-hosted): a
// click never starts installing on its own. A setup of this computer already
// started (Continue in Background) shows its progress again instead.
import { useCallback } from "react";
import { useMachineStore } from "../../../store/machineStore";

export function useOpenAddComputer(): () => void {
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  return useCallback(() => setShowAddMachine(true), [setShowAddMachine]);
}

// What Add Computer does on Raft Desktop for the current server
// (addThisDeviceChoice.ts): connect this computer, or open its page.
import { useMemo } from "react";
import { useMachineStore } from "../../../store/machineStore";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { addComputerOnDesktop } from "./addThisDeviceChoice";
import type { AddComputerOnDesktop } from "./addThisDeviceChoice";

/** Null without a host, and until the bridge and the server's computers have answered. */
export function useAddComputerOnDesktop(host: LocalComputerHost | null): AddComputerOnDesktop | null {
  const machinesLoaded = useMachineStore((s) => !s.loading && s.loadStatus === "loaded");
  const kind = host?.ready ? host.self.state.kind : null;
  const attachedHere = host ? host.self.machineId !== null || !host.self.state.flags.notAttachedHere : false;
  const canAttach = host?.canAttach ?? false;
  return useMemo(() => {
    if (kind === null || kind === "checking" || !machinesLoaded) return null;
    return addComputerOnDesktop({ kind, attachedHere, canAttach });
  }, [attachedHere, canAttach, kind, machinesLoaded]);
}

// "Add to this server" for this computer on Raft Desktop: This device's empty
// state and Create Agent's "Add this Mac" (both say this computer). The click
// itself connects this computer (startAddThisComputer) and Add Computer's
// dialog shows the progress; when this computer is already here, or can't be
// added right now, the click opens This device's page instead. The generic
// Add Computer buttons ask first (useOpenAddComputer: the choice in
// AddMachineDialog), and that choice's This computer runs the same setup.
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { useLocalComputerHost } from "./useLocalComputerHost";
import { useAddComputerOnDesktop } from "./useAddComputerOnDesktop";
import { setupForServer, startAddThisComputer, useAddThisComputerStore } from "./addThisComputerStore";
import type { AddThisComputerThen } from "./addThisComputerStore";
import { thisDevicePath } from "./thisDeviceRoute";

/** `then`: where Done goes ("create-agent": back to Create Agent, which opened it). */
export function useAddThisComputer(then: AddThisComputerThen = "this-device"): () => void {
  const navigate = useNavigate();
  const host = useLocalComputerHost();
  const decision = useAddComputerOnDesktop(host);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const plan = (useServerStore((s) => s.current?.plan) || "free") as ServerPlan;
  const machineCount = useMachineStore((s) => s.machines.length);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const maxMachines = getEffectiveLimits(plan).maxMachines;
  const atLimit = maxMachines !== -1 && machineCount >= maxMachines;
  return useCallback(() => {
    // A setup already started (Continue in Background): show its progress again.
    if (host && setupForServer(useAddThisComputerStore.getState(), serverSlug).phase !== "idle") {
      setShowAddMachine(true);
      return;
    }
    if (host && serverSlug && decision?.kind === "open-this-device") {
      navigate(thisDevicePath(serverSlug, host.self.machineId));
      return;
    }
    if (host && serverSlug && decision?.kind === "connect" && !atLimit) startAddThisComputer(host, serverSlug, then);
    setShowAddMachine(true);
  }, [atLimit, decision, host, navigate, serverSlug, setShowAddMachine, then]);
}

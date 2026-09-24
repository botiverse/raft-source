import { useEffect, useMemo, useRef } from "react";
import { useMachineStore } from "../store/machineStore";
import { resolveComputerConnectionProgress } from "../utils/computerConnectionProgress";
import type { AddMachineConnectionBaseline } from "../utils/addMachineConnection";

const CONNECT_POLL_INTERVAL_MS = 3000;

/**
 * Watches for the computer the user is connecting right now.
 *
 * Shared by the Add Computer dialog and the onboarding setup gate. The UIs of
 * those two differ far too much to share, but the flow underneath is one thing
 * and must behave identically: snapshot the machines that already existed,
 * watch for the row this attempt produces, and report idle → waiting →
 * connected.
 *
 * `machine:*` socket events drive this in the common case. The interval is a
 * fallback for a dropped event — without it a missed event strands the user on
 * "waiting" forever with no way out but a reload, which is exactly what the
 * onboarding gate used to do.
 */
export function useComputerConnectionWatch({
  active,
  pendingMachineId = "",
}: {
  // True while the user is being asked to run the setup command. Going false
  // clears the baseline, so a re-entry starts a fresh attempt.
  active: boolean;
  // A machine row registered up-front (legacy add-machine path). Empty for the
  // Computer setup command, which creates its own row.
  pendingMachineId?: string;
}) {
  const machines = useMachineStore((state) => state.machines);
  const loadMachines = useMachineStore((state) => state.loadMachines);
  const baselineRef = useRef<AddMachineConnectionBaseline[] | null>(null);

  // Snapshot once per attempt, during the render that starts it — deliberately
  // not in an effect. The baseline has to be the machines as they stood *before*
  // the user could have run the command; an effect runs after paint, which lets
  // a `machine:*` event land first and quietly poison the snapshot with the very
  // row we are trying to detect.
  if (active && baselineRef.current === null) {
    baselineRef.current = machines.map((machine) => ({
      id: machine.id,
      status: machine.status,
      isComputer: machine.isComputer,
      computerAttachedByCurrentUser: machine.computerAttachedByCurrentUser,
    }));
  } else if (!active && baselineRef.current !== null) {
    baselineRef.current = null;
  }
  const baseline = baselineRef.current;

  const progress = useMemo(
    () =>
      baseline
        ? resolveComputerConnectionProgress(machines, pendingMachineId, baseline)
        : ({ state: "idle", machine: null, requiresConfirmation: false } as const),
    [machines, pendingMachineId, baseline],
  );

  useEffect(() => {
    if (!active || progress.state === "connected") return;
    const interval = setInterval(() => void loadMachines(), CONNECT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, progress.state, loadMachines]);

  return progress;
}

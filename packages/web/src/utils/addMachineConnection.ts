export interface AddMachineConnectionMachine {
  id: string;
  status: "online" | "offline";
  isComputer?: boolean;
  computerAttachedByCurrentUser?: boolean;
}

export interface AddMachineConnectionBaseline {
  id: string;
  status: "online" | "offline";
  isComputer?: boolean;
  computerAttachedByCurrentUser?: boolean;
}

export type AddMachineConnectionMatchReason =
  | "registered-machine-online"
  | "fresh-single-computer"
  | "resumed-or-ambiguous-computer";

export interface AddMachineConnectionMatch<T extends AddMachineConnectionMachine> {
  machine: T;
  reason: AddMachineConnectionMatchReason;
  requiresConfirmation: boolean;
}

function eligibleComputer<T extends AddMachineConnectionMachine>(machine: T): boolean {
  return Boolean(machine.isComputer) &&
    machine.status === "online" &&
    Boolean(machine.computerAttachedByCurrentUser);
}

function baselineWasEligibleOnline(
  baselineEntry: AddMachineConnectionBaseline | undefined,
): boolean {
  if (!baselineEntry) return false;
  return Boolean(baselineEntry.isComputer) &&
    Boolean(baselineEntry.computerAttachedByCurrentUser) &&
    baselineEntry.status === "online";
}

function baselineEntryFor(
  machine: AddMachineConnectionMachine,
  baseline: AddMachineConnectionBaseline[],
): AddMachineConnectionBaseline | undefined {
  return baseline.find((entry) => entry.id === machine.id);
}

export function resolveAddMachineConnectedMachine<T extends AddMachineConnectionMachine>(
  machines: T[],
  pendingMachineId: string,
  baseline: AddMachineConnectionBaseline[],
): AddMachineConnectionMatch<T> | null {
  const pendingMachine = pendingMachineId ? machines.find((machine) => machine.id === pendingMachineId) : null;
  if (pendingMachine?.status === "online") {
    return {
      machine: pendingMachine,
      reason: "registered-machine-online",
      requiresConfirmation: false,
    };
  }

  const eligibleComputers = machines.filter(eligibleComputer);
  const baselineEligibleOnlineCount = baseline.filter(baselineWasEligibleOnline).length;
  const newOrResumedComputers = eligibleComputers.filter((machine) => {
    const baselineEntry = baselineEntryFor(machine, baseline);
    return !baselineEntry || baselineEntry.status !== "online";
  });

  const selected = newOrResumedComputers[0] ?? null;
  if (!selected) return null;

  const unambiguousFreshComputer = baselineEligibleOnlineCount === 0 &&
    newOrResumedComputers.length === 1 &&
    !baselineEntryFor(selected, baseline);

  return {
    machine: selected,
    reason: unambiguousFreshComputer ? "fresh-single-computer" : "resumed-or-ambiguous-computer",
    requiresConfirmation: !unambiguousFreshComputer,
  };
}

export function findAddMachineConnectedMachine<T extends AddMachineConnectionMachine>(
  machines: T[],
  pendingMachineId: string,
  baseline: AddMachineConnectionBaseline[],
): T | null {
  return resolveAddMachineConnectedMachine(machines, pendingMachineId, baseline)?.machine ?? null;
}

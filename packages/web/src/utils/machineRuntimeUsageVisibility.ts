import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../store/machineStore";

export function canViewMachineRuntimeAccountUsage(
  machine: Machine | null | undefined,
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): boolean {
  if (!machine) return false;
  return machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId)
    || capabilities.editMachines;
}

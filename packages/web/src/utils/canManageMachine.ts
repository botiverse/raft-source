import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../store/machineStore";

/**
 * Whether the current user manages this machine: the person who attached the
 * Computer, its creator, or a role with any machine/agent management
 * capability. The machine detail page gates its management controls on this,
 * and the reinstall notification counts only machines it is true for.
 */
export function canManageMachine(
  machine: Pick<Machine, "computerAttachedByCurrentUser" | "creator">,
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): boolean {
  return machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId)
    || [
      capabilities.editMachines,
      capabilities.controlComputers,
      capabilities.removeMachines,
      capabilities.rotateMachineKeys,
      capabilities.createAgents,
      capabilities.migrateAgents,
    ].some(Boolean);
}

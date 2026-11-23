import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../store/machineStore";

type MachineControllerFields = Pick<Machine, "computerAttachedByCurrentUser" | "controlledByCurrentUser" | "creator">;

/**
 * Whether the current user is this machine's controller, the person the
 * server's routes give its personal authority (computerControllerUserId):
 * the person its live Computer is attached by, and no one else. The server
 * sends it as `controlledByCurrentUser`; the Computer's attacher or creator
 * (also the live attacher) count too, for older server responses without the
 * flag. Never `machine.userId`, and nobody once the key is revoked: then only
 * the server's owners and admins (the capabilities) act on it.
 */
export function isMachineController(
  machine: MachineControllerFields,
  currentUserId: string | null,
): boolean {
  return machine.controlledByCurrentUser === true
    || machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId);
}

/**
 * Whether the current user may restart or upgrade this Computer: the server's
 * `/computer/:action` route accepts the machine's controller (its live
 * attacher) or a role with `controlComputers` (routes/servers.ts
 * canManageMachineResource), and refuses a machine no managed Computer
 * presents now (revoked: `not_a_computer`). `controlledByCurrentUser` counts
 * only while it is a Computer, as an older server sent it after a revoke too.
 * Narrower than canManageMachine, which also passes for agent-creation and
 * other machine capabilities the route refuses.
 */
export function canControlComputer(
  machine: MachineControllerFields & Pick<Machine, "isComputer">,
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): boolean {
  return capabilities.controlComputers
    || machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId)
    || (machine.isComputer === true && machine.controlledByCurrentUser === true);
}

/**
 * Whether the current user manages this machine: its controller
 * (isMachineController), or a role with any machine/agent management
 * capability. The machine detail page gates its management controls on this
 * (rename, description, ...), and the reinstall notification counts only
 * machines it is true for.
 */
export function canManageMachine(
  machine: MachineControllerFields,
  currentUserId: string | null,
  capabilities: ServerCapabilities,
): boolean {
  return isMachineController(machine, currentUserId)
    || [
      capabilities.editMachines,
      capabilities.controlComputers,
      capabilities.removeMachines,
      capabilities.rotateMachineKeys,
      capabilities.createAgents,
      capabilities.migrateAgents,
    ].some(Boolean);
}

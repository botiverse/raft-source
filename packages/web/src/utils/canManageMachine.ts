import type { ServerCapabilities } from "@botiverse/raft-shared";

import type { Machine } from "../store/machineStore";

type MachineControllerFields = Pick<Machine, "computerAttachedByCurrentUser" | "controlledByCurrentUser" | "creator">;

/**
 * Whether the current user is this machine's controller, the person the
 * server's routes give its personal authority (computerControllerUserId):
 * `controlledByCurrentUser`, which still holds after its Computer's key is
 * revoked. The Computer's attacher or creator also count, for older server
 * responses without the flag. Never `machine.userId`: after an adoption the
 * previous owner is refused.
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
 * `/computer/:action` route accepts the machine's controller or a role with
 * `controlComputers` (routes/servers.ts canManageMachineResource), and refuses
 * a machine no managed Computer presents now (revoked: `not_a_computer`), so
 * `controlledByCurrentUser`, which outlives the revoke, counts only while it
 * is a Computer (the attacher and creator fields are set only then). Narrower
 * than canManageMachine, which also passes for agent-creation and other
 * machine capabilities the route refuses.
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

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { ServerCapability, ServerRole } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index";
import { computers as computersTable } from "../db/schema";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { getComputerLinkedMachineIds } from "./computerCredentialService";

/**
 * Who a machine's personal authority belongs to (restart, upgrade, lifecycle
 * operations, workspaces, rename, runtimes, removing it or revoking its key):
 * whoever its Computer is attached by, so an adoption hands it over and the
 * previous machine-row owner keeps none. The live attach record, else the
 * most recent revoked one: revoking the key leaves the row with the person it
 * was attached by (the Computer itself can no longer be controlled, those
 * routes refuse it as not a Computer), so they can still tidy it up or delete
 * it. `machines.userId` only where there has never been an attach record (a
 * raw daemon), or where that record names no one (`attached_by_user_id` null,
 * as #14849 kept it). The web offers the controls on
 * the same fact: the machine list's `controlledByCurrentUser`
 * (computerControllerAttachers, the same order for the whole list), which
 * canControlComputer / canManageMachine accept.
 */
export async function computerControllerUserId(
  executor: DatabaseExecutor,
  serverId: string,
  machine: { id: string; userId: string },
): Promise<string> {
  const [attach] = await executor
    .select({ attachedByUserId: computersTable.attachedByUserId })
    .from(computersTable)
    .where(and(eq(computersTable.serverId, serverId), eq(computersTable.machineId, machine.id)))
    .orderBy(...controllerRecordOrder())
    .limit(1);
  return controllerFromAttacher(attach?.attachedByUserId ?? null, machine);
}

/** The attach record that decides the controller: the live one first, then the most recent revoked one. */
function controllerRecordOrder() {
  return [sql`${computersTable.revokedAt} IS NULL DESC`, desc(computersTable.createdAt)] as const;
}

function controllerFromAttacher(attachedByUserId: string | null, machine: { userId: string }): string {
  return attachedByUserId ?? machine.userId;
}

/**
 * computerControllerUserId for every machine of a server in one query (the
 * machine list): the deciding attach record's attacher per machine id.
 * Resolve a machine with controllerUserIdFromAttachers.
 */
export async function computerControllerAttachers(
  executor: DatabaseExecutor,
  serverId: string,
): Promise<Map<string, string | null>> {
  const rows = await executor
    .selectDistinctOn([computersTable.machineId], {
      machineId: computersTable.machineId,
      attachedByUserId: computersTable.attachedByUserId,
    })
    .from(computersTable)
    .where(and(eq(computersTable.serverId, serverId), isNotNull(computersTable.machineId)))
    .orderBy(computersTable.machineId, ...controllerRecordOrder());
  const attachers = new Map<string, string | null>();
  for (const row of rows) {
    if (row.machineId) attachers.set(row.machineId, row.attachedByUserId);
  }
  return attachers;
}

/** computerControllerUserId from a computerControllerAttachers map. */
export function controllerUserIdFromAttachers(
  attachers: ReadonlyMap<string, string | null>,
  machine: { id: string; userId: string },
): string {
  return controllerFromAttacher(attachers.get(machine.id) ?? null, machine);
}

/** `capability` on the caller's role, or being the machine's controller (computerControllerUserId). */
export async function canManageMachineResource(
  executor: DatabaseExecutor,
  serverId: string,
  callerRole: ServerRole | null,
  userId: string,
  machine: { id: string; userId: string },
  capability: ServerCapability,
): Promise<boolean> {
  if (actorRoleHasServerCapability(callerRole, capability)) return true;
  return await computerControllerUserId(executor, serverId, machine) === userId;
}

/**
 * A machine presented by a managed Computer of this server now: an attached,
 * non-revoked `computers` row. Restart and upgrade are refused otherwise
 * (`not_a_computer`).
 */
export async function isManagedComputerMachine(serverId: string, machineId: string): Promise<boolean> {
  return (await getComputerLinkedMachineIds(serverId)).has(machineId);
}

/**
 * The checks `POST /servers/:id/machines/:machineId/computer/:action` makes
 * for a person, in one call, for a caller that is not that route: the
 * automatic upgrade retry asks them again for the person who asked for the
 * original request. `not_permitted`: not a member of the server now, or
 * neither the person the Computer is attached by nor holding
 * `controlComputers`. `not_a_computer`: the machine is no longer presented by
 * a managed Computer (detached or revoked). Null: allowed. The route uses the
 * same pieces (canManageMachineResource with `controlComputers`,
 * isManagedComputerMachine), so the two cannot drift.
 */
export async function computerControlRefusal(
  serverId: string,
  userId: string,
  machine: { id: string; userId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<"not_permitted" | "not_a_computer" | null> {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role) return "not_permitted";
  if (!await canManageMachineResource(executor, serverId, role, userId, machine, "controlComputers")) return "not_permitted";
  if (!await isManagedComputerMachine(serverId, machine.id)) return "not_a_computer";
  return null;
}

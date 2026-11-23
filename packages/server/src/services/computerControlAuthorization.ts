import { and, eq, isNull } from "drizzle-orm";
import type { ServerCapability, ServerRole } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index";
import { computers as computersTable } from "../db/schema";
import { actorRoleHasServerCapability, getActorServerRoleInServer } from "../lib/actorPermissions";
import { getComputerLinkedMachineAttachers, getComputerLinkedMachineIds } from "./computerCredentialService";

/**
 * Who a machine's personal authority belongs to (restart, upgrade, lifecycle
 * operations, workspaces, rename, runtimes, removing it or revoking its key):
 * one rule, the person its Computer is attached by now. That is the
 * `attached_by_user_id` of the machine's LIVE attach record (the `computers`
 * row for this server and machine with `revoked_at` null), the same person
 * getComputerLinkedMachineAttachers names. An adoption hands it over, and the
 * previous machine-row owner keeps none.
 *
 * Null, no personal controller, when there is no live attach record (its key
 * was revoked, or it is a raw daemon that never had a Computer) or the live
 * record names no one (`attached_by_user_id` null, as #14849 kept it). Then
 * only a role holding the route's capability (the server's owners and admins)
 * may act on it: neither the person a revoked record names nor the machine
 * row's registrant (`machines.userId`) counts.
 *
 * Owner assignment (computerOwnerService "Make it mine") and a registrant's
 * resume of an adoption (computerAdoptionService registrantMayAdoptBySelection)
 * ask the same question. The web offers the controls on the same fact: the
 * machine list's `controlledByCurrentUser` (controllerUserIdFromAttachers over
 * getComputerLinkedMachineAttachers), which canControlComputer /
 * canManageMachine accept.
 */
export async function computerControllerUserId(
  executor: DatabaseExecutor,
  serverId: string,
  machine: { id: string },
): Promise<string | null> {
  const [live] = await executor
    .select({ attachedByUserId: computersTable.attachedByUserId })
    .from(computersTable)
    .where(and(
      eq(computersTable.serverId, serverId),
      eq(computersTable.machineId, machine.id),
      isNull(computersTable.revokedAt),
    ))
    .limit(1);
  return live?.attachedByUserId ?? null;
}

/**
 * computerControllerUserId from a live-attacher map of the whole server
 * (getComputerLinkedMachineAttachers, one query for the machine list): null
 * for a machine without a live attach record, or whose record names no one.
 */
export function controllerUserIdFromAttachers(
  attachers: ReadonlyMap<string, string | null>,
  machine: { id: string },
): string | null {
  return attachers.get(machine.id) ?? null;
}

/**
 * What a person asks to do to one Computer (its machine). Each maps to the
 * server capability that lets a role do it to any Computer
 * (packages/shared/src/serverPermissions.ts; today all four are owner and
 * admin): the matrix stays action-specific, so a role change there applies
 * per action.
 * - `edit`: rename and describe it; scan its workspaces; read its runtime
 *   options, forms, models, sign-in status and account usage; rescan runtimes;
 *   attach its runner log tail to a report. (`editMachines`)
 * - `control`: send it a command: restart, upgrade, start/stop, lifecycle
 *   operations, delete a workspace directory, and its runtimes' sign-in,
 *   sign-out, provider keys, upgrade, install and limit resets.
 *   (`controlComputers`)
 * - `remove`: delete it, revoke its key, ask other agents' owners to move
 *   theirs off. (`removeMachines`)
 * - `rotateKey`: rotate a raw daemon's machine key. (`rotateMachineKeys`)
 */
export type ComputerAction = "edit" | "control" | "remove" | "rotateKey";

const COMPUTER_ACTION_CAPABILITY: Readonly<Record<ComputerAction, ServerCapability>> = {
  edit: "editMachines",
  control: "controlComputers",
  remove: "removeMachines",
  rotateKey: "rotateMachineKeys",
};

/** The person asking, with their role on the Computer's server as just read (null: not a member). */
export interface ComputerActor {
  userId: string;
  role: ServerRole | null;
}

/**
 * The role half of canManageComputer alone: whether `role` may do `action` to
 * any Computer of the server. Only for a decision that deliberately leaves the
 * controller out (owner assignment, where the connector may only claim it).
 */
export function computerRoleAllows(role: ServerRole | null, action: ComputerAction): boolean {
  return actorRoleHasServerCapability(role, COMPUTER_ACTION_CAPABILITY[action]);
}

/**
 * canManageComputer for a caller that has already read the machine's
 * controller (computerControllerUserId, or controllerUserIdFromAttachers for
 * a whole server), e.g. inside a fenced transaction that also audits it.
 */
export function computerActorAllowed(actor: ComputerActor, controllerUserId: string | null, action: ComputerAction): boolean {
  if (computerRoleAllows(actor.role, action)) return true;
  return controllerUserId !== null && controllerUserId === actor.userId;
}

/**
 * THE check for "may this person act on this Computer": every Computer and
 * machine route and service asks it (src/test/computerAuthority.structure
 * .test.ts refuses any other spelling of owner-or-admin there). True for the
 * machine's controller (computerControllerUserId: its live attacher, no one
 * else), or a role holding the capability `action` maps to.
 */
export async function canManageComputer(
  executor: DatabaseExecutor,
  actor: ComputerActor,
  serverId: string,
  machine: { id: string },
  action: ComputerAction,
): Promise<boolean> {
  if (computerRoleAllows(actor.role, action)) return true;
  return computerActorAllowed(actor, await computerControllerUserId(executor, serverId, machine), action);
}

/**
 * Who may see a Computer's runtime accounts (masked) and usage, and what is
 * on it ("On this computer" checks, docs/contracts/computer-checks.md): the
 * person it is attached by now, or a role holding `editMachines` (the `edit`
 * action). One rule for both, so they cannot drift.
 */
export async function canSeeComputerRuntimeAccounts(serverId: string, machineId: string, userId: string): Promise<boolean> {
  const [role, attachers] = await Promise.all([
    getActorServerRoleInServer(serverId, "user", userId),
    getComputerLinkedMachineAttachers(serverId),
  ]);
  return computerActorAllowed({ userId, role }, controllerUserIdFromAttachers(attachers, { id: machineId }), "edit");
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
 * neither the person the live Computer is attached by nor holding
 * `controlComputers`. `not_a_computer`: the machine is no longer presented by
 * a managed Computer (detached or revoked). Null: allowed. The route uses the
 * same pieces (canManageComputer with `control`, isManagedComputerMachine), so
 * the two cannot drift.
 */
export async function computerControlRefusal(
  serverId: string,
  userId: string,
  machine: { id: string },
  executor: DatabaseExecutor = getDb(),
): Promise<"not_permitted" | "not_a_computer" | null> {
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role) return "not_permitted";
  if (!await canManageComputer(executor, { userId, role }, serverId, machine, "control")) return "not_permitted";
  if (!await isManagedComputerMachine(serverId, machine.id)) return "not_a_computer";
  return null;
}

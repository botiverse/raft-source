/**
 * Computer owner v1 (#wg-rbac:#32; tygg, Tenny, Warden): who Raft records as
 * a Computer's owner (`daemons.owner_user_id`). No owner = a Public Computer,
 * the default for every Computer, existing and new: connecting one never sets
 * it. The owner carries no rights in v1 (placing agents, disconnecting,
 * deleting, runtime sign-in and the key-exposure notice stay with the
 * connector or the server's roles): display and transfer only.
 *
 * Who may set it (PUT /api/servers/:id/machines/:machineId/owner,
 * routes/computerOwnerRoutes.ts):
 * - a server owner or admin (`editMachines`): assign, transfer, make Public;
 * - the current owner: transfer to another member, or make it Public;
 * - the connector (who attached the live Computer; for a raw daemon, the
 *   machine row's registrant): only "Make it mine", on a Public Computer.
 * The new owner is a person in this server who is not a Guest (an agent or a
 * personal assistant is never a server member, so it is refused the same way).
 *
 * The owner is a column of the machine row, so a re-adoption (a new
 * `computers` row for the same machine, computerAdoptionService.ts) keeps it.
 * Leaving the server (removeMemberInTransaction) and deleting one's account
 * (accountDeletion/cleanup.ts `clear_computer_ownership`) make the owner's
 * Computers Public. Every change is audited (`computer.owner_changed`); a new
 * owner other than the actor gets a `system_notice`.
 */
import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDate, type ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { computers, machines, serverMembers, users } from "../db/schema";
import { actorRoleHasServerCapability } from "../lib/actorPermissions";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { recordIntegrationAuditEvent, serverAuditContextMetadata, type ServerAuditContext } from "./integrationAuditService";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

/** A Computer owner's public, server-scoped identity (the shape of a Computer's `creator`). */
export interface ComputerOwnerSummary {
  type: "human";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  gravatarHash: string;
}

/** Why an owner changed: a person set it, or the owner went. */
export type ComputerOwnerChangeReason = "transfer" | "claim" | "made_public" | "owner_left_server" | "owner_account_deleted";

export type SetComputerOwnerResult =
  | { ok: true; changed: boolean; machineId: string; machineName: string; previousOwnerUserId: string | null; ownerUserId: string | null }
  | { ok: false; status: 403 | 404 | 400; code: "machine_not_found" | "computer_owner_forbidden" | "computer_owner_ineligible" };

/** Each owned machine's owner on this server, resolved only while they are still a member (else it is Public on read). */
export async function getComputerOwners(serverId: string): Promise<Map<string, ComputerOwnerSummary>> {
  const rows = await getDb()
    .select({
      machineId: machines.id,
      id: users.id,
      name: users.name,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      email: users.email,
    })
    .from(machines)
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, machines.serverId), eq(serverMembers.userId, machines.ownerUserId)))
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(machines.serverId, serverId), isNotNull(machines.ownerUserId)));
  const owners = new Map<string, ComputerOwnerSummary>();
  for (const row of rows) {
    owners.set(row.machineId, {
      type: "human",
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      gravatarHash: createHash("sha256").update(row.email.trim().toLowerCase()).digest("hex"),
    });
  }
  return owners;
}

/**
 * Who connected this machine: the human who attached its live Computer, or,
 * for a raw daemon (no live Computer), the machine row's registrant. The same
 * person the web treats as the connector (`computerAttachedByCurrentUser`,
 * else `userId`).
 */
async function connectorOf(tx: DatabaseExecutor, machine: { id: string; serverId: string; userId: string }): Promise<string | null> {
  const [live] = await tx
    .select({ attachedByUserId: computers.attachedByUserId })
    .from(computers)
    .where(and(eq(computers.machineId, machine.id), eq(computers.serverId, machine.serverId), isNull(computers.revokedAt)))
    .limit(1);
  return live ? live.attachedByUserId : machine.userId;
}

/**
 * Set (or clear, `ownerUserId: null`) a Computer's owner. One transaction:
 * the actor's and the new owner's membership rows FOR SHARE in user-id order
 * (a removal or role change of either waits for this write, or committed
 * first and is seen here), then the machine row FOR UPDATE; authorization and
 * the target's eligibility are decided under those locks. Match the machine
 * and server together before locking, so a foreign machine is never locked.
 */
export async function setComputerOwner(input: {
  serverId: string;
  machineId: string;
  actorUserId: string;
  ownerUserId: string | null;
}): Promise<SetComputerOwnerResult> {
  const { serverId, machineId, actorUserId, ownerUserId } = input;
  return getDb().transaction(async (tx): Promise<SetComputerOwnerResult> => {
    const ids = [...new Set([actorUserId, ...(ownerUserId ? [ownerUserId] : [])])].sort();
    const memberRows = await tx.execute(sql`
      SELECT user_id, role
      FROM server_members
      WHERE server_id = ${serverId}
        AND user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY user_id
      FOR SHARE
    `);
    const roles = new Map((memberRows.rows as Array<{ user_id: string; role: ServerRole }>).map((row) => [row.user_id, row.role]));
    const actorRole = roles.get(actorUserId) ?? null;
    // Not a member: the same answer as a missing Computer (no existence signal).
    if (!actorRole || !actorRoleHasServerCapability(actorRole, "viewMachines")) {
      return actorRole ? { ok: false, status: 403, code: "computer_owner_forbidden" } : { ok: false, status: 404, code: "machine_not_found" };
    }
    const [machine] = await tx
      .select({ id: machines.id, serverId: machines.serverId, userId: machines.userId, name: machines.name, ownerUserId: machines.ownerUserId })
      .from(machines)
      .where(and(eq(machines.id, machineId), eq(machines.serverId, serverId)))
      .for("update");
    if (!machine) return { ok: false, status: 404, code: "machine_not_found" };

    const previousOwnerUserId = machine.ownerUserId;
    const isManager = actorRoleHasServerCapability(actorRole, "editMachines");
    const isOwner = previousOwnerUserId === actorUserId;
    const claimsPublic = previousOwnerUserId === null && ownerUserId === actorUserId
      && (await connectorOf(tx, machine)) === actorUserId;
    if (!isManager && !isOwner && !claimsPublic) return { ok: false, status: 403, code: "computer_owner_forbidden" };

    if (ownerUserId !== null) {
      const role = roles.get(ownerUserId);
      if (!role || role === "guest") return { ok: false, status: 400, code: "computer_owner_ineligible" };
      const [person] = await tx.select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, ownerUserId));
      if (!person || person.retiredAt) return { ok: false, status: 400, code: "computer_owner_ineligible" };
    }

    if (previousOwnerUserId === ownerUserId) {
      return { ok: true, changed: false, machineId, machineName: machine.name, previousOwnerUserId, ownerUserId };
    }
    await tx.update(machines).set({ ownerUserId }).where(eq(machines.id, machineId));
    const reason: ComputerOwnerChangeReason = ownerUserId === null
      ? "made_public"
      : previousOwnerUserId === null && ownerUserId === actorUserId && !isManager ? "claim" : "transfer";
    await recordOwnerChange(tx, {
      serverId,
      machine: { id: machineId, name: machine.name },
      previousOwnerUserId,
      ownerUserId,
      reason,
      actorUserId,
      audit: { actorRole },
    });
    return { ok: true, changed: true, machineId, machineName: machine.name, previousOwnerUserId, ownerUserId };
  });
}

async function recordOwnerChange(tx: DatabaseExecutor, input: {
  serverId: string;
  machine: { id: string; name: string };
  previousOwnerUserId: string | null;
  ownerUserId: string | null;
  reason: ComputerOwnerChangeReason;
  actorUserId: string | null;
  audit: ServerAuditContext;
}): Promise<void> {
  const subjectId = input.ownerUserId ?? input.previousOwnerUserId;
  await recordIntegrationAuditEvent({
    serverId: input.serverId,
    eventType: "computer.owner_changed",
    outcome: "success",
    source: input.actorUserId ? "web" : "system",
    actor: input.actorUserId ? { type: "human", id: input.actorUserId } : { type: "system" },
    subject: subjectId ? { type: "human", id: subjectId } : null,
    target: { type: "machine", id: input.machine.id },
    metadata: {
      machineId: input.machine.id,
      machineName: input.machine.name,
      previousOwnerUserId: input.previousOwnerUserId,
      ownerUserId: input.ownerUserId,
      reason: input.reason,
      ...serverAuditContextMetadata(input.audit),
    },
  }, tx);
}

/**
 * The owner went: every Computer they own (on `serverId`, or on every server
 * when it is null, for an account deletion) becomes Public, each audited.
 * Runs in the caller's transaction, after it locked the member row (removal)
 * so the lock order stays servers -> member rows -> resource rows.
 */
export async function clearComputerOwnershipOf(tx: DatabaseExecutor, input: {
  userId: string;
  serverId: string | null;
  reason: "owner_left_server" | "owner_account_deleted";
  actorUserId: string | null;
  audit?: ServerAuditContext;
}): Promise<string[]> {
  const cleared = await tx
    .update(machines)
    .set({ ownerUserId: null })
    .where(and(
      eq(machines.ownerUserId, input.userId),
      ...(input.serverId ? [eq(machines.serverId, input.serverId)] : []),
    ))
    .returning({ id: machines.id, name: machines.name, serverId: machines.serverId });
  for (const machine of cleared) {
    await recordOwnerChange(tx, {
      serverId: machine.serverId,
      machine,
      previousOwnerUserId: input.userId,
      ownerUserId: null,
      reason: input.reason,
      actorUserId: input.actorUserId,
      audit: input.audit ?? {},
    });
  }
  return cleared.map((machine) => machine.id);
}

/**
 * Tell the new owner, when someone else made them the owner. One
 * `system_notice` outbox row: every device, their server level, quiet hours
 * and preview setting apply. Plain English title and body with no copy key
 * (as the two-step recovery notice): a new key would reach mobile apps whose
 * string tables do not have it. Tapping opens Activity. Best effort, after
 * commit: never throws.
 */
export async function notifyNewComputerOwner(input: {
  serverId: string;
  machineId: string;
  machineName: string;
  ownerUserId: string;
  actorUserId: string;
}): Promise<void> {
  if (input.ownerUserId === input.actorUserId) return;
  try {
    const payload: NotificationNoticePayload = {
      title: "You’re now a Computer’s owner",
      body: `Raft now records you as the owner of ${input.machineName}. Its sign-ins and credentials stay those of whoever is signed in on it.`,
      kind: "mention",
      event: "system_notice",
      route: { type: "channel", serverId: input.serverId, channelId: "", messageId: null },
      opensActivity: true,
    };
    const now = currentDate();
    await enqueueNotificationRows([{
      receiverId: input.ownerUserId,
      serverId: input.serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: now,
      personalMention: true,
      eventKey: `computer_owner:${input.machineId}:${input.ownerUserId}:${now.getTime()}`,
      category: "system_notice",
      payload: payload as unknown as Record<string, unknown>,
    }]);
  } catch (err) {
    console.error(`[computer-owner] notice to ${input.ownerUserId} failed:`, serializeErrorForLog(err));
  }
}

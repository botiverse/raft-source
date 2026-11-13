/**
 * The agents bound to a Computer's machine (`agents.daemon_id`), as the two
 * ways a person takes a Computer away see them: asking to delete their account
 * (accountDeletion/requests.ts) and revoking one Computer's key, from the web
 * (POST /servers/:id/machines/:machineId/revoke-computer-key) or from the
 * Computer itself (`raft-computer detach`, POST /internal/computer/detach;
 * Tenny, #triage:d10ace06 msg=670f6e97). Someone else's
 * live agent on it blocks either (artin/Tenny 2026-11-04, #triage:d10ace06):
 * the person asks its owner to move it (ownerNotices.ts), or names it to force
 * the removal, which unbinds and stops it here.
 *
 * And whether a machine still takes agents (machineTakesAgents): binding an
 * agent to a machine whose Computer key was revoked would leave it offline on
 * a Computer that can never come back under that key.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { DatabaseExecutor } from "../db/index";
import { agents, computers, machines, serverMembers, users } from "../db/schema";
import { revokeRunnerCredentialsOffMachine } from "./agentCredentialService";

/** The person an agent belongs to (agentOwnerSql): who is asked to move it, and told when it is unbound. */
export type AgentOwner = { id: string; name: string };

/**
 * The person an agent belongs to: for a personal assistant the person it
 * assists, else the user who created it (none when an agent created it). The
 * owner reads as null (nobody to ask or tell) when that person is retired or
 * no longer a member of the agent's server (findAgentsBoundToMachines' join).
 */
export const agentOwnerSql = sql<string | null>`coalesce(${agents.assistantOwnerUserId}, case when ${agents.creatorType} = 'user' then ${agents.creatorId} end)`;

/**
 * The person one live agent belongs to (agentOwnerSql), by the same rule as
 * findAgentsBoundToMachines: null when there is none, or when that person is
 * retired or no longer a member of the agent's server.
 */
export async function findAgentOwner(executor: DatabaseExecutor, agentId: string): Promise<AgentOwner | null> {
  const [row] = await executor.select({
    ownerId: users.id,
    ownerName: sql<string | null>`coalesce(${users.displayName}, ${users.name})`,
  })
    .from(agents)
    .innerJoin(users, and(
      eq(users.id, agentOwnerSql),
      isNull(users.retiredAt),
      sql`exists (select 1 from ${serverMembers} where ${serverMembers.serverId} = ${agents.serverId} and ${serverMembers.userId} = ${users.id})`,
    ))
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
  return row ? { id: row.ownerId, name: row.ownerName ?? "" } : null;
}

/**
 * A live agent bound to one of the machines. `ownedByActor`: the actor created
 * it or it is their personal assistant; anyone else's (another person's, or
 * one an agent created) blocks taking the Computer away.
 */
export type BoundAgent = {
  id: string;
  name: string;
  machineId: string;
  ownedByActor: boolean;
  owner: AgentOwner | null;
  personalAssistant: boolean;
};

/** The live agents bound to these machines, by name, each with its owner as seen by `actorUserId`. */
export async function findAgentsBoundToMachines(executor: DatabaseExecutor, machineIds: readonly string[], actorUserId: string): Promise<BoundAgent[]> {
  if (machineIds.length === 0) return [];
  const rows = await executor.select({
    id: agents.id,
    name: agents.name,
    displayName: agents.displayName,
    machineId: agents.machineId,
    ownedByActor: sql<boolean>`((${agents.creatorType} = 'user' and ${agents.creatorId} = ${actorUserId}) or coalesce(${agents.assistantOwnerUserId} = ${actorUserId}, false))`,
    personalAssistant: sql<boolean>`(${agents.assistantOwnerUserId} is not null)`,
    ownerId: users.id,
    ownerName: sql<string | null>`coalesce(${users.displayName}, ${users.name})`,
  })
    .from(agents)
    .leftJoin(users, and(
      eq(users.id, agentOwnerSql),
      isNull(users.retiredAt),
      sql`exists (select 1 from ${serverMembers} where ${serverMembers.serverId} = ${agents.serverId} and ${serverMembers.userId} = ${users.id})`,
    ))
    .where(and(inArray(agents.machineId, [...machineIds]), isNull(agents.deletedAt)))
    .orderBy(agents.name, agents.id);
  return rows.map((row) => ({
    id: row.id,
    name: row.displayName || row.name,
    machineId: row.machineId!,
    ownedByActor: Boolean(row.ownedByActor),
    owner: row.ownerId ? { id: row.ownerId, name: row.ownerName ?? "" } : null,
    personalAssistant: Boolean(row.personalAssistant),
  }));
}

/** Someone else's agent on the machine the actor is taking away: what the 409 `others_agents_on_computer` lists (with the notice times, ownerNotices.ts). */
export type OthersAgentOnMachine = { id: string; name: string; owner: AgentOwner | null; personalAssistant: boolean };

/** The live agents on this machine that are not the actor's own (findAgentsBoundToMachines). */
export async function findOthersAgentsOnMachine(executor: DatabaseExecutor, machineId: string, actorUserId: string): Promise<OthersAgentOnMachine[]> {
  return (await findAgentsBoundToMachines(executor, [machineId], actorUserId))
    .filter((agent) => !agent.ownedByActor)
    .map(({ id, name, owner, personalAssistant }) => ({ id, name, owner, personalAssistant }));
}

/** Why an agent was taken off its Computer to stay off (`agents.machine_release_reason`). */
export type MachineReleaseReason = "forced_by_computer_owner";

// Every UPDATE that binds an agent to a machine on purpose (a move's flip
// and arrival, a conversion, a revert) writes machineReleaseReason and
// machineReleasedAt as null in its own .set({...}) literal, so the agent may be
// auto-assigned again. They are written out, not spread from a constant, so the
// agent-write contract test (agentProfileWriteBroadcastContract) can read them.

/**
 * Unbinds live agents from these machines and stops them, as removing a
 * Computer does to the agents still on it: `daemon_id` cleared, `stopped`
 * (no message wakes it) until its owner moves it to another computer. With
 * `release` (a person forced someone else's agents off: the web revoke, the
 * account deletion), `machine_release_reason` and `machine_released_at` are
 * set too: the machine-online auto-assign (agentService.ts autoAssignMachine)
 * skips the agent until an explicit bind clears them (Tenny, PR #12858). The
 * agent itself stays: its messages, settings and memberships. Its runner
 * credentials are revoked (revokeRunnerCredentialsOffMachine). With
 * `agentIds`, only those. Returns the ids unbound.
 */
export async function unbindAndStopAgents(
  tx: DatabaseExecutor,
  input: { machineIds: readonly string[]; agentIds?: readonly string[]; now: Date; release?: MachineReleaseReason },
): Promise<string[]> {
  if (input.machineIds.length === 0 || input.agentIds?.length === 0) return [];
  const rows = await tx.update(agents)
    .set({
      machineId: null,
      status: "stopped",
      updatedAt: input.now,
      ...(input.release ? { machineReleaseReason: input.release, machineReleasedAt: input.now } : {}),
    })
    .where(and(
      inArray(agents.machineId, [...input.machineIds]),
      isNull(agents.deletedAt),
      input.agentIds ? inArray(agents.id, [...input.agentIds]) : undefined,
    ))
    .returning({ id: agents.id });
  const unboundIds = rows.map((row) => row.id);
  // On no Machine now: the runner credentials any Machine minted go too.
  await revokeRunnerCredentialsOffMachine(tx, { agentIds: unboundIds, machineId: null, now: input.now });
  return unboundIds;
}

/** Refused: someone else's live agents are on the Computer being taken away and the caller did not name them all (409 `others_agents_on_computer`). */
export class OthersAgentsOnComputerError extends Error {
  readonly code = "others_agents_on_computer";
  constructor(readonly agents: OthersAgentOnMachine[]) {
    super("others_agents_on_computer");
    this.name = "OthersAgentsOnComputerError";
  }
}

/**
 * The gate on taking one Computer away (the web revoke, `raft-computer
 * detach`), in the revoke's transaction, after the machine row is locked FOR
 * UPDATE: someone else's live agents on the machine, as `attacherUserId` (the
 * person who attached it) sees them, refuse it (OthersAgentsOnComputerError,
 * the full fresh list) unless `forceAgentIds` names every one of them; then
 * they are unbound and stopped with the release marker (unbindAndStopAgents).
 * Returns the agents unbound; the caller audits them and, after commit,
 * tells their owners.
 */
export async function unbindForcedOthersAgents(
  tx: DatabaseExecutor,
  input: { machineId: string; attacherUserId: string; forceAgentIds: readonly string[]; now: Date },
): Promise<OthersAgentOnMachine[]> {
  const othersAgents = await findOthersAgentsOnMachine(tx, input.machineId, input.attacherUserId);
  const forced = new Set(input.forceAgentIds);
  if (othersAgents.some((agent) => !forced.has(agent.id))) throw new OthersAgentsOnComputerError(othersAgents);
  const unboundIds = new Set(await unbindAndStopAgents(tx, {
    machineIds: [input.machineId],
    agentIds: othersAgents.map((agent) => agent.id),
    now: input.now,
    release: "forced_by_computer_owner",
  }));
  return othersAgents.filter((agent) => unboundIds.has(agent.id));
}

/** `daemons.id`, table-qualified even where drizzle would print a bare column. */
const machineIdColumn = sql`${sql.identifier("daemons")}.${sql.identifier("id")}`;

/**
 * Whether the `machines` row in the query's FROM still takes agents: its own
 * legacy key is not revoked (`api_key_hash` 'revoked:...', account deletion)
 * and it has a live `computers` row, or none at all (a legacy `sk_machine_*`
 * machine, attached by its own key). The same test as an attached Computer in
 * accountDeletion/requests.ts. A machine that is merely offline still takes
 * agents; only a revoked one does not.
 */
export const machineRowTakesAgentsSql: SQL = sql`(
  ${machines.apiKeyHash} not like 'revoked:%'
  and (
    not exists (select 1 from ${computers} where ${computers.machineId} = ${machineIdColumn})
    or exists (select 1 from ${computers} where ${computers.machineId} = ${machineIdColumn} and ${computers.revokedAt} is null)
  )
)`;

/** Refused: binding an agent to a machine whose Computer key was revoked (machineRowTakesAgentsSql). */
export class MachineKeyRevokedError extends Error {
  readonly code = "computer_key_revoked";
  constructor() {
    super("This computer was detached: its key was revoked. Attach it again, or choose another computer.");
    this.name = "MachineKeyRevokedError";
  }
}

/**
 * Reconciler step 15 (B15): the machines among `machineIds` whose Computer
 * access was revoked: the row exists and no longer takes agents
 * (machineRowTakesAgentsSql). Derived, never stored: the agents stay bound
 * (Tenny Q-7), so moving them or a key that is live again clears it. A
 * re-attach makes a new machine row (computerCredentialService.attachComputer),
 * so this one stays revoked until its agents are moved. One query per call.
 */
export async function findAccessRevokedMachineIds(executor: DatabaseExecutor, machineIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(machineIds)];
  if (ids.length === 0) return new Set();
  const rows = await executor.select({ id: machines.id }).from(machines)
    .where(and(inArray(machines.id, ids), sql`not ${machineRowTakesAgentsSql}`));
  return new Set(rows.map((row) => row.id));
}

/**
 * Refused: a personal assistant (agents.assistant_owner_user_id set) never has
 * a machine. It runs hosted; every agent on a Computer shares one OS user, so
 * an assistant there would share its owner's private surfaces with the other
 * agents on it. The CHECK agents_assistant_not_on_machine holds the same rule
 * in the database; every write path refuses with this first.
 */
export class AssistantCannotUseComputerError extends Error {
  readonly code = "assistant_cannot_use_computer";
  constructor() {
    super("A personal assistant runs hosted and can't be placed on a Computer.");
    this.name = "AssistantCannotUseComputerError";
  }
}

/** Whether the machine takes agents now (machineRowTakesAgentsSql); false for no such machine. */
export async function machineTakesAgents(executor: DatabaseExecutor, machineId: string): Promise<boolean> {
  const [row] = await executor.select({ id: machines.id }).from(machines)
    .where(and(eq(machines.id, machineId), machineRowTakesAgentsSql));
  return Boolean(row);
}

/**
 * Before binding an agent to a machine, in the binding's transaction: takes
 * the machine row FOR SHARE, then checks it still takes agents
 * (MachineKeyRevokedError when not). A revoke holds the row FOR UPDATE until
 * it commits (the web revoke and the account deletion request both do), so a
 * bind either commits first, and the revoke sees the agent, or waits and
 * then sees the key revoked. The check is its own statement after the lock,
 * so it reads what the revoke committed. No such machine: nothing to check
 * (the foreign key refuses it).
 */
export async function lockMachineTakingAgents(tx: DatabaseExecutor, machineId: string): Promise<void> {
  const [row] = await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, machineId)).for("share");
  if (!row) return;
  if (!await machineTakesAgents(tx, machineId)) throw new MachineKeyRevokedError();
}

/**
 * lockMachineTakingAgents for a binding the system makes on its own (the
 * machine-online auto-assign, a failed hosted move's way back, a move's flip):
 * the same FOR SHARE lock, then false (bind nothing) when the machine is gone
 * or its key was revoked, rather than an error.
 */
export async function lockMachineIfTakesAgents(tx: DatabaseExecutor, machineId: string): Promise<boolean> {
  const [row] = await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, machineId)).for("share");
  return Boolean(row) && await machineTakesAgents(tx, machineId);
}

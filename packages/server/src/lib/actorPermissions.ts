import { canChangeMemberRole, hasServerCapability, type ManageableServerRole, type ServerCapability, type ServerRole } from "@botiverse/raft-shared";
import * as serverService from "../services/serverService.js";
import { getDb, type DatabaseExecutor } from "../db/index.js";

export type ActorContext =
  | {
    type: "user";
    id: string;
    serverId: string;
    serverRole: ServerRole | null;
  }
  | {
    type: "agent";
    id: string;
    serverId: string;
    serverRole: ServerRole | null;
  };

export type ActorContextType = ActorContext["type"];

export async function resolveActorContext(
  serverId: string,
  actorType: ActorContextType,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ActorContext> {
  const serverRole = actorType === "agent"
    ? await serverService.getAgentMemberRole(serverId, actorId, executor)
    : await serverService.getMemberRole(serverId, actorId, executor);

  return {
    type: actorType,
    id: actorId,
    serverId,
    serverRole,
  };
}

export function actorHasServerCapability(actor: ActorContext, capability: ServerCapability): boolean {
  return hasServerCapability(actor.serverRole, capability);
}

export function actorRoleHasServerCapability(role: ServerRole | null | undefined, capability: ServerCapability): boolean {
  return hasServerCapability(role, capability);
}

export function actorCanChangeServerMemberRole(
  actorRole: ServerRole | null | undefined,
  targetRole: ServerRole | null | undefined,
  nextRole: ManageableServerRole,
): boolean {
  return canChangeMemberRole(actorRole, targetRole, nextRole);
}

export async function getActorServerRoleInServer(
  serverId: string,
  actorType: ActorContextType,
  actorId: string,
): Promise<ServerRole | null> {
  return (await resolveActorContext(serverId, actorType, actorId)).serverRole;
}

export async function actorHasServerCapabilityInServer(
  serverId: string,
  actorType: ActorContextType,
  actorId: string,
  capability: ServerCapability,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  return actorHasServerCapability(
    await resolveActorContext(serverId, actorType, actorId, executor),
    capability,
  );
}

/**
 * Human creators keep manager authority over the Agent they created even
 * after their server role is reduced to member. Route-level server membership
 * remains an upstream precondition; this helper does not authorize a removed
 * user back into the server.
 */
export function userCanActOnAgentResource(
  callerRole: ServerRole | null | undefined,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null },
  capability: ServerCapability,
): boolean {
  return hasServerCapability(callerRole, capability)
    || (agent.creatorType === "user" && agent.creatorId === userId);
}

/** Which policy branch authorized a human -> agent read-frontier delegation.
 *  Records the policy BRANCH, not how the capability was obtained: owner/admin
 *  is the SOURCE of `editAgents`, not a separate basis here. */
export type ReadStateDelegationBasis = "server_manage_agents" | "agent_creator";

export interface ReadStateDelegationDecision {
  allowed: boolean;
  basis: ReadStateDelegationBasis | null;
}

/** Pure human -> agent read-frontier delegation policy. Reuses the
 *  agent-private-surface policy (`editAgents` capability OR agent creator) as
 *  an explicit read-frontier MUTATION authority — writing an agent receiver's
 *  unread/Done frontier is a write, not ordinary inspect. Stable basis priority
 *  is `server_manage_agents` over `agent_creator` so a caller satisfying both
 *  never jitters the trace. `creator` counts only when creatorType === "user".
 *  Fail-closed: a caller who is neither capable nor the creator is denied with
 *  a null basis.
 *
 *  MEMBERSHIP PREMISE (Bugen review): the creator branch does NOT independently
 *  check server membership — a null-role creator (removed from, or never in, the
 *  server) is allowed here, exactly mirroring canInspectAgentPrivateSurfaces.
 *  That is safe only because the read-all route sits under requireServer, which
 *  validates non-deleted membership before this authority runs. A standalone
 *  reuser of this pure policy MUST enforce the caller's server membership
 *  itself; the boundary lives upstream, not in this function. */
export function decideReadStateDelegation(input: {
  callerServerRole: ServerRole | null;
  userId: string;
  agent: { creatorType: string | null; creatorId: string | null };
}): ReadStateDelegationDecision {
  if (hasServerCapability(input.callerServerRole, "editAgents")) {
    return { allowed: true, basis: "server_manage_agents" };
  }
  if (input.agent.creatorType === "user" && input.agent.creatorId === input.userId) {
    return { allowed: true, basis: "agent_creator" };
  }
  return { allowed: false, basis: null };
}

/** Resolve the caller's server role and decide a human -> agent read-frontier
 *  delegation. Serves ONLY human callers writing an agent receiver; the agent
 *  credential/self path never produces a delegation_basis (receiver=self). The
 *  receiver's own legitimacy as a read principal is a SEPARATE kinded-sequencer
 *  membership check — this authority does not substitute for it. */
export async function canHumanOperateAgentReadState(
  serverId: string,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null },
): Promise<ReadStateDelegationDecision> {
  const callerServerRole = await getActorServerRoleInServer(serverId, "user", userId);
  return decideReadStateDelegation({ callerServerRole, userId, agent });
}

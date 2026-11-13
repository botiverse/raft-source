import { canChangeAgentMemberRole, hasServerCapability, isAdminOrOwner, isGuestRole, type ManageableServerRole, type ServerCapability, type ServerRole } from "@botiverse/raft-shared";
import * as serverService from "../services/serverService";
import { getDb, type DatabaseExecutor } from "../db/index";

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

const SERVER_ROLES = ["owner", "admin", "member", "guest"] as const satisfies readonly ServerRole[];

/** The server roles that hold `capability`: who on a server has it, for a roster read (`role IN (...)`). */
export function serverRolesWithCapability(capability: ServerCapability): ServerRole[] {
  return SERVER_ROLES.filter((role) => hasServerCapability(role, capability));
}

/** An agent's server role: as a person's, and an admin may also demote an admin agent (canChangeAgentMemberRole). */
export function actorCanChangeAgentServerMemberRole(
  actorRole: ServerRole | null | undefined,
  targetRole: ServerRole | null | undefined,
  nextRole: ManageableServerRole,
): boolean {
  return canChangeAgentMemberRole(actorRole, targetRole, nextRole);
}

export async function getActorServerRoleInServer(
  serverId: string,
  actorType: ActorContextType,
  actorId: string,
): Promise<ServerRole | null> {
  return (await resolveActorContext(serverId, actorType, actorId)).serverRole;
}

/**
 * getActorServerRoleInServer for a list of agents, in one query: roster
 * routes read every listed agent's role, and one query per agent under
 * Promise.all borrowed a pool connection each.
 */
export async function getAgentServerRolesInServer(
  serverId: string,
  agentIds: readonly string[],
): Promise<Map<string, ServerRole>> {
  return serverService.getAgentMemberRoles(serverId, agentIds);
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

export type AgentResourceDecision ="allowed" | "forbidden" | "assistant_owner_only";

export type AgentResourceAuthoritySubject = {
  creatorType: string | null;
  creatorId: string | null;
  assistantOwnerUserId: string | null;
  /** Set by `withAssistantOwnerMembership`; unset counts as a member. */
  assistantOwnerIsMember?: boolean;
};

/** Adds whether an assistant's owner is still a member of `serverId` (only deletion depends on it). */
export async function withAssistantOwnerMembership<A extends { assistantOwnerUserId: string | null }>(
  serverId: string,
  agent: A,
  executor: DatabaseExecutor = getDb(),
): Promise<A & { assistantOwnerIsMember?: boolean }> {
  if (!agent.assistantOwnerUserId) return agent;
  return { ...agent, assistantOwnerIsMember: Boolean(await serverService.getMemberRole(serverId, agent.assistantOwnerUserId, executor)) };
}

/**
 * The one decision for acting on an agent, used both at route entry and again
 * inside the actor membership fence.
 *
 * Ordinary agent: the capability, or its human creator (creators keep manager
 * authority after their role is reduced to member).
 *
 * Personal assistant (RFC 075): its lifecycle is its owner's alone, with no
 * capability or creator override (`assistant_owner_only`). The single
 * exception is `stop`: a server owner/admin may stop any assistant as a
 * safety switch (the caller notifies the owner and records it).
 *
 * `assistantOwnerUserId` is required so no caller can pass a row that silently
 * drops it. Route-level server membership remains an upstream precondition;
 * this helper does not authorize a removed user back into the server.
 */
export function decideAgentResourceAuthority(
  callerRole: ServerRole | null | undefined,
  userId: string,
  agent: AgentResourceAuthoritySubject,
  capability: ServerCapability,
  options: { stop?: boolean } = {},
): AgentResourceDecision {
  if (agent.assistantOwnerUserId) {
    if (agent.assistantOwnerUserId === userId && callerRole) return "allowed";
    if (options.stop && isAdminOrOwner(callerRole)) return "allowed";
    // Its owner left the server and it was archived with them: a server
    // owner/admin may clean it up (delete), nothing else.
    if (agent.assistantOwnerIsMember === false && capability === "deleteAgents" && hasServerCapability(callerRole, "deleteAgents")) {
      return "allowed";
    }
    return "assistant_owner_only";
  }
  return hasServerCapability(callerRole, capability)
    || (agent.creatorType === "user" && agent.creatorId === userId)
    ? "allowed"
    : "forbidden";
}

export function userCanActOnAgentResource(
  callerRole: ServerRole | null | undefined,
  userId: string,
  agent: AgentResourceAuthoritySubject,
  capability: ServerCapability,
  options: { stop?: boolean } = {},
): boolean {
  return decideAgentResourceAuthority(callerRole, userId, agent, capability, options) === "allowed";
}

/**
 * Default-deny visibility rule for everything beyond an agent's public Profile
 * tab: only the agent's human creator and users whose current server role has
 * `editAgents` (owner / admin) may see its private surfaces (workspace,
 * activity, DMs, reminders, skills, ...). `callerRole` must be the caller's
 * current role in the agent's server; membership itself is an upstream
 * precondition, exactly as for userCanActOnAgentResource.
 *
 * A personal assistant (RFC 075 v4) is the exception: its activity and
 * workspace hold what it read in its owner's private conversations, so only
 * the owner may see them, with no admin override.
 */
export function roleCanInspectAgentPrivateSurfaces(
  callerRole: ServerRole | null | undefined,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
): boolean {
  return userCanActOnAgentResource(callerRole, userId, agent, "editAgents");
}

/**
 * View Context (status, view, who viewed): the private-surface rule, and never
 * a Guest, even one recorded as the agent's creator (legacy rows). One check
 * for every View Context route and the result relay's re-check, so they cannot
 * drift. Reads the caller's role fresh on every call.
 */
export async function canViewAgentContext(
  serverId: string,
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
): Promise<boolean> {
  const callerRole = await getActorServerRoleInServer(serverId, "user", userId);
  // Membership is read here, not assumed: the result-time re-check runs outside
  // requireServer, and the creator rule alone would pass someone who has left.
  if (!callerRole || callerRole === "guest") return false;
  return roleCanInspectAgentPrivateSurfaces(callerRole, userId, agent);
}

/**
 * Authority over a tenant-level account connector (e.g. a server's GitHub
 * connection shared by several agents): its creator or a server owner/admin
 * may assign it to an agent or disconnect it; guests never, even as creator.
 * Returns the acting role Raft vouches for to the provider, or null (refuse).
 * Stable priority: `creator` over `admin`, so the provider can re-check it.
 * Managing the agent itself is a separate, additional precondition.
 */
export function decideAgentConnectorAuthority(
  callerRole: ServerRole | null | undefined,
  userId: string,
  connectorCreatorId: string | null,
): "creator" | "admin" | null {
  if (!callerRole || isGuestRole(callerRole)) return null;
  if (connectorCreatorId !== null && connectorCreatorId === userId) return "creator";
  if (isAdminOrOwner(callerRole)) return "admin";
  return null;
}

/**
 * Whether an agent may be bound to a connector: a connection carries the identity of whoever signed
 * it in, so only its creator's own agent may act with it. Being a server admin doesn't change that;
 * admins can still disconnect one. An agent with no owner, or a connector with no recorded creator,
 * can't be bound. Same rule as MCP Apps' mcpConnectionUsableByAgent, which also has a shared default.
 */
export function connectorAssignableToAgent(connectorCreatorId: string | null, agentOwnerUserId: string | null): boolean {
  return agentOwnerUserId !== null && connectorCreatorId !== null && connectorCreatorId === agentOwnerUserId;
}

/** Which policy branch authorized a human -> agent read-frontier delegation.
 *  Records the policy BRANCH, not how the capability was obtained: owner/admin
 *  is the SOURCE of `editAgents`, not a separate basis here. */
export type ReadStateDelegationBasis = "server_manage_agents" | "agent_creator" | "assistant_owner";

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
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null };
}): ReadStateDelegationDecision {
  // A personal assistant's read position is its owner's alone to move (moving it
  // would hide the owner's messages from the assistant): the one agent decision.
  if (input.agent.assistantOwnerUserId) {
    return decideAgentResourceAuthority(input.callerServerRole, input.userId, input.agent, "editAgents") === "allowed"
      ? { allowed: true, basis: "assistant_owner" }
      : { allowed: false, basis: null };
  }
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
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
): Promise<ReadStateDelegationDecision> {
  const callerServerRole = await getActorServerRoleInServer(serverId, "user", userId);
  return decideReadStateDelegation({ callerServerRole, userId, agent });
}

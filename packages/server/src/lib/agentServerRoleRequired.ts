import { minimumServerRoleWithCapability, type ServerCapability, type ServerRole } from "@botiverse/raft-shared";
import { getActorServerRoleInServer } from "./actorPermissions";
import type { RefusalInput, RefusalStatus } from "./refusal";

export const AGENT_SERVER_ROLE_REQUIRED_CODE = "server_role_required";

/**
 * What an agent's channel or server-profile service answers its routes
 * (internalAgentApi.ts and the legacy internal.ts): a success body, a refusal
 * the route answers with refuse(), or a body kept in its own shape (a 500, the
 * archived-name pair that must not reveal a hidden channel) that the route
 * writes as it is.
 */
export type AgentRouteResult<Body = Record<string, unknown>> =
  | { ok: true; status: 200; body: Body }
  | { ok: false; status: RefusalStatus; refusal: RefusalInput }
  | { ok: false; status: number; body: Record<string, unknown> };

/** The 401 when the acting agent is not on the server asked about. */
export const AGENT_NO_LONGER_EXISTS_REFUSAL: RefusalInput = { code: "agent_not_found", error: "Agent no longer exists" };

/** A channel id these routes can't act on: missing, on another server, or one the agent can't see all read the same. */
export const AGENT_CHANNEL_ID_NOT_FOUND_REFUSAL: RefusalInput = { code: "channel_not_found", error: "Channel not found" };

const ROLE_RANK: Record<ServerRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * 403 refusal for an agent whose server role does not allow an operation.
 * `error` keeps its old text; clients branch on `code`, models read
 * `suggestedNextAction`, which names the role needed and the agent's own.
 */
export async function agentServerRoleRequiredBody(input: {
  serverId: string;
  agentId: string;
  capabilities: readonly [ServerCapability, ...ServerCapability[]];
  action: string;
  /**
   * Set when the channel-admin role in this channel would also allow it. On a
   * joint channel only a host-appointed manager's (shared name/description);
   * callers leave it unset otherwise.
   */
  channelAdminIn?: string;
  /**
   * Set (to the channel's name) when the channel is joint: no role on another
   * server allows the operation there, so the next step names the host server's
   * owners, admins and channel managers instead of "a server owner or admin".
   */
  jointChannel?: string;
}): Promise<RefusalInput> {
  const currentRole = await getActorServerRoleInServer(input.serverId, "agent", input.agentId);
  const candidates = input.capabilities
    .map(minimumServerRoleWithCapability)
    .filter((role): role is ServerRole => role !== null);
  const requiredRole = candidates.length === 0
    ? null
    : candidates.reduce((low, role) => (ROLE_RANK[role] < ROLE_RANK[low] ? role : low));
  const roleText = currentRole ? `your role is ${currentRole}` : "you are not a member of this server";
  const needsHigherRole = requiredRole !== null && (!currentRole || ROLE_RANK[requiredRole] > ROLE_RANK[currentRole]);
  const channelAdmin = input.channelAdminIn ? `, or the channel-admin role in #${input.channelAdminIn}` : "";
  const suggestedNextAction = input.jointChannel
    ? `On a joint channel only its host server's owners, admins and channel managers can ${input.action}; ask one of them to do it in #${input.jointChannel}.`
    : needsHigherRole
    ? `To ${input.action} you need the ${requiredRole} role on this server${channelAdmin}; ${roleText}. `
      + (channelAdmin
        ? "Ask a server owner or admin to do it, or to give you one of those roles."
        : "Ask a server owner or admin to do it, or to change your role.")
    : `Your role on this server or channel does not allow you to ${input.action} here (${roleText}). Ask a server owner or admin to do it.`;
  return {
    error: `Agent requires ${input.capabilities.join(" or ")} capability to ${input.action}`,
    code: AGENT_SERVER_ROLE_REQUIRED_CODE,
    suggestedNextAction,
  };
}

/**
 * Any other agent-facing refusal on these routes. The Raft SDK forwards only
 * `code` and `suggestedNextAction` to the model, so both are required.
 */
export function agentRefusalBody(error: string, code: string, suggestedNextAction: string): RefusalInput {
  return { error, code, suggestedNextAction };
}

/** `msg` as a sentence: exactly one closing period. */
export function asSentence(msg: string): string {
  const trimmed = msg.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

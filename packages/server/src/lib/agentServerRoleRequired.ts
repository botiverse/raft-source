import { minimumServerRoleWithCapability, type ServerCapability, type ServerRole } from "@botiverse/raft-shared";
import { getActorServerRoleInServer } from "./actorPermissions";

export const AGENT_SERVER_ROLE_REQUIRED_CODE = "server_role_required";

export type AgentServerRoleRequiredBody = {
  error: string;
  code: typeof AGENT_SERVER_ROLE_REQUIRED_CODE;
  /** Plain sentence the Raft SDK forwards to the model (it never forwards raw bodies). */
  suggestedNextAction: string;
  /** Any one of these is enough. */
  requiredCapabilities: ServerCapability[];
  /** Lowest server role that grants one of them; null if no role does. */
  requiredRole: ServerRole | null;
  /** The agent's live role on this server; null when it is not a member. */
  currentRole: ServerRole | null;
};

const ROLE_RANK: Record<ServerRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * 403 body for an agent whose server role does not allow an operation. `error`
 * keeps its old text; clients branch on `code`, models read `suggestedNextAction`.
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
}): Promise<AgentServerRoleRequiredBody> {
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
  const suggestedNextAction = needsHigherRole
    ? `To ${input.action} you need the ${requiredRole} role on this server${channelAdmin}; ${roleText}. `
      + (channelAdmin
        ? "Ask a server owner or admin to do it, or to give you one of those roles."
        : "Ask a server owner or admin to do it, or to change your role.")
    : `Your role on this server or channel does not allow you to ${input.action} here (${roleText}). Ask a server owner or admin to do it.`;
  return {
    error: `Agent requires ${input.capabilities.join(" or ")} capability to ${input.action}`,
    code: AGENT_SERVER_ROLE_REQUIRED_CODE,
    suggestedNextAction,
    requiredCapabilities: [...input.capabilities],
    requiredRole,
    currentRole,
  };
}

/**
 * Any other agent-facing refusal on these routes. The Raft SDK forwards only
 * `code` and `suggestedNextAction` to the model, so both are required.
 */
export function agentRefusalBody(error: string, code: string, suggestedNextAction: string) {
  return { error, code, suggestedNextAction };
}

/** `msg` as a sentence: exactly one closing period. */
export function asSentence(msg: string): string {
  const trimmed = msg.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

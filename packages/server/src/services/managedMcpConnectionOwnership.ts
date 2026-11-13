/**
 * WHOSE Connection an Agent may use (stage 1, no schema change).
 *
 * A Connection carries the identity of the person who signed it in (their GitHub, Notion, ... account).
 * Managing an Agent (its creator, a personal assistant's owner) must not let someone act with another
 * person's identity by pinning their Agent to that person's Connection. So an Agent may use:
 *
 *   - the App's server default (`is_server_default`): shared on purpose by whoever set it, or
 *   - a Connection its OWNER created (`created_by_user_id` = the Agent's owner).
 *
 * A Connection with no recorded creator (the creator was deleted, or an old row) is usable only as the
 * server default. An Agent with no owner (created by an agent, or unknown) may use only the default.
 *
 * Enforced at three places, all through `mcpConnectionUsableByAgent`: the pin write
 * (`resolveAssignmentBinding`), every call (`admitManagedMcpCall`), and the candidates offered for
 * pinning (`projectMcpConnectionAuthorization`).
 */

/** The agent columns the owner is derived from. All three are required so no caller can drop one. */
export interface McpAgentOwnerFacts {
  assistantOwnerUserId: string | null;
  creatorType: string | null;
  creatorId: string | null;
}

/**
 * The Agent's owner: a personal assistant's owner, else the human who created it, else nobody (an
 * Agent created by an agent has no human owner of its own here).
 */
export function mcpAgentOwnerUserId(agent: McpAgentOwnerFacts): string | null {
  if (agent.assistantOwnerUserId) return agent.assistantOwnerUserId;
  if (agent.creatorType === "user" && agent.creatorId) return agent.creatorId;
  return null;
}

/** Whether an Agent whose owner is `agentOwnerUserId` may use this Connection. */
export function mcpConnectionUsableByAgent(
  connection: { isServerDefault: boolean; createdByUserId: string | null },
  agentOwnerUserId: string | null,
): boolean {
  if (connection.isServerDefault) return true;
  return agentOwnerUserId !== null && connection.createdByUserId !== null && connection.createdByUserId === agentOwnerUserId;
}

/** Refusing a pin to a Connection the Agent may not use (`managed_mcp_connection_not_usable`). */
export const MCP_CONNECTION_NOT_USABLE_MESSAGE =
  "This Connection belongs to someone else. An agent can use the App's default Connection or one its owner created.";

/**
 * Refusing a call through an existing pin the Agent may not use (any more). Still
 * `managed_mcp_login_required`, so the Connect card is raised for a human to fix it.
 */
// Until members can create Connections themselves (stage 3), only a server admin can make one usable: the
// way out that works for every owner is the App's default (Tenny, #proj-assistant cebab0ca bddcf71f).
export const MCP_CONNECTION_NOT_USABLE_CALL_MESSAGE =
  "This App's Connection can't be used by this agent anymore. Switch the agent to the App's default Connection, or ask a server admin to set a Connection it can use as the default.";

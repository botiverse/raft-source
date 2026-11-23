/**
 * Who owns an Agent: a personal assistant's owner, else the human who created it.
 *
 * Until RFC 087 this also decided WHOSE MCP Connection an Agent could use (the default, or one its
 * owner created). That rule is gone (D2): a shared Connection is usable by every Agent an admin
 * pins to it, and a member's personal Connection by the Agents they give it to
 * (`admitManagedMcpCall`). The owner is still what agent connectors and runtime approvals ask.
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

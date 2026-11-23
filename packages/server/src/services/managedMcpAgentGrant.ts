import type { ManagedMcpAgentGrant } from "@botiverse/raft-shared";

/**
 * Whether an MCP App is available to an Agent, with the SAME rule as an ordinary server-local App
 * (`autoGrantAgentClientRule` in oauthService): it is granted automatically when a person with
 * authority over the Agent already said so -- the App's Server vouched for it
 * (`managed_mcp_servers.server_vouched_at`, set by an owner or admin), or the Agent's own creator
 * created the App. The App creator's CURRENT role is not read: a vouch outlives their leaving or
 * demotion, and an admin's App nobody vouched for reaches only that admin's Agents. A person can
 * revoke it for one Agent and grant it again; for an MCP App that per-Agent choice is the
 * assignment row's `enabled` column, so "revoked" is `enabled = false` (the block an ordinary App
 * keeps in `oauth_agent_auto_grant_blocks`) and "granted again" is `enabled = true`.
 *
 * Fail-closed: an App with no recorded creator is granted to no Agent automatically unless the
 * Server vouched for it. (Until migration managed_mcp_servers_server_vouch such an App reached every
 * Agent; that migration vouched for the ones on live Servers, reason `legacy_no_creator`, so they
 * keep doing so as a decision an owner or admin can turn off.) A creator who was retired keeps the
 * App only for Agents still created by them: retirement archives their Agents or hands them to the
 * Server owner (`creator_id` becomes the owner's), so those no longer match.
 *
 * Every reader of automatic coverage asks this one function over columns of the App row it already
 * read (the call path, the runtime snapshot, the Agent's catalogue, the App view's agentsSummary and
 * agentAccess, the default-change impact, a new assignment row's `enabled`): no query of its own.
 */

type AgentCreator = { creatorType: string | null; creatorId: string | null };
/** The App columns the rule reads. */
export type McpAutoGrantApp = { createdByUserId: string | null; serverVouchedAt: Date | null };

export function mcpAutoGrantCoversAgent(app: McpAutoGrantApp, agent: AgentCreator): boolean {
  if (app.serverVouchedAt !== null) return true;
  // No recorded creator: nobody's own App, so no Agent by the creator branch.
  if (app.createdByUserId === null) return false;
  return agent.creatorType === "user" && agent.creatorId === app.createdByUserId;
}

/**
 * How an Agent holds an MCP App. An enabled assignment row on an Agent the App would reach
 * automatically is still the automatic grant (rows are also written by a Connection change).
 *
 * `personalGrant`: a member gave this Agent their own account for the App (RFC 087 §5), which is a
 * person's grant too, but never overrides an explicit off. Callers asking about the admin layer only
 * (who follows the server default) pass false.
 */
export function mcpAgentGrant(assignment: { enabled: boolean } | null, autoGranted: boolean, personalGrant: boolean): ManagedMcpAgentGrant {
  if (assignment && !assignment.enabled) return "revoked";
  if (autoGranted) return "automatic";
  return assignment || personalGrant ? "person" : "not_granted";
}

export function mcpAgentGrantAllows(grant: ManagedMcpAgentGrant): boolean {
  return grant === "automatic" || grant === "person";
}

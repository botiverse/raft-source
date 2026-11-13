import type { ManagedMcpAgentGrant } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { actorHasServerCapabilityInServer } from "../lib/actorPermissions";

/**
 * Whether an MCP App is available to an Agent, with the SAME rule as an ordinary server-local App
 * (`mayAutoGrantAgentClient` in oauthService): it is granted automatically when whoever created the
 * App already has authority over the Agent -- they hold `manageExternalAuth`, or they created the
 * Agent. A person can revoke it for one Agent and grant it again; for an MCP App that per-Agent
 * choice is the assignment row's `enabled` column, so "revoked" is `enabled = false` (the block an
 * ordinary App keeps in `oauth_agent_auto_grant_blocks`) and "granted again" is `enabled = true`.
 *
 * An App with no recorded creator (created before the column was filled, or whose creator's
 * account was deleted) is granted to every Agent, which is how every MCP App behaved before.
 */

type AgentCreator = { creatorType: string | null; creatorId: string | null };
type AppCreator = { createdByUserId: string | null };

/** The automatic-grant rule for one Agent, with each App creator's capability read at most once. */
export type McpAutoGrantResolver = (app: AppCreator) => Promise<boolean>;

export function mcpAutoGrantResolver(
  executor: DatabaseExecutor,
  serverId: string,
  agent: AgentCreator,
): McpAutoGrantResolver {
  const creatorCanManageExternalAuth = new Map<string, Promise<boolean>>();
  return async (app) => {
    if (app.createdByUserId === null) return true;
    if (agent.creatorType === "user" && agent.creatorId === app.createdByUserId) return true;
    let capability = creatorCanManageExternalAuth.get(app.createdByUserId);
    if (!capability) {
      capability = actorHasServerCapabilityInServer(serverId, "user", app.createdByUserId, "manageExternalAuth", executor);
      creatorCanManageExternalAuth.set(app.createdByUserId, capability);
    }
    return capability;
  };
}

/**
 * The per-App side of the rule for counting many Agents: `null` when the App is granted to every
 * Agent, otherwise the one user whose Agents it is granted to.
 */
export async function mcpAutoGrantCreatorScope(
  executor: DatabaseExecutor,
  serverId: string,
  app: AppCreator,
): Promise<string | null> {
  if (app.createdByUserId === null) return null;
  const everyone = await actorHasServerCapabilityInServer(serverId, "user", app.createdByUserId, "manageExternalAuth", executor);
  return everyone ? null : app.createdByUserId;
}

export function mcpAutoGrantCoversAgent(creatorScope: string | null, agent: AgentCreator): boolean {
  return creatorScope === null || (agent.creatorType === "user" && agent.creatorId === creatorScope);
}

/**
 * How an Agent holds an MCP App. An enabled assignment row on an Agent the App would reach
 * automatically is still the automatic grant (rows are also written by a Connection change).
 */
export function mcpAgentGrant(assignment: { enabled: boolean } | null, autoGranted: boolean): ManagedMcpAgentGrant {
  if (assignment && !assignment.enabled) return "revoked";
  if (autoGranted) return "automatic";
  return assignment ? "person" : "not_granted";
}

export function mcpAgentGrantAllows(grant: ManagedMcpAgentGrant): boolean {
  return grant === "automatic" || grant === "person";
}

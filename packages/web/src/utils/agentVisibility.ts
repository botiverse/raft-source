import type { Agent } from "../store/agentStore";
import type { ServerCapabilities } from "@botiverse/raft-shared";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";

export function canViewAgentPrivateSurfaces(
  agent: Pick<Agent, "creatorType" | "creatorId">,
  currentUserId: string | undefined,
  canManageAgents: boolean,
): boolean {
  if (canManageAgents) return true;
  return Boolean(currentUserId && agent.creatorType === "user" && agent.creatorId === currentUserId);
}

/**
 * Who may run an agent's runtime controls (the profile's header, ⋯ and
 * Actions, and the Members page's menu): the one rule both read, so they
 * can't drift. Runtime control is `controlAgentRuntime` or the creator's,
 * never an external agent's (it has no managed runtime); Stop Agent is
 * also `stopAgents` or the creator's (members keep start, restart and Stop
 * turn); Full reset is `resetAgentWorkspace` or the creator's. A bounded
 * public projection (another server's agent, a channel summary) gets none.
 * Which of them shows right now is `agentRuntimeControls`' (#triage:#206).
 */
export function agentRuntimePermissions(
  agent: Pick<Agent, "creatorType" | "creatorId">,
  currentUserId: string | undefined,
  capabilities: Pick<ServerCapabilities, "controlAgentRuntime" | "stopAgents" | "resetAgentWorkspace">,
  { isExternalAgent, isBoundedPublicProjection = false }: { isExternalAgent: boolean; isBoundedPublicProjection?: boolean },
): { canControlAgentRuntime: boolean; canStopAgent: boolean; canResetAgentWorkspace: boolean } {
  const managed = !isBoundedPublicProjection && !isExternalAgent;
  const canControlAgentRuntime = managed && canViewAgentPrivateSurfaces(agent, currentUserId, capabilities.controlAgentRuntime);
  return {
    canControlAgentRuntime,
    canStopAgent: canControlAgentRuntime && canViewAgentPrivateSurfaces(agent, currentUserId, capabilities.stopAgents),
    canResetAgentWorkspace: managed && canViewAgentPrivateSurfaces(agent, currentUserId, capabilities.resetAgentWorkspace),
  };
}

/**
 * Who may edit an agent's runtime config (the Edit runtime config dialog,
 * AgentRuntimeConfigEditor): the rule the profile's Runtime config pencil
 * follows (AgentDetailPanel's canManageAgent, `editAgents` or the creator, on
 * a live agent of this server; AgentProfileInfo's canOpenRuntimeConfigEditor,
 * never an external agent), read by the Members page's Edit agent. Never an
 * archived agent or an App's identity (its runtime is the App's).
 */
export function canEditAgentRuntimeConfig(
  agent: Pick<Agent, "creatorType" | "creatorId" | "deletedAt" | "managedByAppInstallId" | "external" | "runtime">,
  currentUserId: string | undefined,
  capabilities: Pick<ServerCapabilities, "editAgents">,
  { isBoundedPublicProjection = false }: { isBoundedPublicProjection?: boolean } = {},
): boolean {
  if (isBoundedPublicProjection || agent.deletedAt || agent.managedByAppInstallId) return false;
  if (agent.external === true || isExternalAgentRuntime(agent.runtime)) return false;
  return canViewAgentPrivateSurfaces(agent, currentUserId, capabilities.editAgents);
}

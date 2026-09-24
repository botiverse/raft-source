import type { Agent } from "../store/agentStore";

export function canViewAgentPrivateSurfaces(
  agent: Pick<Agent, "creatorType" | "creatorId">,
  currentUserId: string | undefined,
  canManageAgents: boolean,
): boolean {
  if (canManageAgents) return true;
  return Boolean(currentUserId && agent.creatorType === "user" && agent.creatorId === currentUserId);
}

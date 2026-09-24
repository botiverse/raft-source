import type { Agent } from "../../store/agentStore";

export function isRemoteAgentProjection(
  agent: Agent | null | undefined,
  currentServerId: string | null | undefined,
): boolean {
  return Boolean(
    agent
      && !agent.deletedAt
      && typeof agent.id === "string"
      && typeof agent.name === "string"
      && typeof agent.serverId === "string"
      && typeof currentServerId === "string"
      && agent.serverId !== currentServerId
      && (agent.displayName === null || typeof agent.displayName === "string")
      && (agent.avatarUrl === null || typeof agent.avatarUrl === "string")
      && (agent.status === "active" || agent.status === "inactive" || agent.status === "stopped"),
  );
}

export function canRenderAgentDetail(
  agent: Agent | null | undefined,
  currentServerId?: string | null,
): agent is Agent {
  if (isRemoteAgentProjection(agent, currentServerId)) return true;
  if (agent?.profileProjection === "channel_summary") {
    return Boolean(
      !agent.deletedAt
        && typeof agent.id === "string"
        && typeof agent.name === "string"
        && typeof agent.status === "string",
    );
  }
  return Boolean(
    agent
      && !agent.deletedAt
      && typeof agent.id === "string"
      && typeof agent.name === "string"
      && typeof agent.status === "string"
      && typeof agent.runtime === "string"
      && typeof agent.model === "string",
  );
}

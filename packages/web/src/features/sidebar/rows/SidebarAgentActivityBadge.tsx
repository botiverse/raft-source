import AgentActivityDot from "../../../components/agent/AgentActivityDot";

export function SidebarAgentActivityBadge({ agentId }: { agentId: string }) {
  return <AgentActivityDot agentId={agentId} size="sm" data-sidebar-avatar-badge="true" />;
}

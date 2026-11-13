import { useMemo } from "react";
import { useIntl } from "react-intl";
import { canChangeAgentMemberRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { MessageId } from "../../i18n/messages/en";

const EDITABLE_AGENT_ROLE_OPTIONS: { id: Extract<ServerRole, "admin" | "member">; labelId: MessageId }[] = [
  { id: "admin", labelId: "agent.detail.roleAdmin" },
  { id: "member", labelId: "agent.detail.roleMember" },
];

/** Roles the viewer may assign to this agent (empty when the role is not editable). */
export function useEditableAgentRoleOptions(agent: Agent): { id: Extract<ServerRole, "admin" | "member">; label: string }[] {
  const { formatMessage } = useIntl();
  const { role: currentRole } = useServerPermissions();
  const currentAgentServerRole = agent.serverRole === "admin" ? "admin" : agent.serverRole === "member" ? "member" : null;
  return useMemo(
    () => currentAgentServerRole
      ? EDITABLE_AGENT_ROLE_OPTIONS
        .filter((option) => canChangeAgentMemberRole(currentRole, currentAgentServerRole, option.id))
        .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) }))
      : [],
    [currentAgentServerRole, currentRole, formatMessage],
  );
}

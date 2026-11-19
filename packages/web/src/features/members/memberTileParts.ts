import { useIntl } from "react-intl";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { Agent } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { canEditAgentRuntimeConfig } from "../../utils/agentVisibility";
import { agentModelLabel } from "../../utils/agentModelName";
import { entryRole, roleWordId } from "./membersPageModel";
import type { MemberEntry } from "./membersPageModel";

/**
 * Whether the viewer may edit this agent from the Members page (Edit agent):
 * exactly when its profile shows the Runtime config pencil
 * (canEditAgentRuntimeConfig), which opens the same dialog.
 */
export function useCanEditAgent(agent: Agent | null): boolean {
  const userId = useAuthStore((s) => s.user?.id);
  const serverId = useServerStore((s) => s.current?.id);
  const { capabilities } = useServerPermissions();
  if (!agent) return false;
  const isBoundedPublicProjection = agent.profileProjection === "channel_summary"
    || Boolean(serverId && agent.serverId && agent.serverId !== serverId);
  return canEditAgentRuntimeConfig(agent, userId, capabilities, { isBoundedPublicProjection });
}

/**
 * A tile's corner tag (RoleCornerTag): the role, as the hover card's tag
 * (Owner, Admin or Guest, never Member), and on the viewer's own tile "You"
 * before it ("You · Owner"), or "You" alone. None for anyone else without one.
 */
export function useMemberTileTag(entry: MemberEntry, isSelf: boolean): string | null {
  const { formatMessage } = useIntl();
  const roleId = roleWordId(entryRole(entry));
  const role = roleId ? formatMessage({ id: roleId }) : null;
  if (!isSelf) return role;
  return role
    ? formatMessage({ id: "members.page.tag.youWithRole" }, { role })
    : formatMessage({ id: "members.page.tag.you" });
}

/**
 * An agent's model as its tile's (or phone row's) second line is set: mono
 * meta in hint, as the Agents tab's Model column (raft-ui ListRowMeta) sets it.
 */
export const AGENT_MODEL_LINE = "font-mono text-mono-meta font-normal tabular-nums text-foreground-hint";

/** An agent tile's second line: its model, as the Agents tab's Model column names it; an App's identity has none. */
export function agentTileModel(agent: Agent): string | null {
  return agent.managedByAppInstallId ? null : agentModelLabel(agent);
}

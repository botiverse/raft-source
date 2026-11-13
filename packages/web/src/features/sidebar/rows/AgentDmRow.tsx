import { SidebarItem } from "@botiverse/raft-ui";
import { useCallback, memo } from "react";
import type { Agent } from "../../../store/agentStore";
import { useMessageStore } from "../../../store/messageStore";
import AppBadge from "../../../components/agent/AppBadge";
import AvatarSlot from "../../../components/ui/AvatarSlot";
import { resolveAgentDmProfileSource } from "../../../components/layout/agentDmProfileSource";
import { getDmUnreadIndicatorState } from "../../../utils/channelUnreadIndicator";
import { useScopeMarkedUnread } from "../../../store/markedUnreadStore";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import type { SidebarCtxKind, SidebarLongPress } from "../sidebarContextMenu";
import { sidebarItemClass } from "./sidebarRowClasses";
import { SidebarAgentActivityBadge } from "./SidebarAgentActivityBadge";
import { SidebarAgentMeta } from "./SidebarAgentMeta";
import { SidebarPeerRowBody } from "./SidebarPeerRowBody";

// Pinned agent DM row — keyed off the agent entity; subscribes to the agent's
// DM channel unread (if a DM channel exists yet).
export const AgentDmRow = memo(function AgentDmRow({
  agent,
  dmId,
  activityMuted = false,
  selected,
  menuOpen,
  onSelect,
  onContextMenu,
  makeLongPress,
}: {
  agent: Agent;
  dmId: string | undefined;
  /** The DM's Activity is muted (primitive, so memo holds). */
  activityMuted?: boolean;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (agent: Agent, dmId: string | undefined, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}) {
  // Stryker disable all: visual class-token mutations are equivalent in the DOM oracle; agent DM profile/source, unread and pin-menu behavior are covered by behavior tests.
  const unread = useMessageStore((s) => (dmId ? s.unreadCounts[dmId] || 0 : 0));
  const markedUnread = useScopeMarkedUnread(dmId);
  const hasDraft = useMessageStore((s) => (dmId ? !!s.drafts[dmId] : false));
  const { displayName, description, avatarUrl } = resolveAgentDmProfileSource(agent);
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(agent, dmId, event.detail),
    [agent, dmId, onSelect],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, "agent", agent.id),
    [agent.id, onContextMenu],
  );
  return (
    <SidebarItem
      // The ordinary DM row publishes this too. Without it, the same pinned
      // conversation would gain or lose its channel identity purely from whether
      // the agent is still in the client's agent list — `pinnedItems` picks this
      // renderer on a cache hit and the DM renderer on a miss. Omitted when the
      // agent has no DM channel yet, since there is no channel to name.
      data-sidebar-channel-id={dmId}
      data-slot="sidebar-item"
      active={selected}
      tone={activityMuted ? "muted" : getDmUnreadIndicatorState({ unread, markedUnread, activityMuted }).unreadTone ? "unread" : "default"}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...makeLongPress("agent", agent.id)}
      className={sidebarItemClass(selected, menuOpen)}
    >
      <SidebarPeerRowBody
        avatar={(
          <AvatarSlot
            context="sidebar-list"
            type="agent"
            agentAvatarUrl={avatarUrl}
            badge={agent.managedByAppInstallId ? undefined : <SidebarAgentActivityBadge agentId={agent.id} />}
          />
        )}
        displayName={displayName}
        nameBadge={agent.managedByAppInstallId
          ? <AppBadge className="shrink-0" appName={agent.managedByApp?.name} botName={displayName} compactInNarrowSidebar />
          : null}
        description={description}
        unread={unread}
        markedUnread={markedUnread}
        hasDraft={hasDraft}
        activityMuted={activityMuted}
        agentMeta={agent.managedByAppInstallId
          ? null
          : <SidebarAgentMeta agentId={agent.id} runtime={agent.runtime} external={agent.external === true || isExternalAgentRuntime(agent.runtime)} />}
      />
    </SidebarItem>
  );
  // Stryker restore all
});

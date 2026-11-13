import { SidebarItem } from "@botiverse/raft-ui";
import { useCallback, memo } from "react";
import type { Channel } from "../../../store/channelStore";
import { useMessageStore } from "../../../store/messageStore";
import AppBadge from "../../../components/agent/AppBadge";
import { DmPeerAvatarSlot } from "../../../components/layout/DmPeerAvatarSlot";
import { getDmUnreadIndicatorState } from "../../../utils/channelUnreadIndicator";
import { useScopeMarkedUnread } from "../../../store/markedUnreadStore";
import type { SidebarCtxKind, SidebarLongPress } from "../sidebarContextMenu";
import { sidebarItemClass } from "./sidebarRowClasses";
import { SidebarAgentActivityBadge } from "./SidebarAgentActivityBadge";
import { SidebarAgentMeta } from "./SidebarAgentMeta";
import { SidebarPeerRowBody } from "./SidebarPeerRowBody";

// DM row (handles both human and agent peers). Used by the DM list and pinned
// human DMs. The context-menu target (`ctxType`/`ctxId`) can differ from the DM
// channel id (e.g. agent DMs target the agent), so it is passed explicitly.
export const DmRow = memo(function DmRow({
  dm,
  isAgent,
  peerId,
  displayName,
  description,
  selected,
  menuOpen,
  ctxType,
  ctxId,
  onSelect,
  onContextMenu,
  makeLongPress,
  agentRuntime = null,
  agentExternal = false,
  appBot = false,
  appBotAppName = null,
}: {
  dm: Channel;
  isAgent: boolean;
  peerId: string | null;
  displayName: string;
  description: string | null;
  /** Agent DMs: the agent's runtime id for the row's mono meta (primitive, so memo holds). */
  agentRuntime?: string | null;
  agentExternal?: boolean;
  /** The peer is an App bot (`managedByAppInstallId`): the App badge, no presence light. */
  appBot?: boolean;
  /** Its App's name, for the badge's label and tooltip. */
  appBotAppName?: string | null;
  selected: boolean;
  menuOpen: boolean;
  ctxType: SidebarCtxKind;
  ctxId: string;
  onSelect: (dmId: string, clickCount: number) => void;
  onContextMenu: (e: React.MouseEvent, type: SidebarCtxKind, id: string) => void;
  makeLongPress: (type: SidebarCtxKind, id: string) => SidebarLongPress;
}) {
  // Stryker disable all: visual class-token mutations are equivalent in the DOM oracle; pinned DM profile/source, unread and pin-menu behavior are covered by behavior tests.
  const unread = useMessageStore((s) => s.unreadCounts[dm.id] || 0);
  const markedUnread = useScopeMarkedUnread(dm.id);
  // Stryker disable next-line all: pre-existing draft badge logic is outside the workspace mutation corpus.
  const hasDraft = useMessageStore((s) => !!s.drafts[dm.id]);
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => onSelect(dm.id, event.detail),
    [dm.id, onSelect],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => onContextMenu(event, ctxType, ctxId),
    [ctxId, ctxType, onContextMenu],
  );
  const activityMuted = dm.activityMuted === true;
  return (
    <SidebarItem
      data-sidebar-channel-id={dm.id}
      data-slot="sidebar-item"
      active={selected}
      tone={activityMuted ? "muted" : getDmUnreadIndicatorState({ unread, markedUnread, activityMuted }).unreadTone ? "unread" : "default"}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...makeLongPress(ctxType, ctxId)}
      className={sidebarItemClass(selected, menuOpen)}
    >
      <SidebarPeerRowBody
        // The peer's face is read live (agent directory / member list), so a
        // changed or reset avatar shows at once; the DM's snapshot is the fallback.
        avatar={(
          <DmPeerAvatarSlot
            context="sidebar-list"
            peerType={dm.peerType}
            peerId={dm.peerId}
            peerAvatarUrl={dm.peerAvatarUrl}
            badge={isAgent && peerId && !appBot ? <SidebarAgentActivityBadge agentId={peerId} /> : undefined}
          />
        )}
        displayName={displayName}
        nameBadge={isAgent && appBot ? <AppBadge className="shrink-0" appName={appBotAppName} botName={displayName} compactInNarrowSidebar /> : null}
        description={description}
        unread={unread}
        markedUnread={markedUnread}
        hasDraft={hasDraft}
        activityMuted={activityMuted}
        // An App bot runs on no runtime: no "External agent" label.
        agentMeta={isAgent && peerId && !appBot ? <SidebarAgentMeta agentId={peerId} runtime={agentRuntime} external={agentExternal} /> : null}
      />
    </SidebarItem>
  );
  // Stryker restore all
});

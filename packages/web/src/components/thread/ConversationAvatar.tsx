// The leading tile of a conversation row: the conversation it belongs to,
// drawn the same way in Activity (ThreadsInbox) and Drafts (DraftsPanel), so a
// conversation looks the same wherever a list names it.

import { IconTile, InboxItemLeading } from "@botiverse/raft-ui";
import { DirectMessageIcon, ThreadIcon } from "@botiverse/ricons";
import { InboxItemLeadingBadge } from "@botiverse/raft-ui/wip";
import { ListTodo } from "lucide-react";
import type { Channel } from "../../store/channelStore";
import { ChannelIcon } from "../channel/channelKindIcon";
import type { ChannelKindSource } from "../channel/channelKind";
import AgentActivityDot from "../agent/AgentActivityDot";
import { DmPeerAvatarSlot } from "../layout/DmPeerAvatarSlot";
import { AgentLoungeIcon } from "../agent/agentLounge";
import { useAgentStore } from "../../store/agentStore";
import AvatarSlot from "../ui/AvatarSlot";

/** A DM peer's face, live from the agent / member directory; an agent's can carry its status light. */
export function PeerFace({ dmChannel, statusLight = false }: { dmChannel: Channel; statusLight?: boolean }) {
  return (
    <DmPeerAvatarSlot
      peerType={dmChannel.peerType}
      peerId={dmChannel.peerId}
      peerAvatarUrl={dmChannel.peerAvatarUrl}
      context="panel-header"
      badge={dmChannel.peerType === "agent" && statusLight && dmChannel.peerId ? <AgentActivityDot agentId={dmChannel.peerId} size="sm" data-testid="conversation-card-presence" /> : undefined}
    />
  );
}

/** A thread's mark, or a task's for a task: in the tile of a channel's
 *  thread or task row, or in the corner of a DM thread's peer face. */
export function ThreadMark({ task = false }: { task?: boolean }) {
  return task ? <ListTodo data-testid="conversation-card-task-mark" /> : <ThreadIcon data-testid="conversation-card-thread-mark" />;
}

/**
 * List-layout leading visual (raft-ui InboxItemLeading). The peer for DMs, the
 * channel's own kind icon for channels (#, lock, joint branch, # with a globe
 * on the public page, as in the sidebar; artin, Jasper). A thread or task in a
 * channel leads with its own mark (thread icon, or list-todo for a task) and
 * the channel's kind icon moves to the corner badge (cindyz, stdrc,
 * #triage:e2821c03; the app's botiverse/mobile#4026). A thread in a DM keeps
 * the peer's face with the thread mark in the corner (task #56, xxchan), and a
 * DM thread whose DM is not loaded keeps the DM tile: never a `#`. One mark per
 * corner: on a DM thread the thread mark takes the corner, so it carries no
 * status light.
 *
 * An agent's Lounge (`loungeAgentId`) leads with its agent's face and the
 * Lounge mark in the corner badge (tygg, #proj-chat:30a58e4d), as its sidebar
 * row and header do; a thread or task in a Lounge keeps its own mark with the
 * Lounge mark as the place's badge, where a channel's kind icon would be.
 */
export function ConversationAvatar({ kind, dmChannel, peerIsAppBot = false, parentIsDm = false, channelType, channel = null, serverPublicPageLive = false, loungeAgentId = null }: {
  kind: "thread" | "task" | "dm" | "channel";
  dmChannel: Channel | null;
  /** The DM peer is an App bot: it has no presence, its row shows the App badge instead. */
  peerIsAppBot?: boolean;
  parentIsDm?: boolean;
  /** The (parent) channel's type, which picks its icon. */
  channelType: Channel["type"];
  /** The (parent) channel when it is loaded: its kind icon comes from the
   *  shared chooser (external, public page), as in the sidebar. */
  channel?: ChannelKindSource | null;
  serverPublicPageLive?: boolean;
  /** The agent whose Lounge the (parent) conversation is; null: not a Lounge. */
  loungeAgentId?: string | null;
}) {
  if (loungeAgentId && !parentIsDm && kind !== "dm") {
    return <LoungeConversationAvatar agentId={loungeAgentId} kind={kind} />;
  }
  if ((kind === "thread" || kind === "task") && dmChannel) {
    return (
      <InboxItemLeading data-testid="conversation-card-avatar" data-kind="thread" data-parent-kind="dm">
        <PeerFace dmChannel={dmChannel} />
        <InboxItemLeadingBadge>
          <ThreadMark task={kind === "task"} />
        </InboxItemLeadingBadge>
      </InboxItemLeading>
    );
  }
  if (kind === "dm" && dmChannel) {
    return (
      <InboxItemLeading data-testid="conversation-card-avatar" data-kind="dm">
        {/* An agent's status light, as on its sidebar row. Thread and task
            rows keep that corner for their badge instead. An App bot has
            no presence: its row carries the App badge instead. */}
        <PeerFace dmChannel={dmChannel} statusLight={!peerIsAppBot} />
      </InboxItemLeading>
    );
  }
  if ((kind === "thread" || kind === "task") && !parentIsDm) {
    return (
      <InboxItemLeading data-testid="conversation-card-avatar" data-kind={kind}>
        <IconTile>
          <ThreadMark task={kind === "task"} />
        </IconTile>
        <InboxItemLeadingBadge>
          <ChannelIcon channel={channel} type={channelType} serverPublicPageLive={serverPublicPageLive} />
        </InboxItemLeadingBadge>
      </InboxItemLeading>
    );
  }
  return (
    <InboxItemLeading data-testid="conversation-card-avatar" data-kind={kind}>
      {/* A channel is a place, not a face: the neutral DS channel tile
          (raft-ui IconTile, the 35px avatar step of the DM faces). */}
      <IconTile>
        {kind === "dm" || parentIsDm
          ? <DirectMessageIcon />
          : <ChannelIcon channel={channel} type={channelType} serverPublicPageLive={serverPublicPageLive} />}
      </IconTile>
      {kind === "thread" || kind === "task"
        ? <InboxItemLeadingBadge><ThreadMark task={kind === "task"} /></InboxItemLeadingBadge>
        : null}
    </InboxItemLeading>
  );
}

/** A Lounge's leading image: its agent's face, or a thread's or task's mark, with the Lounge mark in the corner badge. */
function LoungeConversationAvatar({ agentId, kind }: { agentId: string; kind: "thread" | "task" | "channel" }) {
  const avatarUrl = useAgentStore((s) => s.agents.find((agent) => agent.id === agentId)?.avatarUrl ?? null);
  return (
    <InboxItemLeading data-testid="conversation-card-avatar" data-kind={kind} data-lounge="">
      {kind === "channel" ? (
        <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={avatarUrl} />
      ) : (
        <IconTile>
          <ThreadMark task={kind === "task"} />
        </IconTile>
      )}
      <InboxItemLeadingBadge data-testid="conversation-card-lounge-mark">
        <AgentLoungeIcon strokeWidth={2.5} />
      </InboxItemLeadingBadge>
    </InboxItemLeading>
  );
}

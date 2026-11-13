import { useMemo } from "react";
import type { IntlShape } from "react-intl";
import { isRemovedAppBot } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { Channel } from "../../store/channelStore";
import type { Server } from "../../store/serverStore";
import { forwardAvailability } from "../../components/message/forwardSelectionUtils";
import { isExternalFreezeActive, isJointChannelReadOnly } from "../../utils/jointChannelLimit";

/**
 * The thread's parent channel or DM as the panel reads it: its route kind,
 * the thread as a forward source (and its label), the joint-channel lock, a
 * removed App Bot's DM, and whether the current human can reply or react.
 */
export function useThreadParentChannel({
  parentChannelId,
  threadChannelId,
  channels,
  dmChannels,
  loungeChannels,
  agents,
  currentServer,
  formatMessage,
  loungeTitle,
}: {
  parentChannelId: string | null;
  threadChannelId: string | null;
  channels: Channel[];
  dmChannels: Channel[];
  /** Agent Lounges: a Lounge is in neither list above, and a thread in one must still find its parent. */
  loungeChannels: Channel[];
  agents: Agent[];
  currentServer: Server | null;
  formatMessage: IntlShape["formatMessage"];
  /** "{Name}'s Lounge" when the parent is a Lounge: its name, never the raw `<agent>-lounge`. */
  loungeTitle?: string;
}) {
  // Semantic parent of a thread is its parent channel/dm. Fall back to chat
  // root when we don't yet know the parent (loading state).
  const parentRouteKind: "dm" | "channel" | null = parentChannelId
    ? (dmChannels.some((c) => c.id === parentChannelId) ? "dm" : "channel")
    : null;
  // Stryker disable all: parent-channel lookup and joint-lock banner guards are
  // existing defensive UI state; forward behavior is covered through the derived
  // thread source channel and toolbar entry tests below.
  const parentChannel = useMemo(
    () => parentChannelId
      ? findStoredChannel({ channels, dmChannels, loungeChannels }, parentChannelId) ?? null
      : null,
    [channels, dmChannels, loungeChannels, parentChannelId],
  );
  // Thread-source channel shape is asserted by the
  // composer/source contract tests; object-literal mutants are redundant with
  // those structural checks.
  const threadSourceChannel = useMemo(
    () => parentChannel && threadChannelId
      ? { ...parentChannel, id: threadChannelId, type: "thread" as const }
      : parentChannel,
    [parentChannel, threadChannelId],
  );
  const parentJointFeatureLocked = isJointChannelReadOnly(parentChannel);
  // The lock is the free plan's external channel freeze, not a joint's over-limit grace.
  const parentExternalFrozen = isExternalFreezeActive(parentChannel);
  // Stryker restore all
  // A thread in the DM with an App Bot removed from its App (#11295): the Bot
  // can't answer here either, so the reply composer is the DM's read-only
  // composer under the same notice (ChatPanel). agent:updated re-reads the
  // directory, so a re-add brings the composer back without a reload.
  const parentDmAgent = parentChannel?.type === "dm" && parentChannel.peerType === "agent" && parentChannel.peerId
    ? agents.find((agent) => agent.id === parentChannel.peerId)
    : undefined;
  const parentDmAppBotRemoved = isRemovedAppBot(parentDmAgent);
  const isGuest = currentServer?.role === "guest";
  const forwardState = forwardAvailability(parentChannel, { isGuest });
  const showForwardAction = forwardState === "ready";
  // Stryker disable all: thread composer source-label variants are covered by focused DOM behavior tests; the loading fallback is not user-clickable.
  const threadSourceLabel = useMemo(() => {
    const threadSuffix = formatMessage({ id: "message.forward.threadSuffix" });
    if (!parentChannel) return formatMessage({ id: "message.forward.threadFallback" });
    if (parentChannel.type === "dm") {
      return `@${parentChannel.peerDisplayName || parentChannel.peerName || parentChannel.name}${threadSuffix}`;
    }
    if (parentChannel.loungeAgentId && loungeTitle) return `${loungeTitle}${threadSuffix}`;
    return `#${parentChannel.name}${threadSuffix}`;
  }, [formatMessage, loungeTitle, parentChannel]);
  // Stryker restore all
  // Same tri-state contract as ChatPanel's channel composer: true means the
  // current human can reply, false means show the join CTA, undefined means
  // membership is still hydrating so we should not flash the wrong control.
  // A Lounge is open to every member and posting is what joins it (Agent
  // Lounge v0), so its threads take replies before you joined, as its
  // channel does (ChatPanel); one you may only read gets the read-only
  // composer, never a Join.
  const parentIsLounge = !!parentChannel?.loungeAgentId;
  const parentLoungeReadOnly = parentIsLounge && parentChannel?.canPost === false;
  const parentJoined: boolean | undefined = parentChannel?.type === "dm" || (parentIsLounge && !parentLoungeReadOnly)
    ? true
    : parentLoungeReadOnly ? undefined : parentChannel?.joined;
  // A Lounge you may only read takes no reactions in its threads either:
  // `parentJoined` is left unknown there, so this stays false on purpose.
  // A Guest reacts in its own channel's threads like a member (matrix §1).
  const canReactToThread = parentJoined === true
    && !parentChannel?.archivedAt
    && !parentJointFeatureLocked;

  return {
    parentRouteKind,
    parentChannel,
    threadSourceChannel,
    parentJointFeatureLocked,
    parentExternalFrozen,
    parentDmAgent,
    parentDmAppBotRemoved,
    isGuest,
    showForwardAction,
    forwardState,
    threadSourceLabel,
    parentJoined,
    parentLoungeReadOnly,
    canReactToThread,
  };
}

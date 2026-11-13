import { useCallback } from "react";
import { useIntl } from "react-intl";
import { useChannelStore } from "../../store/channelStore";
import { findLoungeAgentId } from "../../store/storedChannel";
import { loungeAgentDisplayName } from "../../components/agent/agentLounge";
import type { MouseEvent as ReactMouseEvent } from "react";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import { EntityResultRow } from "./EntityResultRow";
import { MessageHitRow } from "./MessageHitRow";
import type { SearchEntityResult as SearchEntityRecord, SearchEntitySourceParams } from "./searchEntities";
import { SearchHomeEntityRow } from "./SearchHomeEntityRow";
import type { MessageSearchResult } from "./searchResultTypes";
import type { SearchChannelContextMenuState } from "./useSearchResultActions";

/**
 * The page's result rows, rendered from its state: a message hit, a
 * destination (entity) row, and a search home destination row, plus the
 * source label a message hit names.
 */
export function useSearchResultRows({
  members,
  currentUser,
  agents,
  dmChannels,
  query,
  selectedResultKey,
  locatedResultKey,
  channelContextMenu,
  activateResultsInChat,
  handleMessageResultClick,
  handleEntityResultClick,
  handleChannelResultContextMenu,
  openEntityResult,
  openEntityResultInChat,
}: Pick<SearchEntitySourceParams, "members" | "currentUser" | "agents" | "dmChannels"> & {
  query: string;
  selectedResultKey: string | undefined;
  locatedResultKey: string | null;
  channelContextMenu: SearchChannelContextMenuState | null;
  activateResultsInChat: boolean;
  handleMessageResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: MessageSearchResult) => void;
  handleEntityResultClick: (event: ReactMouseEvent<HTMLButtonElement>, result: SearchEntityRecord) => void;
  handleChannelResultContextMenu: (event: ReactMouseEvent, result: SearchEntityRecord) => void;
  openEntityResult: (result: SearchEntityRecord) => Promise<void>;
  openEntityResultInChat: (result: SearchEntityRecord) => Promise<void>;
}) {
  const resolveUserMember = useCallback((userId: string | null) => (
    userId
      ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: userId }, members, currentUser)
      : undefined
  ), [currentUser, members]);

  const { formatMessage } = useIntl();
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const getSourceLabel = useCallback((result: MessageSearchResult) => {
    // A thread or task conversation hit names the channel it belongs to.
    const subConversation = result.channelType === "thread" || result.channelType === "task";
    const isDm = subConversation
      ? result.parentChannelType === "dm"
      : result.channelType === "dm";
    const sourceChannelId = subConversation
      ? result.parentChannelId
      : result.channelId;
    const rawName = subConversation
      ? result.parentChannelName
      : result.channelName;
    const dmPeer = isDm
      ? dmChannels.find((channel) => channel.id === sourceChannelId)
      : null;
    const displayName = dmPeer
      ? (dmPeer.peerDisplayName || dmPeer.peerName || rawName)
      : rawName;
    if (isDm) return `@${displayName}`;
    // A hit in an agent's Lounge names the Lounge, as its header does.
    const loungeAgentId = findLoungeAgentId({ channels: [], dmChannels, loungeChannels }, sourceChannelId);
    if (loungeAgentId) {
      const name = loungeAgentDisplayName(agents.find((entry) => entry.id === loungeAgentId), rawName);
      return formatMessage({ id: "agent.lounge.title" }, { name });
    }
    return `#${displayName}`;
  }, [agents, dmChannels, formatMessage, loungeChannels]);

  const renderMessageHit = useCallback((result: MessageSearchResult, nested = false) => {
    const agent = result.senderType === "agent"
      ? agents.find((entry) => entry.id === result.senderId)
      : null;
    const member = result.senderType === "user"
      ? resolveMessageSenderMemberFromList(result, members, currentUser)
      : null;
    return (
      <MessageHitRow
        key={result.id}
        result={result}
        nested={nested}
        selected={selectedResultKey === `message:${result.id}`}
        returnedFrom={locatedResultKey === `message:${result.id}`}
        sourceLabel={getSourceLabel(result)}
        agentAvatarUrl={agent?.avatarUrl ?? null}
        senderMember={member}
        query={query}
        onResultClick={handleMessageResultClick}
      />
    );
  }, [agents, currentUser, getSourceLabel, handleMessageResultClick, members, query, locatedResultKey, selectedResultKey]);

  // Same activation contract as the result list and the keyboard path: in the
  // ⌘K overlay (activateResultsInChat) a click must jump to the entity in chat —
  // openEntityResult only fills the col-3 content slot, which the overlay does
  // not render, so the click looked dead (task #95).
  const activateSearchHomeEntity = useCallback((result: SearchEntityRecord) => {
    void (activateResultsInChat ? openEntityResultInChat(result) : openEntityResult(result));
  }, [activateResultsInChat, openEntityResult, openEntityResultInChat]);

  const renderSearchHomeEntity = useCallback((result: SearchEntityRecord) => (
    <SearchHomeEntityRow
      key={result.key}
      result={result}
      agentAvatarUrl={result.agentId
        ? agents.find((entry) => entry.id === result.agentId)?.avatarUrl ?? null
        : null}
      humanMember={resolveUserMember(result.userId)}
      onActivate={activateSearchHomeEntity}
    />
  ), [activateSearchHomeEntity, agents, resolveUserMember]);

  const renderEntityResultRow = (result: SearchEntityRecord, options: { returnHint?: boolean } = {}) => {
    const hasOpenChannelContextMenu = result.type === "channel"
      && !!result.channelId
      && channelContextMenu?.result.channelId === result.channelId;
    return (
      <EntityResultRow
        key={result.key}
        result={result}
        query={query}
        returnHint={options.returnHint ?? false}
        selected={selectedResultKey === result.key || hasOpenChannelContextMenu}
        returnedFrom={locatedResultKey === result.key}
        agentAvatarUrl={result.agentId
          ? agents.find((entry) => entry.id === result.agentId)?.avatarUrl ?? null
          : null}
        humanMember={resolveUserMember(result.userId)}
        onResultContextMenu={handleChannelResultContextMenu}
        onResultClick={handleEntityResultClick}
      />
    );
  };

  return {
    getSourceLabel,
    renderMessageHit,
    renderSearchHomeEntity,
    renderEntityResultRow,
  };
}

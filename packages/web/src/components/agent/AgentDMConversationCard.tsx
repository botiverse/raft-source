import ConversationPreviewCard from "../ui/cards/ConversationPreviewCard";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import { getSearchRelativeTimeParts } from "../../features/search/searchGrouping";
import { useIntl } from "react-intl";
import { useMemo } from "react";
import type { AgentDMConversation } from "./AgentDMConversationList";
import { useDmPeerAvatar } from "../layout/dmPeerAvatar";

export function AgentDMConversationCard({ item }: { item: AgentDMConversation }) {
  const { formatMessage, locale } = useIntl();
  const formatRelative = (value: string) => {
    // Relative time follows the app display language, not the browser system
    // locale (shared searchGrouping helper now returns a locale-agnostic
    // descriptor). Other copy in this component is migrated separately.
    const parts = getSearchRelativeTimeParts(value);
    return parts ? formatRelativeTimeParts(parts.value, parts.unit, locale) : "";
  };
  // The peer agent's face is read live: the listed copy is from when the tab loaded.
  const { avatarUrl } = useDmPeerAvatar({ peerType: "agent", peerId: item.peerId, peerAvatarUrl: item.peerAvatarUrl });
  const author = useMemo(
    () => ({
      name: item.peerDisplayName || item.peerName,
      kind: "agent" as const,
      avatarUrl,
      subtitle: `@${item.peerName}`,
    }),
    [item.peerDisplayName, item.peerName, avatarUrl],
  );
  return (
    <ConversationPreviewCard
      channelLabel={formatMessage({ id: "agent.dmConversation.channelLabel" })}
      timestamp={formatRelative(item.lastMessageAt || item.createdAt)}
      author={author}
      preview={item.lastMessagePreview || formatMessage({ id: "agent.dmConversation.noMessages" })}
      ariaLabel={formatMessage(
        { id: "agent.dmConversation.rowAria" },
        { name: item.peerDisplayName || item.peerName },
      )}
      title={formatMessage({ id: "agent.dmConversation.activityTitle" })}
      footer={<span className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "agent.dmConversation.activityOnly" })}</span>}
    />
  );
}

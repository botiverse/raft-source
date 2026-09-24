import { useIntl } from "react-intl";
import ConversationPreviewCard from "../ui/cards/ConversationPreviewCard";
import { getSearchRelativeTimeParts } from "../search/searchGrouping";
import { formatRelativeTimeParts } from "../../utils/relativeTime";

export interface AgentDMConversation {
  id: string;
  createdAt: string;
  peerId: string;
  peerName: string;
  peerDisplayName: string | null;
  peerAvatarUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export function AgentDMConversationList({
  items,
}: {
  items: AgentDMConversation[];
}) {
  const { formatMessage, locale } = useIntl();
  const formatRelative = (value: string) => {
    // Relative time follows the app display language, not the browser system
    // locale (shared searchGrouping helper now returns a locale-agnostic
    // descriptor). Other copy in this component is migrated separately.
    const parts = getSearchRelativeTimeParts(value);
    return parts ? formatRelativeTimeParts(parts.value, parts.unit, locale) : "";
  };
  return (
    <div className="p-4 space-y-3">
      {items.map((item) => (
        <ConversationPreviewCard
          key={item.id}
          channelLabel={formatMessage({ id: "agent.dmConversation.channelLabel" })}
          timestamp={formatRelative(item.lastMessageAt || item.createdAt)}
          author={{
            name: item.peerDisplayName || item.peerName,
            kind: "agent",
            avatarUrl: item.peerAvatarUrl || null,
            subtitle: `@${item.peerName}`,
          }}
          preview={item.lastMessagePreview || formatMessage({ id: "agent.dmConversation.noMessages" })}
          ariaLabel={formatMessage(
            { id: "agent.dmConversation.rowAria" },
            { name: item.peerDisplayName || item.peerName },
          )}
          title={formatMessage({ id: "agent.dmConversation.activityTitle" })}
          footer={<span className="text-[11px] font-mono uppercase tracking-wide text-black/45">{formatMessage({ id: "agent.dmConversation.activityOnly" })}</span>}
        />
      ))}
    </div>
  );
}

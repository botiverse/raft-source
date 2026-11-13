import { AgentDMConversationCard } from "./AgentDMConversationCard";

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
  return (
    <div className="p-4 stack-y-3">
      {items.map((item) => (
        <AgentDMConversationCard key={item.id} item={item} />
      ))}
    </div>
  );
}

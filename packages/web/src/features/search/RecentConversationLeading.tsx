import type { ReactNode } from "react";
import AvatarSlot from "../../components/ui/AvatarSlot";
import MenuItemLeading from "../../components/ui/MenuItemLeading";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import type { SearchEntityResult } from "./searchEntities";

/**
 * A recent conversation's identity at the head of a menu row (the desktop top
 * bar's History menu): the channel's kind glyph, or the agent's or person's
 * avatar, always inside the one MenuItemLeading slot so a channel row and a
 * DM row put their glyph on the same centre line and their title at the same
 * x. Uses the web's identity primitives (ChannelKindIcon / AvatarSlot), so the
 * rows look the way the same conversations look everywhere else.
 */
export function RecentConversationLeading({ entity }: { entity: SearchEntityResult }) {
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  let identity: ReactNode;
  if (entity.type === "channel") {
    identity = <ChannelIcon channelId={entity.channelId} type={entity.channelType ?? "channel"} />;
  } else if (entity.type === "agentDm") {
    const avatarUrl = entity.agentId ? agents.find((agent) => agent.id === entity.agentId)?.avatarUrl ?? null : null;
    identity = <AvatarSlot context="creator-link" type="agent" agentAvatarUrl={avatarUrl} />;
  } else {
    const member = entity.userId
      ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: entity.userId }, members, currentUser)
      : undefined;
    identity = <AvatarSlot context="creator-link" type="human" humanAvatarUrl={member?.avatarUrl} humanPlaceholder={!member} />;
  }
  return <MenuItemLeading>{identity}</MenuItemLeading>;
}

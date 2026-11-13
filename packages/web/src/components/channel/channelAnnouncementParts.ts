import type { ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";

/** Channel details' Announcement row's element id: the strip's Announcement settings scrolls the drawer to it. */
export const CHANNEL_ANNOUNCEMENT_ROW_ID = "channel-settings-announcement";

/** Who made the announcement's current version, as people read them: the display name and avatar the client knows, else the payload's handle. */
export function useAnnouncementAuthor(updatedBy: ChannelAnnouncementForPerson["updatedBy"]): { name: string | null; avatarUrl: string | null } {
  const agent = useAgentStore((s) => (updatedBy.type === "agent" ? s.agents.find((a) => a.id === updatedBy.id) ?? null : null));
  const member = useServerStore((s) => (updatedBy.type === "user" ? s.members.find((m) => m.userId === updatedBy.id) ?? null : null));
  const known = agent ?? member;
  return { name: known?.displayName || known?.name || updatedBy.name, avatarUrl: known?.avatarUrl ?? null };
}


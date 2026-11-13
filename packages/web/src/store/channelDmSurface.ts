import type { Channel } from "./channelStore";

/**
 * Whether a conversation is a DM, asked of the channel store (a selector for
 * `useChannelStore`). The store keeps DMs in `dmChannels`, apart from
 * `channels` (which ChatPanel passes down as a prop), so a DM can only be told
 * from the store; a DM row in `channels` counts too. Used for a message's DM
 * read line (MessageItem) and to keep agent read progress out of DMs and their
 * threads (useAgentReadProgress). Null: not a DM.
 */
export function selectIsDmSurface(
  state: { channels: readonly Pick<Channel, "id" | "type">[]; dmChannels: readonly Pick<Channel, "id">[] },
  channelId: string | null | undefined,
): boolean {
  if (!channelId) return false;
  return state.dmChannels.some((candidate) => candidate.id === channelId)
    || state.channels.some((candidate) => candidate.id === channelId && candidate.type === "dm");
}

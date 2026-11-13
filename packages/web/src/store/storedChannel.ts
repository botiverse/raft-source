import type { Channel } from "./channelStore";

/**
 * A row from any slice the store keeps: channels, DMs, Lounges. Every lookup
 * of a conversation by id goes through this (or `useStoredChannel`): a
 * Lounge is never in `channels`, so `channels.find` by id misses it and the
 * caller takes it for a channel it doesn't know (a Lounge's thread lost its
 * composer that way). tests/storedChannelLookupRatchet.test.ts keeps by-id
 * lookups on the raw list out of the app.
 */
export function findStoredChannel(
  state: { channels: Channel[]; dmChannels: Channel[]; loungeChannels?: Channel[] },
  channelId: string | null | undefined,
): Channel | undefined {
  if (!channelId) return undefined;
  return state.channels.find((c) => c.id === channelId)
    ?? state.dmChannels.find((c) => c.id === channelId)
    ?? state.loungeChannels?.find((c) => c.id === channelId);
}

/**
 * The agent a conversation is the Lounge of, or null: from the Lounge's own
 * row when the store holds it, else from the agent DM row that carries it
 * (`lounge.channelId`, GET /channels/dm), so a Lounge not opened this session
 * (an Activity row, a search hit) still reads as its agent's.
 */
export function findLoungeAgentId(
  state: { channels: Channel[]; dmChannels: Channel[]; loungeChannels?: Channel[] },
  channelId: string | null | undefined,
): string | null {
  if (!channelId) return null;
  const stored = findStoredChannel(state, channelId)?.loungeAgentId;
  if (stored) return stored;
  const dm = state.dmChannels.find((c) => c.lounge?.channelId === channelId && c.peerType === "agent");
  return dm?.peerId ?? null;
}

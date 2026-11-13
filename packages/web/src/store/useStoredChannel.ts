import { useChannelStore } from "./channelStore";
import type { Channel } from "./channelStore";
import { findLoungeAgentId, findStoredChannel } from "./storedChannel";

/** The stored row for a conversation id, from any slice (`findStoredChannel`). */
export function useStoredChannel(channelId: string | null | undefined): Channel | undefined {
  return useChannelStore((s) => findStoredChannel(s, channelId));
}

/** The agent a conversation is the Lounge of, or null (`findLoungeAgentId`). */
export function useLoungeAgentId(channelId: string | null | undefined): string | null {
  return useChannelStore((s) => findLoungeAgentId(s, channelId));
}

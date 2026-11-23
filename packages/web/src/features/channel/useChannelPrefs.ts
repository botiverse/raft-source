import type { Channel } from "../../store/channelStore";
import { useStoredChannel } from "../../store/useStoredChannel";

/**
 * A conversation's own mute state and display prefs, with the versions its
 * writes carry: the stored row's, else what the given row says.
 *
 * Subscribed to every list the conversation can be in. A DM's or a Lounge's
 * mute and display prefs change `dmChannels` / `loungeChannels` alone, never
 * `channels`, so a value derived from `channels` (or from a row the caller
 * holds) keeps the old state for them.
 */
export function useChannelPrefs(channelId: string | null, channel: Channel | null) {
  const stored = useStoredChannel(channelId);
  return {
    activityMuted: stored?.activityMuted ?? (channel?.activityMuted === true),
    muteFromSeq: stored?.muteFromSeq ?? channel?.muteFromSeq ?? null,
    prefsVersion: stored?.prefsVersion ?? channel?.prefsVersion,
    collapseLongMessages: stored?.collapseLongMessages ?? channel?.collapseLongMessages ?? false,
    displayPrefsVersion: stored?.displayPrefsVersion ?? channel?.displayPrefsVersion,
  };
}

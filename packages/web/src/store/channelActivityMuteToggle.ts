import api from "../api/client";
import { canToggleActivityMute, matchesActivityMuteState, normalizeActivityMuteState } from "./channelDomain";
import { useChannelStore } from "./channelStore";
import type { Channel } from "./channelStore";
import { findStoredChannel } from "./storedChannel";

/**
 * - `skipped`: the channel has no user-reachable Activity mute; nothing sent.
 * - `saved`: the server accepted the new state.
 * - `failed`: the save failed and the optimistic state was rolled back; the
 *   caller tells the person (`activityMuted` is the state that failed to save).
 * - `superseded`: the save failed, but the channel's state has since changed
 *   (another tab or a realtime update), so it was left alone.
 */
export type ChannelActivityMuteToggleOutcome =
  | { status: "skipped" }
  | { status: "saved" | "failed" | "superseded"; activityMuted: boolean };

/**
 * Toggles the per-user Activity mute of a channel or DM, optimistically,
 * against `PATCH /channels/:id/notification-settings`. Shared by every menu
 * that offers Mute / Unmute activity for a conversation row (sidebar,
 * Activity), so they save, roll back and report failure the same way.
 */
export async function toggleChannelActivityMute(channel: Channel): Promise<ChannelActivityMuteToggleOutcome> {
  if (!canToggleActivityMute(channel)) return { status: "skipped" };
  const previous = {
    activityMuted: channel.activityMuted === true,
    muteFromSeq: channel.muteFromSeq ?? null,
    prefsVersion: channel.prefsVersion,
  };
  const nextActivityMuted = !previous.activityMuted;
  const optimistic = {
    activityMuted: nextActivityMuted,
    muteFromSeq: previous.muteFromSeq,
    prefsVersion: previous.prefsVersion,
  };
  useChannelStore.getState().setActivityMuteState(channel.id, optimistic);

  try {
    const { data } = await api.patch(`/channels/${channel.id}/notification-settings`, {
      activityMuted: nextActivityMuted,
    });
    useChannelStore.getState().setActivityMuteState(channel.id, normalizeActivityMuteState(data));
    return { status: "saved", activityMuted: nextActivityMuted };
  } catch {
    // Any slice: channels, DMs, Lounges.
    const current = findStoredChannel(useChannelStore.getState(), channel.id);
    if (!matchesActivityMuteState(current, optimistic)) {
      return { status: "superseded", activityMuted: nextActivityMuted };
    }
    useChannelStore.getState().setActivityMuteState(channel.id, previous);
    return { status: "failed", activityMuted: nextActivityMuted };
  }
}

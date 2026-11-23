import { useCallback } from "react";

import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";

/**
 * Whether the viewer may change tasks in `channel`: the browser's reading of
 * the server's gate on every task write (routes/tasks.ts
 * rejectIfNoTaskWriteAccess, then rejectIfArchived). There, write authority is
 * post authority (channelService.canUserPostToChannel): a member of the
 * channel, either side of a DM, anyone the Lounge lets post; never in an
 * archived channel. A public channel can be read without joining it, so its
 * tasks show to someone who cannot change them.
 *
 * The channel row is what the composer reads too (`joined`, `canPost`,
 * `archivedAt`). Only a known "no" hides an action: a row not loaded, or one
 * whose membership is not hydrated yet, stays writable here and the server
 * answers (a deleted channel's tasks have no row, and the server lets them be
 * closed).
 */
export function canWriteTasksInChannel(channel: Channel | undefined): boolean {
  if (!channel) return true;
  if (channel.archivedAt || channel.canPost === false) return false;
  // Nothing to join first in a DM or a Lounge (the first post joins a Lounge).
  if (channel.type === "dm" || channel.loungeAgentId) return true;
  return channel.joined !== false;
}

/** `canWriteTasksInChannel` for the stored channel `channelId`, kept current. */
export function useCanWriteTaskChannel(channelId: string | null | undefined): boolean {
  return useChannelStore((s) => canWriteTasksInChannel(findStoredChannel(s, channelId)));
}

/** The same check for any channel id: for a surface holding tasks of several channels. */
export function useTaskChannelWriteCheck(): (channelId: string) => boolean {
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  return useCallback(
    (channelId: string) => canWriteTasksInChannel(findStoredChannel({ channels, dmChannels, loungeChannels }, channelId)),
    [channels, dmChannels, loungeChannels],
  );
}

/**
 * Whether a message in `channel` offers the task actions of its menu (Mark as
 * Done / Reopen, Create task): the channel is known, is not a thread (a reply
 * carries no task), and the viewer may change tasks in it.
 */
export function offersMessageTaskActions(channel: Channel | undefined): boolean {
  return channel !== undefined && channel.type !== "thread" && canWriteTasksInChannel(channel);
}

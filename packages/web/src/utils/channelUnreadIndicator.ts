export function getChannelUnreadIndicatorState(opts: {
  unread: number;
  joined: boolean;
  showMutedIcon: boolean;
  /**
   * The unread summary's `hasNew`: a non-joined public channel with messages past
   * the cursor. It has no exact count (unread is 0), so it only lights the quiet
   * indicator of a non-joined row.
   */
  hasNew?: boolean;
  /**
   * Followed threads under the channel with unread replies (threads, not
   * replies). Lights the same badge as the channel's own unread, as a separate
   * segment.
   */
  threadUnread?: number;
  /**
   * Marked unread with nothing countable (store/markedUnreadStore): unread
   * with no number, so the quiet pixel instead of a count, and the unread
   * name of a joined, unmuted row.
   */
  markedUnread?: boolean;
}): {
  showLoudUnreadBadge: boolean;
  showQuietUnreadCount: boolean;
  showQuietNewDot: boolean;
  showMarkedUnreadDot: boolean;
  unreadTone: boolean;
} {
  const hasUnread = opts.unread > 0 || (opts.threadUnread ?? 0) > 0;
  const showLoudUnreadBadge = hasUnread && opts.joined && !opts.showMutedIcon;
  const showQuietUnreadCount = hasUnread && (!opts.joined || opts.showMutedIcon);
  const showQuietNewDot = !showQuietUnreadCount && !opts.joined && opts.hasNew === true;
  const showMarkedUnreadDot = !hasUnread && !showQuietNewDot && opts.markedUnread === true;
  const unreadTone = showLoudUnreadBadge || (showMarkedUnreadDot && opts.joined && !opts.showMutedIcon);
  return { showLoudUnreadBadge, showQuietUnreadCount, showQuietNewDot, showMarkedUnreadDot, unreadTone };
}

/**
 * The numbers a channel row's count shows (loud badge or grey count alike):
 * `5 · threads 1`. With no thread unread it is the bare unread count; with
 * thread unread, the unread segment only when there is some.
 */
export function getChannelUnreadSegments(unread: number, threadUnread: number): { unread?: number; threads?: number } {
  if (threadUnread <= 0) return { unread };
  return unread > 0 ? { unread, threads: threadUnread } : { threads: threadUnread };
}

/**
 * A DM row's unread display (DmRow, AgentDmRow, SidebarPeerRowBody). Muted is
 * the only thing that makes it quiet: a muted DM's count is grey and its name
 * muted whatever else is true (a mention does not pierce the mute).
 */
export function getDmUnreadIndicatorState(opts: {
  unread: number;
  markedUnread: boolean;
  activityMuted: boolean;
}): {
  showLoudUnreadBadge: boolean;
  showQuietUnreadCount: boolean;
  showMarkedUnreadDot: boolean;
  unreadTone: boolean;
} {
  const hasUnread = opts.unread > 0;
  const showMarkedUnreadDot = !hasUnread && opts.markedUnread;
  return {
    showLoudUnreadBadge: hasUnread && !opts.activityMuted,
    showQuietUnreadCount: hasUnread && opts.activityMuted,
    showMarkedUnreadDot,
    unreadTone: !opts.activityMuted && (hasUnread || showMarkedUnreadDot),
  };
}

export function shouldShowActivityMutedIcon(opts: {
  activityMuted: boolean | undefined;
  joined: boolean | undefined;
}): boolean {
  return opts.activityMuted === true && opts.joined === true;
}

export type SectionUnreadChannel = {
  id: string;
  activityMuted?: boolean;
};

export function hasUnmutedUnread(
  unreadCounts: Readonly<Record<string, number>>,
  channels: ReadonlyArray<SectionUnreadChannel | undefined>,
): boolean {
  return channels.some((channel) => (
    channel !== undefined
    && channel.activityMuted !== true
    && (unreadCounts[channel.id] ?? 0) > 0
  ));
}

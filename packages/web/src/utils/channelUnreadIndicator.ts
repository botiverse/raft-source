export function getChannelUnreadIndicatorState(opts: {
  unread: number;
  joined: boolean;
  showMutedIcon: boolean;
}): { showLoudUnreadBadge: boolean; showQuietUnreadCount: boolean } {
  const showLoudUnreadBadge = opts.unread > 0 && opts.joined && !opts.showMutedIcon;
  const showQuietUnreadCount = opts.unread > 0 && (!opts.joined || opts.showMutedIcon);
  return { showLoudUnreadBadge, showQuietUnreadCount };
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

/**
 * Mark as Unread on the channel the person is in: its next auto-read is
 * skipped, so the channel stays unread while they are in it. Kept per tab
 * session, so a reload doesn't read it either.
 */
const MANUAL_UNREAD_SKIP_STORAGE_KEY = "slock_manual_unread_skip";

function loadManualUnreadSkips(): Set<string> {
  try {
    const raw = sessionStorage.getItem(MANUAL_UNREAD_SKIP_STORAGE_KEY);
    if (!raw) return new Set();
    const channelIds = JSON.parse(raw);
    return Array.isArray(channelIds) ? new Set(channelIds.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function persistManualUnreadSkips(channelIds: Set<string>) {
  try {
    if (channelIds.size === 0) {
      sessionStorage.removeItem(MANUAL_UNREAD_SKIP_STORAGE_KEY);
    } else {
      sessionStorage.setItem(MANUAL_UNREAD_SKIP_STORAGE_KEY, JSON.stringify([...channelIds]));
    }
  } catch {
    // ignore storage errors
  }
}

const manualUnreadSkipChannels = loadManualUnreadSkips();

export function shouldSkipInitialAutoRead(channelId: string): boolean {
  return manualUnreadSkipChannels.has(channelId);
}

export function rememberManualUnread(channelId: string) {
  manualUnreadSkipChannels.add(channelId);
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

export function consumeManualUnread(channelId: string) {
  if (!manualUnreadSkipChannels.delete(channelId)) return;
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

export function forgetManualUnread(channelId: string) {
  if (!manualUnreadSkipChannels.delete(channelId)) return;
  persistManualUnreadSkips(manualUnreadSkipChannels);
}

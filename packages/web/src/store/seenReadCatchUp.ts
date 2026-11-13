/**
 * New content that landed in front of the person while they weren't using the
 * window (no input within the in-use window, or the window hidden or
 * unfocused), by conversation id. "If I can see it, it's read": it is read
 * when they are back (focus, visible again, or their next input), wherever
 * they are reading it (#triage:#157). The channel view and the thread panel
 * register here; messageStore's focus and input listeners run the catch-up.
 *
 * `read` reads the conversation if it is still in front of the person (still
 * open, at the bottom, the page seen) and returns true once nothing is left to
 * catch up: read, or no longer shown. False keeps it waiting.
 */
const pending = new Map<string, () => boolean>();

export function noteSkippedSeenRead(channelId: string, read: () => boolean): void {
  pending.set(channelId, read);
}

export function hasSkippedSeenRead(channelId: string | null): boolean {
  return !!channelId && pending.has(channelId);
}

/** It was read some other way, or the surface that registered it went away. */
export function forgetSkippedSeenRead(channelId: string): void {
  pending.delete(channelId);
}

export function runSeenReadCatchUp(): void {
  for (const [channelId, read] of [...pending]) {
    if (pending.get(channelId) === read && read()) pending.delete(channelId);
  }
}

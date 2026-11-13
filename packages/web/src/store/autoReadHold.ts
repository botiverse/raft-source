/**
 * A conversation Activity opened on its own (on arrival, the one opened last
 * time) shows its messages without reading them: auto-read is held for that
 * one conversation until the person acts in it (stdrc, #proj-chat 0b6ad97d).
 * The read paths ask `isAutoReadHeld(id)` with the id they are about to read:
 * messageStore's read queue (channel load, scroll to the bottom, live appends,
 * thread live replies) and ThreadPanel before it clears a thread's unread on
 * mount. Any other conversation reads as usual.
 *
 * `releaseAutoRead({ read: true })` is the person acting in the conversation:
 * the holder's callback then reads it the way an explicit open does. Leaving
 * it (another row, closing it, another page) releases without reading.
 */
let heldId: string | null = null;
let onRead: (() => void) | null = null;
let onEnd: (() => void) | null = null;

/** Holds auto-read for one conversation: a channel or DM id, or a thread's channel id. */
export function holdAutoRead(id: string, hooks: { read: () => void; end?: () => void }): void {
  releaseAutoRead({ read: false });
  heldId = id;
  onRead = hooks.read;
  onEnd = hooks.end ?? null;
}

/** Whether auto-read is held for this conversation. */
export function isAutoReadHeld(id: string | null | undefined): boolean {
  return heldId !== null && id === heldId;
}

export function heldAutoReadId(): string | null {
  return heldId;
}

export function releaseAutoRead({ read }: { read: boolean }): void {
  if (heldId === null) return;
  heldId = null;
  const readCallback = onRead;
  const endCallback = onEnd;
  onRead = null;
  onEnd = null;
  endCallback?.();
  if (read) readCallback?.();
}

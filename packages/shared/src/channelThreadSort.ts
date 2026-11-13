/**
 * Forum-style channels (#proj-chat:#24, flag `channel_thread_sort_v0`).
 *
 * `channels.thread_sort` orders a regular channel's top-level messages:
 * - `time` (default): post order, the chat timeline as always;
 * - `activity`: by latest activity, the message's own time or its latest
 *   thread reply, whichever is later. Only replies count; edits and reactions
 *   do not. Newest activity is at the bottom next to the composer, so a
 *   message that gets a reply moves to the bottom. Same order for everyone.
 */
export const CHANNEL_THREAD_SORT_VALUES = ["time", "activity"] as const;
export type ChannelThreadSort = (typeof CHANNEL_THREAD_SORT_VALUES)[number];
export const DEFAULT_CHANNEL_THREAD_SORT: ChannelThreadSort = "time";

export function isChannelThreadSort(value: unknown): value is ChannelThreadSort {
  return typeof value === "string" && (CHANNEL_THREAD_SORT_VALUES as readonly string[]).includes(value);
}

/** The channel types that may be forum-style: public and private regular channels. */
export function channelTypeSupportsThreadSort(type: string | null | undefined): boolean {
  return type === "channel" || type === "private";
}

/**
 * A top-level message's activity time in milliseconds: the later of its own
 * creation and its latest thread reply. Unparseable times count as 0.
 */
export function messageActivityAtMs(createdAt: string, lastReplyAt?: string | null): number {
  const own = Date.parse(createdAt);
  const reply = lastReplyAt ? Date.parse(lastReplyAt) : Number.NaN;
  const ownMs = Number.isFinite(own) ? own : 0;
  return Number.isFinite(reply) && reply > ownMs ? reply : ownMs;
}

/**
 * Keyset cursor of the activity-ordered page (`GET /messages/channel/:id/by-activity`):
 * the last row's activity time and seq. Pages walk from newest to oldest;
 * `before` returns rows strictly older than the cursor in (activityAt, seq).
 */
export interface ChannelActivityCursor {
  activityAt: string;
  seq: number;
}

export function encodeChannelActivityCursor(cursor: ChannelActivityCursor): string {
  return `${cursor.activityAt}~${cursor.seq}`;
}

export function decodeChannelActivityCursor(raw: unknown): ChannelActivityCursor | null {
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("~");
  if (at <= 0) return null;
  const activityAt = raw.slice(0, at);
  const seqText = raw.slice(at + 1);
  // Kept verbatim: the server writes microseconds, which a Date would round.
  if (!/^\d+$/.test(seqText) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(activityAt)) return null;
  if (!Number.isFinite(Date.parse(activityAt))) return null;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return null;
  return { activityAt, seq };
}

/** The channel field on the wire: absent from an older server means `time`. */
export interface ChannelThreadSortFields {
  threadSort?: ChannelThreadSort;
}

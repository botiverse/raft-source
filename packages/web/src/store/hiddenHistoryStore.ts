import { create } from "zustand";

/** One of the newest messages a plan's history cutoff hides, as the faded preview shows it. */
export interface HiddenHistoryMessage {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
  senderName: string | null;
  senderAvatarUrl: string | null;
  createdAt: string;
  /** One line, at most 40 characters (cut by the server); null for a message with no text. */
  preview: string | null;
}

/**
 * What the cutoff hides in a channel or thread (`hiddenHistory` on a message
 * page that reached the start of the visible window): how many messages Pro
 * would show there (chat, system, retracted placeholders; in a thread,
 * replies), counted up to the server's cap; for
 * a thread, whether its first message is hidden too; and the newest hidden
 * chat messages, oldest first (a hidden first message leads).
 */
export interface HiddenHistory {
  hiddenCount: number;
  hiddenCountCapped: boolean;
  parentHidden: boolean;
  latest: HiddenHistoryMessage[];
}

/**
 * A message that a jump pointed at, behind the cutoff (the context route's
 * `history_limited` answer): the target (80 characters), the hidden message
 * before it (in a thread, its first message) and the two after it, the
 * thread's hidden replies, and the target's own replies when it has a thread.
 */
export interface HiddenTarget {
  target: HiddenHistoryMessage & { seq: number };
  before: HiddenHistoryMessage[];
  after: HiddenHistoryMessage[];
  thread: { hiddenReplyCount: number; hiddenReplyCountCapped: boolean; parentHidden: boolean } | null;
  replies: { count: number; latest: HiddenHistoryMessage } | null;
}

/** Keyed by the channel or thread the page (or jump) was read from. */
export const useHiddenHistoryStore = create<{ byChannel: Record<string, HiddenHistory>; targetByChannel: Record<string, HiddenTarget> }>(() => ({
  byChannel: {},
  targetByChannel: {},
}));

const SENDER_TYPES = new Set<HiddenHistoryMessage["senderType"]>(["user", "agent", "external_projection"]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readHiddenHistoryMessage(value: unknown): HiddenHistoryMessage | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.senderId !== "string" || typeof row.createdAt !== "string") return null;
  if (!SENDER_TYPES.has(row.senderType as HiddenHistoryMessage["senderType"])) return null;
  return {
    id: row.id,
    senderType: row.senderType as HiddenHistoryMessage["senderType"],
    senderId: row.senderId,
    senderName: stringOrNull(row.senderName),
    senderAvatarUrl: stringOrNull(row.senderAvatarUrl),
    createdAt: row.createdAt,
    preview: stringOrNull(row.preview),
  };
}

export function readHiddenHistory(value: unknown): HiddenHistory | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.hiddenCount !== "number" || !Number.isFinite(raw.hiddenCount) || raw.hiddenCount < 0) return null;
  const latest = Array.isArray(raw.latest)
    ? raw.latest.map(readHiddenHistoryMessage).filter((row): row is HiddenHistoryMessage => row !== null)
    : [];
  return { hiddenCount: raw.hiddenCount, hiddenCountCapped: raw.hiddenCountCapped === true, parentHidden: raw.parentHidden === true, latest };
}

/**
 * Keep what a message page says about the cutoff. A page that is not limited
 * clears it; a limited page without `hiddenHistory` (one that did not reach
 * the start of the window) leaves the last answer in place.
 */
export function recordHiddenHistory(channelId: string, page: { historyLimited?: unknown; hiddenHistory?: unknown }): void {
  const { byChannel } = useHiddenHistoryStore.getState();
  if (page.historyLimited !== true) {
    if (!(channelId in byChannel)) return;
    const { [channelId]: _cleared, ...rest } = byChannel;
    useHiddenHistoryStore.setState({ byChannel: rest });
    return;
  }
  const hidden = readHiddenHistory(page.hiddenHistory);
  if (!hidden) return;
  useHiddenHistoryStore.setState({ byChannel: { ...byChannel, [channelId]: hidden } });
}

/** Forget what was hidden in a channel or thread (the plan no longer cuts it). */
export function clearHiddenHistory(channelId: string): void {
  const { byChannel, targetByChannel } = useHiddenHistoryStore.getState();
  if (!(channelId in byChannel) && !(channelId in targetByChannel)) return;
  const { [channelId]: _cleared, ...rest } = byChannel;
  const { [channelId]: _clearedTarget, ...restTargets } = targetByChannel;
  useHiddenHistoryStore.setState({ byChannel: rest, targetByChannel: restTargets });
}

function readCounts(value: unknown): HiddenTarget["thread"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.hiddenReplyCount !== "number" || raw.hiddenReplyCount < 0) return null;
  return { hiddenReplyCount: raw.hiddenReplyCount, hiddenReplyCountCapped: raw.hiddenReplyCountCapped === true, parentHidden: raw.parentHidden === true };
}

export function readHiddenTarget(value: unknown): HiddenTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const target = readHiddenHistoryMessage(raw.target);
  const seq = raw.target && typeof raw.target === "object" ? (raw.target as Record<string, unknown>).seq : undefined;
  if (!target || typeof seq !== "number" || !Number.isFinite(seq)) return null;
  const list = (items: unknown) => Array.isArray(items)
    ? items.map(readHiddenHistoryMessage).filter((row): row is HiddenHistoryMessage => row !== null)
    : [];
  const repliesRaw = raw.replies && typeof raw.replies === "object" ? raw.replies as Record<string, unknown> : null;
  const repliesLatest = repliesRaw ? readHiddenHistoryMessage(repliesRaw.latest) : null;
  const replies = repliesRaw && typeof repliesRaw.count === "number" && repliesRaw.count > 0 && repliesLatest
    ? { count: repliesRaw.count, latest: repliesLatest }
    : null;
  return { target: { ...target, seq }, before: list(raw.before), after: list(raw.after), thread: readCounts(raw.thread), replies };
}

/** Where a message sits, as the context route names it (a reply: its thread's ids). */
export interface ContextCanonicalTarget {
  kind?: string;
  channelId?: string;
  messageId?: string;
  threadParentMessageId?: string;
  threadChannelId?: string | null;
}

/**
 * The context route's answer for a target behind the cutoff: a 404 with code
 * `history_limited`, where the target sits, and the previews (null when they
 * don't parse; the jump still knows where to go).
 */
export interface HistoryLimitedAnswer {
  targetMessageId: string | null;
  canonicalTarget: ContextCanonicalTarget | null;
  hiddenTarget: HiddenTarget | null;
}

/** Read a `history_limited` answer off a failed request; anything else (a plain not found, a network error) is null. */
export function readHistoryLimitedError(error: unknown): HistoryLimitedAnswer | null {
  const response = (error as { response?: { status?: number; data?: Record<string, unknown> } } | null)?.response;
  if (response?.status !== 404 || response.data?.code !== "history_limited") return null;
  const canonicalTarget = response.data.canonicalTarget;
  return {
    targetMessageId: stringOrNull(response.data.targetMessageId),
    canonicalTarget: canonicalTarget && typeof canonicalTarget === "object" ? canonicalTarget as ContextCanonicalTarget : null,
    hiddenTarget: readHiddenTarget(response.data.hiddenTarget),
  };
}

export function recordHiddenTarget(channelId: string, target: HiddenTarget): void {
  useHiddenHistoryStore.setState((state) => ({ targetByChannel: { ...state.targetByChannel, [channelId]: target } }));
}

export function clearHiddenTarget(channelId: string): void {
  const { targetByChannel } = useHiddenHistoryStore.getState();
  if (!(channelId in targetByChannel)) return;
  const { [channelId]: _cleared, ...rest } = targetByChannel;
  useHiddenHistoryStore.setState({ targetByChannel: rest });
}

export function useHiddenTarget(channelId: string | null | undefined): HiddenTarget | null {
  return useHiddenHistoryStore((s) => (channelId ? s.targetByChannel[channelId] ?? null : null));
}

export function useHiddenHistory(channelId: string | null | undefined): HiddenHistory | null {
  return useHiddenHistoryStore((s) => (channelId ? s.byChannel[channelId] ?? null : null));
}

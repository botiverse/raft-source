import { create } from "zustand";
import { notificationPlainText } from "@botiverse/raft-shared";
import api from "../api/client";
import { delegatedByOf, isRetractedMessage } from "../components/message/delegatedMessage";
import type { Message } from "./messageStore";
import { registerServerReset } from "./serverResetRegistry";

// The conversation outline (消息时间线): what people themselves wrote in a
// channel, DM or thread. The message window holds a slice of the conversation,
// so the outline has its own data, from GET /messages/channel/:id/human-outline.
// Memory only, by channel id (a thread is its own channel).

const OUTLINE_PAGE_SIZE = 200;
/** How far one catch-up with the timeline pages back: 2,000 messages from people. */
const MAX_PAGES_BACK = 10;
/** A live row's preview length, as the server's (HUMAN_OUTLINE_PREVIEW_CHARS). */
const LIVE_PREVIEW_CHARS = 400;
/** Markdown read for a preview, as the server reads (HUMAN_OUTLINE_SOURCE_CHARS). */
const LIVE_SOURCE_CHARS = 1_000;

export interface OutlineItem {
  id: string;
  seq: number;
  createdAt: string;
  senderId: string;
  senderName: string;
  /** Plain text; empty for a message with only attachments. */
  preview: string;
  attachmentCount: number;
}

export interface ChannelOutline {
  /** Oldest first, as the rail and the card show them. */
  items: readonly OutlineItem[];
  hasMore: boolean;
}

interface OutlinePage {
  /** Newest first. */
  items: OutlineItem[];
  hasMore: boolean;
}

export const useMessageOutlineStore = create<{ byChannel: Record<string, ChannelOutline> }>(() => ({ byChannel: {} }));

function patchChannel(channelId: string, patch: (outline: ChannelOutline) => ChannelOutline): void {
  useMessageOutlineStore.setState((state) => {
    const outline = state.byChannel[channelId];
    if (!outline) return state;
    const next = patch(outline);
    return next === outline ? state : { byChannel: { ...state.byChannel, [channelId]: next } };
  });
}

function readPage(channelId: string, beforeSeq?: number) {
  const before = beforeSeq === undefined ? "" : `&before=${beforeSeq}`;
  return api.get<OutlinePage>(`/messages/channel/${channelId}/human-outline?limit=${OUTLINE_PAGE_SIZE}${before}`);
}

// A reset or a newer read of the newest page outdates what is on its way.
let resetEpoch = 0;
const newestRead = new Map<string, number>();

/** The newest page, on opening a conversation and after a reconnect. */
export async function loadOutline(channelId: string): Promise<void> {
  const epoch = resetEpoch;
  const read = (newestRead.get(channelId) ?? 0) + 1;
  newestRead.set(channelId, read);
  try {
    const { data } = await readPage(channelId);
    if (epoch !== resetEpoch || newestRead.get(channelId) !== read) return;
    const items = [...data.items].reverse();
    const newestSeq = items.at(-1)?.seq ?? 0;
    useMessageOutlineStore.setState((state) => ({
      byChannel: {
        ...state.byChannel,
        [channelId]: {
          // A live row that landed while this read was on its way.
          items: [...items, ...(state.byChannel[channelId]?.items.filter((item) => item.seq > newestSeq) ?? [])],
          hasMore: data.hasMore,
        },
      },
    }));
  } catch {
    // The outline is an aid: the rail stays as it was, or doesn't show.
  }
}

const olderReads = new Map<string, Promise<void>>();

async function readOlderPage(channelId: string, oldestSeq: number): Promise<void> {
  const epoch = resetEpoch;
  try {
    const { data } = await readPage(channelId, oldestSeq);
    if (epoch !== resetEpoch) return;
    // Not if the newest page was read again meanwhile: it starts over.
    patchChannel(channelId, (current) => (current.items[0]?.seq === oldestSeq
      ? { ...current, items: [...[...data.items].reverse(), ...current.items], hasMore: data.hasMore }
      : current));
  } catch {
    // As for the newest page; the next scroll asks again.
  }
}

/** The next older page; settles with the read already under way, if there is one. */
export function loadOlderOutline(channelId: string): Promise<void> {
  const running = olderReads.get(channelId);
  if (running) return running;
  const outline = useMessageOutlineStore.getState().byChannel[channelId];
  const oldestSeq = outline?.items[0]?.seq;
  if (!outline?.hasMore || oldestSeq === undefined) return Promise.resolve();
  const read = readOlderPage(channelId, oldestSeq).finally(() => olderReads.delete(channelId));
  olderReads.set(channelId, read);
  return read;
}

/** Pages back until the outline reaches `seq` (the timeline is older than what's loaded), or MAX_PAGES_BACK. */
export async function pageOutlineBackTo(channelId: string, seq: number): Promise<void> {
  for (let page = 0; page < MAX_PAGES_BACK; page += 1) {
    const oldestSeq = useMessageOutlineStore.getState().byChannel[channelId]?.items[0]?.seq;
    if (oldestSeq === undefined || oldestSeq <= seq) return;
    await loadOlderOutline(channelId);
    if (useMessageOutlineStore.getState().byChannel[channelId]?.items[0]?.seq === oldestSeq) return;
  }
}

/** As the server's preview (listHumanOutlineMessages): the Markdown's plain text, on one line, cut at LIVE_PREVIEW_CHARS. */
export function livePreview(content: string): string {
  return Array.from(notificationPlainText(content.slice(0, LIVE_SOURCE_CHARS)).replace(/\s+/g, " ").trim()).slice(0, LIVE_PREVIEW_CHARS).join("");
}

/** RFC 077: the wire's `delegatedByAgentId`, which Message doesn't declare (delegatedByOf reads `delegatedBy`). */
function sentByAssistant(message: Message & { delegatedByAgentId?: string | null }): boolean {
  return message.delegatedByAgentId != null;
}

/** The server's filter, on a message the socket delivered. */
function isHumanMessage(message: Message): boolean {
  return message.senderType === "user"
    && message.messageType !== "system"
    && delegatedByOf(message) === null
    && !sentByAssistant(message)
    && !isRetractedMessage(message);
}

/** A message that just arrived, on any path that can bring it twice; a no-op for anything the outline doesn't hold. */
export function noteOutlineMessage(message: Message): void {
  const seq = Number(message.seq);
  if (!seq || !isHumanMessage(message)) return;
  // Before the first page lands, a read in flight merges what arrives meanwhile
  // (loadOutline keeps items newer than its page): give it a place to land.
  if (!useMessageOutlineStore.getState().byChannel[message.channelId] && newestRead.has(message.channelId)) {
    useMessageOutlineStore.setState((state) => ({ byChannel: { ...state.byChannel, [message.channelId]: { items: [], hasMore: true } } }));
  }
  patchChannel(message.channelId, (outline) => {
    if (outline.items.some((item) => item.id === message.id)) return outline;
    const item: OutlineItem = {
      id: message.id,
      seq,
      createdAt: message.createdAt,
      senderId: message.senderId,
      senderName: message.senderName ?? "",
      // The server's preview, made the same way: plain text, not the Markdown.
      preview: livePreview(message.content),
      attachmentCount: message.attachments?.length ?? 0,
    };
    return { ...outline, items: [...outline.items, item].sort((a, b) => a.seq - b.seq) };
  });
}

/**
 * A message's new copy. Nothing edits a sent message's text today: the one
 * change that matters here is a retraction, which takes its row out.
 */
export function noteOutlineMessageUpdated(message: Message): void {
  if (!isRetractedMessage(message)) return;
  const drop = (outline: ChannelOutline) => {
    const items = outline.items.filter((item) => item.id !== message.id);
    return items.length === outline.items.length ? outline : { ...outline, items };
  };
  patchChannel(message.channelId, drop);
  // A thread's first message is an item of the thread, and lives in the parent conversation.
  if (message.threadId) patchChannel(message.threadId, drop);
}

registerServerReset(() => {
  resetEpoch += 1;
  newestRead.clear();
  olderReads.clear();
  useMessageOutlineStore.setState({ byChannel: {} });
});

import { create } from "zustand";

/** Fewer messages from people than this in a thread, and it has no outline: no rail, no Timeline in its ⋯. */
const OUTLINE_MIN_ITEMS = 4;

/** Whether a thread has an outline: people's messages in it, not counting the one it started from (conversation.md). */
export function hasOutline(items: readonly { id: string }[], leadingMessageId: string | null | undefined): boolean {
  let count = 0;
  for (const item of items) if (item.id !== leadingMessageId && ++count >= OUTLINE_MIN_ITEMS) return true;
  return false;
}

/**
 * The outline's list opened from a thread's ⋯ (Timeline): on a touch screen,
 * where there is no rail, and with a mouse where the list is too narrow for
 * it. The header opens it, the outline beside the list shows it: a bottom
 * sheet on a phone, a popover under the head (`anchor`) otherwise.
 */
export const useOutlineListStore = create<{ channelId: string | null; anchor: HTMLElement | null }>(() => ({
  channelId: null,
  anchor: null,
}));

export function openOutlineList(channelId: string, anchor: HTMLElement | null): void {
  useOutlineListStore.setState({ channelId, anchor });
}

export function closeOutlineList(): void {
  useOutlineListStore.setState({ channelId: null, anchor: null });
}

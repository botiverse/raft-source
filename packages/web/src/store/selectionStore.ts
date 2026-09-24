import { create } from "zustand";

interface SelectionState {
  /**
   * The channel ID the current selection belongs to. In channel mode this is
   * the parent channel's id; in thread mode this is the thread channel's id
   * (where the replies live). Selection is scoped to one surface — switching
   * channels or closing the thread exits select mode.
   */
  channelId: string | null;
  /**
   * Thread mode anchor: the parent message id of the open thread. Null in
   * channel mode. When set, the selectable surface is the parent message +
   * all replies of that thread (channelId === thread channel id holds the
   * replies; the parent lives in `threadRootChannelId`).
   */
  threadRootId: string | null;
  /** Parent channel of the thread root (only relevant in thread mode). */
  threadRootChannelId: string | null;
  /** Selected message IDs. Insertion order is preserved (Set). */
  selectedIds: Set<string>;
  /** True iff we are in select mode for some channel/thread. */
  isActive: boolean;
  /**
   * Enter channel-mode select. `initialIds` are the messages to start the
   * selection with — typically the message the user opened the menu on.
   */
  enter: (channelId: string, initialIds?: ReadonlyArray<string>) => void;
  /**
   * Enter thread-mode select. `threadChannelId` is the channel id on which
   * thread replies live; `threadRootId`/`threadRootChannelId` describe the
   * parent message that anchors the thread. `initialIds` is the clicked row
   * by default; ThreadPanel exposes an explicit Select all action for users
   * who want parent + every reply.
   */
  enterThread: (
    threadChannelId: string,
    threadRootId: string,
    threadRootChannelId: string,
    initialIds?: ReadonlyArray<string>,
  ) => void;
  /** Exit select mode and clear selection. */
  exit: () => void;
  /** Toggle a message id in/out of the current selection. No-op if not active. */
  toggle: (messageId: string) => void;
  /** Replace the active selection with the supplied ids. No-op if not active. */
  selectAll: (messageIds: ReadonlyArray<string>) => void;
  /**
   * Toggle a parent message together with all its already-loaded replies as
   * a group: if the parent was selected, the parent and every reply id are
   * removed; otherwise all are added. Used in channel mode so single-click
   * on a thread-anchored row keeps the "parent + replies" set intact per
   * huxijin's "默认全包, 暂不作拆分" contract. Replies are looked up from
   * the message store at call time.
   */
  toggleWithThread: (parentId: string, threadReplyIds: ReadonlyArray<string>) => void;
  /** Returns true if the given message id is currently selected. */
  isSelected: (messageId: string) => boolean;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  channelId: null,
  threadRootId: null,
  threadRootChannelId: null,
  selectedIds: new Set(),
  isActive: false,

  enter: (channelId, initialIds) =>
    set({
      channelId,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: true,
      selectedIds: initialIds && initialIds.length > 0 ? new Set(initialIds) : new Set(),
    }),

  enterThread: (threadChannelId, threadRootId, threadRootChannelId, initialIds) =>
    set({
      channelId: threadChannelId,
      threadRootId,
      threadRootChannelId,
      isActive: true,
      selectedIds: initialIds && initialIds.length > 0 ? new Set(initialIds) : new Set([threadRootId]),
    }),

  exit: () =>
    set({
      channelId: null,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: false,
      selectedIds: new Set(),
    }),

  toggle: (messageId) => {
    const state = get();
    if (!state.isActive) return;
    const next = new Set(state.selectedIds);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    set({ selectedIds: next });
  },

  selectAll: (messageIds) => {
    const state = get();
    if (!state.isActive) return;
    set({ selectedIds: new Set(messageIds) });
  },

  toggleWithThread: (parentId, threadReplyIds) => {
    const state = get();
    if (!state.isActive) return;
    const next = new Set(state.selectedIds);
    if (next.has(parentId)) {
      next.delete(parentId);
      for (const id of threadReplyIds) next.delete(id);
    } else {
      next.add(parentId);
      for (const id of threadReplyIds) next.add(id);
    }
    set({ selectedIds: next });
  },

  isSelected: (messageId) => get().selectedIds.has(messageId),
}));

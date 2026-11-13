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
   * The message the selection started on (the row Select Message was opened
   * on; a thread's parent when entered without one). Focus can return to it
   * when the selection ends where there is no composer. Null when inactive.
   */
  originId: string | null;
  /**
   * The anchor of a range selection: the message last added (or the one the
   * selection started on), while it stays selected. Shift+click / Select to here takes every message
   * from it to the target (messageRangeSelection.ts). Null when inactive or
   * after the selection is cleared.
   */
  anchorId: string | null;
  /**
   * Enter channel-mode select. `initialIds` are the messages to start the
   * selection with — typically the message the user opened the menu on.
   */
  enter: (channelId: string, initialIds?: ReadonlyArray<string>) => void;
  /**
   * Enter thread-mode select. `threadChannelId` is the channel id on which
   * thread replies live; `threadRootId`/`threadRootChannelId` describe the
   * parent message that anchors the thread. `initialIds` is the clicked row
   * by default; the thread's toolbar (SelectModeToolbar) leads with a
   * select-all checkbox for the parent + every loaded reply.
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
   * Add a range (ids computed by the caller, in any order) to the selection;
   * never removes. `targetId` becomes the anchor. No-op if not active.
   */
  selectRange: (messageIds: ReadonlyArray<string>, targetId: string) => void;
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
  originId: null,
  anchorId: null,

  enter: (channelId, initialIds) =>
    set({
      channelId,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: true,
      originId: initialIds?.[0] ?? null,
      anchorId: initialIds?.[0] ?? null,
      selectedIds: initialIds && initialIds.length > 0 ? new Set(initialIds) : new Set(),
    }),

  enterThread: (threadChannelId, threadRootId, threadRootChannelId, initialIds) =>
    set({
      channelId: threadChannelId,
      threadRootId,
      threadRootChannelId,
      isActive: true,
      originId: initialIds?.[0] ?? threadRootId,
      anchorId: initialIds?.[0] ?? threadRootId,
      selectedIds: initialIds && initialIds.length > 0 ? new Set(initialIds) : new Set([threadRootId]),
    }),

  exit: () =>
    set({
      channelId: null,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: false,
      originId: null,
      anchorId: null,
      selectedIds: new Set(),
    }),

  toggle: (messageId) => {
    const state = get();
    if (!state.isActive) return;
    const next = new Set(state.selectedIds);
    if (next.has(messageId)) {
      next.delete(messageId);
      // The anchor is the last message added that is still selected:
      // deselecting it leaves no anchor (a range from it would re-add it).
      set({ selectedIds: next, anchorId: state.anchorId === messageId ? null : state.anchorId });
      return;
    }
    next.add(messageId);
    set({ selectedIds: next, anchorId: messageId });
  },

  selectAll: (messageIds) => {
    const state = get();
    if (!state.isActive) return;
    set(messageIds.length > 0 ? { selectedIds: new Set(messageIds) } : { selectedIds: new Set(), anchorId: null });
  },

  selectRange: (messageIds, targetId) => {
    const state = get();
    if (!state.isActive) return;
    const next = new Set(state.selectedIds);
    for (const id of messageIds) next.add(id);
    set({ selectedIds: next, anchorId: targetId });
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

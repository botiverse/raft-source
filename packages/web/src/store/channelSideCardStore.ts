import { create } from "zustand";

/**
 * The cards beside a conversation's message list (task v2, #wg-task-v2): the
 * channel's Tasks and its Files, each opened from the channel header. Both can
 * be open at once; they stack in one column the person can widen, and split
 * its height between them.
 *
 * One setting for the person, not one per channel: the cards follow them from
 * channel to channel, the way the thread column does. `taskFilter` "mine"
 * narrows Tasks to the ones assigned to the viewer.
 *
 * `collapsed` folds a stacked section to its 56px head, and
 * `cardFocusAt` decides which card shows where only one fits
 * (ChannelSideArea); the Artifact's entry (`app`) is when it was last
 * picked there (its opening time comes from the viewer).
 */
export type ChannelSideCard = "tasks" | "files";
/** Every card the column can show: Task v2's two, the one an app opens there (a workspace Artifact), a message's context view and the channel details. */
export type ChannelSideColumnCard = ChannelSideCard | "app" | "context" | "details";
export type ChannelTasksFilter = "all" | "mine";

const OPEN_KEY = "slock:channelSideCards";
const COLLAPSED_KEY = "slock:channelSideCardsCollapsed";

function readFlags(key: string): Record<ChannelSideCard, boolean> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    const value = raw ? (JSON.parse(raw) as Partial<Record<ChannelSideCard, unknown>>) : {};
    return { tasks: value.tasks === true, files: value.files === true };
  } catch {
    return { tasks: false, files: false };
  }
}

function writeFlags(key: string, flags: Record<ChannelSideCard, boolean>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(flags));
  } catch {
    // Storage can be unavailable (private mode); the cards still work for the session.
  }
}

interface ChannelSideCardState {
  open: Record<ChannelSideCard, boolean>;
  collapsed: Record<ChannelSideCard, boolean>;
  /** When each card was last opened or picked; the latest one shows where only one fits. */
  cardFocusAt: Record<ChannelSideColumnCard, number>;
  taskFilter: ChannelTasksFilter;
  setCardOpen: (card: ChannelSideCard, open: boolean) => void;
  setCardCollapsed: (card: ChannelSideCard, collapsed: boolean) => void;
  focusCard: (card: ChannelSideColumnCard) => void;
  setTaskFilter: (filter: ChannelTasksFilter) => void;
}

export const useChannelSideCardStore = create<ChannelSideCardState>((set, get) => ({
  open: readFlags(OPEN_KEY),
  collapsed: readFlags(COLLAPSED_KEY),
  cardFocusAt: { tasks: 0, files: 0, app: 0, context: 0, details: 0 },
  taskFilter: "all",
  setCardOpen: (card, open) => {
    const next = { ...get().open, [card]: open };
    writeFlags(OPEN_KEY, next);
    set(open ? { open: next, cardFocusAt: { ...get().cardFocusAt, [card]: Date.now() } } : { open: next });
  },
  setCardCollapsed: (card, collapsed) => {
    const next = { ...get().collapsed, [card]: collapsed };
    writeFlags(COLLAPSED_KEY, next);
    set({ collapsed: next });
  },
  focusCard: (card) => set({ cardFocusAt: { ...get().cardFocusAt, [card]: Date.now() } }),
  setTaskFilter: (taskFilter) => set({ taskFilter }),
}));

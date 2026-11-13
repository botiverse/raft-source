import { create } from "zustand";
import {
  CHANNEL_SIDE_MAX_SAVED_WIDTH,
  CHANNEL_SIDE_MIN_SAVED_WIDTH,
  completeChannelSideLayout,
  DEFAULT_CHANNEL_SIDE_LAYOUT,
  moveChannelSideSection,
  parseChannelSideLayout,
  resizeChannelSideColumn,
  sameLayout,
} from "@botiverse/raft-shared";
import type { ChannelSideDrop, ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

import { useServerStore } from "./serverStore";

/**
 * Where the Thread, Tasks and Files sections stand right of a channel (task
 * #165): columns of stacked sections. Saved on the person's server member
 * (`channelSideLayout` in the sidebar order) when a section is dropped or a
 * column's width released; this browser keeps the last one too, for the
 * first paint and for a server where none is saved yet.
 *
 * Always complete: every section is in exactly one column
 * (`completeChannelSideLayout`), so a section opening always has a place.
 */
const KEY = "slock:channelSideLayout";

/** The Tasks / Files column's width from before the layout (columnWidthStore's `sideCards`), kept for the default. */
const LEGACY_WIDTH_KEY = "slock:channelSideCardsWidth";

function defaultLayout(): ChannelSideLayout {
  const legacy = Number(window.localStorage.getItem(LEGACY_WIDTH_KEY));
  if (!(legacy >= CHANNEL_SIDE_MIN_SAVED_WIDTH && legacy <= CHANNEL_SIDE_MAX_SAVED_WIDTH)) return DEFAULT_CHANNEL_SIDE_LAYOUT;
  return { v: 1, columns: DEFAULT_CHANNEL_SIDE_LAYOUT.columns.map((column, i) => (i === 1 ? { ...column, width: Math.round(legacy) } : column)) };
}

function read(): ChannelSideLayout {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    const parsed = raw ? parseChannelSideLayout(JSON.parse(raw)) : null;
    return completeChannelSideLayout(parsed ?? defaultLayout());
  } catch {
    return completeChannelSideLayout(DEFAULT_CHANNEL_SIDE_LAYOUT);
  }
}

function remember(layout: ChannelSideLayout) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Storage can be unavailable (private mode); the layout still holds for the session.
  }
}

/**
 * Saving it on the server member. Saves can overlap (a drop, then a released
 * resize within one round trip), and each answer, or a rollback, rewrites the
 * sidebar order: while any is in flight the layout shown is the newest one
 * asked for; once all have settled it is checked against what the newest one
 * left in the sidebar order, and only a refused newest save puts back what
 * was saved before.
 */
const sync = {
  /** The last layout the sidebar order brought: what the server holds, as far as this tab knows. */
  followed: undefined as ChannelSideLayout | null | undefined,
  /** The layout last known to be saved (or, with none saved there, this browser's): what a refused save goes back to. */
  confirmed: null as ChannelSideLayout | null,
  inFlight: 0,
  latest: 0,
  latestSaved: true,
};

function save(layout: ChannelSideLayout) {
  remember(layout);
  // No server open (yet): this browser's is all there is.
  if (!useServerStore.getState().current) {
    sync.confirmed = layout;
    return;
  }
  const seq = ++sync.latest;
  sync.inFlight += 1;
  void useServerStore.getState().updateSidebarOrder({ channelSideLayout: layout }).finally(() => {
    sync.inFlight -= 1;
    const held = useServerStore.getState().sidebarOrder.channelSideLayout;
    if (seq === sync.latest) sync.latestSaved = held !== null && sameLayout(held, layout);
    if (sync.inFlight > 0) return;
    if (sync.latestSaved) {
      sync.confirmed = layout;
      return;
    }
    // Refused: back to what the server holds, else what was last confirmed here.
    sync.followed = held;
    show(held ?? sync.confirmed);
  });
}

/** Show `layout` (the server's, or a fallback) and keep it as this browser's. */
function show(layout: ChannelSideLayout | null) {
  const next = layout ? completeChannelSideLayout(layout) : read();
  sync.confirmed = next;
  remember(next);
  if (!sameLayout(next, useChannelSideLayoutStore.getState().layout)) useChannelSideLayoutStore.setState({ layout: next });
}

interface ChannelSideLayoutState {
  layout: ChannelSideLayout;
  /** Move a section (a drop); saved once, when it lands (a drag shows nothing else until then). */
  moveSection: (section: ChannelSideSection, drop: ChannelSideDrop) => void;
  /** A column's width as dragged; `commit` saves it (on release), otherwise it only shows. */
  resizeColumn: (column: number, width: number, commit: boolean) => void;
  /** Tests: start from this layout. */
  __setLayoutForTests: (layout: ChannelSideLayout) => void;
}

export const useChannelSideLayoutStore = create<ChannelSideLayoutState>((set, get) => ({
  layout: read(),
  moveSection: (section, drop) => {
    const next = moveChannelSideSection(get().layout, section, drop);
    if (next === get().layout) return;
    save(next);
    set({ layout: next });
  },
  resizeColumn: (column, width, commit) => {
    const current = get().layout;
    const next = resizeChannelSideColumn(current, column, width);
    if (next !== current) set({ layout: next });
    if (commit) save(get().layout);
  },
  __setLayoutForTests: (layout) => {
    const next = completeChannelSideLayout(layout);
    if (!sameLayout(next, get().layout)) set({ layout: next });
  },
}));

/**
 * The server member's layout, as the sidebar order loads (a reload, a server
 * switch): it is the layout. None saved there: this browser's. A response that
 * carries the same layout (any sidebar-order write answers with the whole
 * order) changes nothing, so a width being dragged or a section being moved
 * isn't reset; nor does one while this tab's own saves are in flight.
 */
useServerStore.subscribe((state) => {
  // (A test may set no sidebar order at all: nothing to follow then.)
  if (!state.sidebarOrder) return;
  const saved = state.sidebarOrder.channelSideLayout;
  if (saved === sync.followed || (saved && sync.followed && sameLayout(saved, sync.followed))) return;
  sync.followed = saved;
  if (sync.inFlight > 0) return;
  show(saved);
});

/** Tests: forget what was followed and saved. */
export function __resetChannelSideLayoutSyncForTests() {
  Object.assign(sync, { followed: undefined, confirmed: null, inFlight: 0, latest: 0, latestSaved: true });
}

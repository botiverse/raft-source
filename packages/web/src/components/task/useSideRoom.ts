import { useLayoutEffect, useRef, useState } from "react";

import type { LiveRowResizeHandler } from "../layout/rowLayout";
import { rowRoom } from "./sideCardsLayout";

export interface SideRoom {
  /** The row's width less its columns other than the channel and the sections (rowRoom); null outside a row. */
  room: number | null;
  viewportWidth: number;
  panelWidth: number;
  panelHeight: number;
  composerHeight: number;
  /** A thread column stands in the row beside the channel (not covering it). */
  threadInRow: boolean;
  /**
   * The thread's column's width on screen, unrounded as `room` is (0 out of the row, or where the
   * channel is hidden): it gives way to the other columns down to its minimum.
   */
  threadWidth: number;
  /** The thread is in Focus Mode, covering the row. */
  threadMaximized: boolean;
  /** The thread covers the row by the row's own width (index.css: a row under 720px, or a portrait window under 1280px). */
  threadCoversRow: boolean;
  /** The row's whole width: the room the plan shares out (#189). */
  rowWidth: number;
  /** A thread column is open in the row, standing in it or folded over the conversation. */
  threadOpen: boolean;
  /** A legacy task panel is in the row: the plan doesn't lay out a row it doesn't know. */
  legacyTask: boolean;
  /** A touch tablet in portrait under 1280px (responsive.md: the thread alone there, as on an iPad mini). */
  touchPortrait: boolean;
}

const MESSAGES_SELECTOR = '[data-testid="message-content-surface"]';
const TOUCH_PORTRAIT = "(pointer: coarse) and (orientation: portrait) and (max-width: 1279.98px)";

/** What the plan reads of the row (#189): its width, the thread and the profile open in it, a legacy panel, a portrait tablet. */
function measurePlan(row: HTMLElement | null) {
  const thread = row?.querySelector<HTMLElement>(":scope > .thread-side-column") ?? null;
  return {
    rowWidth: row ? row.getBoundingClientRect().width : 0,
    threadOpen: !!thread && getComputedStyle(thread).display !== "none",
    legacyTask: !!row?.querySelector(':scope > :is([data-testid="legacy-task-panel"], [data-legacy-task-panel-fallback])'),
    touchPortrait: typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(TOUCH_PORTRAIT).matches,
  };
}

export function measureRoom(row: HTMLElement | null, panel: HTMLElement | null): SideRoom {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const threadMaximized = row?.dataset.threadMaximized === "true";
  const plan = measurePlan(row);
  if (!panel) return { room: row ? rowRoom(row) : null, viewportWidth, panelWidth: 0, panelHeight: 0, composerHeight: 0, threadInRow: false, threadWidth: 0, threadMaximized, threadCoversRow: false, ...plan };
  const box = panel.getBoundingClientRect();
  const messages = panel.querySelector(MESSAGES_SELECTOR);
  const composerHeight = messages ? Math.max(0, Math.round(box.bottom - messages.getBoundingClientRect().bottom)) : 0;
  const thread = row?.querySelector<HTMLElement>(":scope > .thread-side-column") ?? null;
  const style = thread ? getComputedStyle(thread) : null;
  const threadShown = !!style && style.display !== "none";
  const threadInRow = threadShown && style.position !== "absolute";
  const room = row ? rowRoom(row) : box.width;
  // Where the channel is folded away (a profile beside the thread: rowRoom's 0) the thread fills the row: it gives
  // nothing. Covering it (index.css), the channel keeps its box, hidden under the thread, and the thread gives its width.
  const channel = row?.querySelector<HTMLElement>(":scope > .thread-main-column") ?? null;
  const channelFolded = !!channel && getComputedStyle(channel).display === "none";
  const threadWidth = threadInRow && thread && !channelFolded ? thread.getBoundingClientRect().width : 0;
  return { room, viewportWidth, panelWidth: box.width, panelHeight: box.height, composerHeight, threadInRow, threadWidth, threadMaximized, threadCoversRow: threadShown && !threadInRow, ...plan };
}

export function sameRoom(a: SideRoom, b: SideRoom): boolean {
  return a.room === b.room && a.viewportWidth === b.viewportWidth && a.panelWidth === b.panelWidth && a.panelHeight === b.panelHeight
    && a.composerHeight === b.composerHeight && a.threadInRow === b.threadInRow && a.threadMaximized === b.threadMaximized
    && a.threadWidth === b.threadWidth && a.threadCoversRow === b.threadCoversRow && a.rowWidth === b.rowWidth && a.threadOpen === b.threadOpen
    && a.legacyTask === b.legacyTask && a.touchPortrait === b.touchPortrait;
}

/**
 * Watches the layout row (its own children coming and going, Focus Mode) and
 * the channel panel holding the float slot (its size, the composer growing).
 * Continuous width changes that keep the row's plan topology apply `--row-width`
 * directly before paint without re-rendering React; when topology changes, target
 * geometry still lands before paint while `setRoom` updates React chrome.
 */
export function useSideRoom(
  row: HTMLElement | null,
  floatSlot: HTMLElement | null,
  onContinuousResize?: { current: LiveRowResizeHandler | null },
): SideRoom {
  const [room, setRoom] = useState<SideRoom>(() => measureRoom(row, floatSlot?.parentElement ?? null));
  const roomRef = useRef(room);
  useLayoutEffect(() => {
    roomRef.current = room;
  }, [room]);
  useLayoutEffect(() => {
    if (!row) return;
    const panel = floatSlot?.parentElement ?? null;
    const update = (live: boolean) => {
      const next = measureRoom(row, panel);
      const prev = roomRef.current;
      if (sameRoom(prev, next)) return;
      roomRef.current = next;
      if (live && onContinuousResize?.current?.(prev, next)) return;
      setRoom(live ? () => ({ ...roomRef.current }) : next);
    };
    update(false);
    const onLive = () => update(true);
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onLive) : null;
    const watchChildren = () => {
      for (const child of Array.from(row.children)) resize?.observe(child);
    };
    resize?.observe(row);
    watchChildren();
    if (panel) resize?.observe(panel);
    const messages = panel?.querySelector(MESSAGES_SELECTOR);
    if (messages) resize?.observe(messages);
    // Only the row's own children (a thread or profile opening) and its Focus Mode flag; never the message list.
    const mutations = typeof MutationObserver !== "undefined" ? new MutationObserver(() => {
      watchChildren();
      onLive();
    }) : null;
    mutations?.observe(row, { childList: true, attributes: true, attributeFilter: ["data-thread-maximized"] });
    window.addEventListener("resize", onLive);
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", onLive);
    };
  }, [floatSlot, onContinuousResize, row]);
  return room;
}

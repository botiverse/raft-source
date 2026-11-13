import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

// Composer textarea autosizing (task #20, WAWQAQ's 0.1.9 typing-lag report —
// the old implementation ran a write-then-measure forced full-document layout
// inside every keystroke handler, ahead of the character's own paint).
// Layered per the task-#19 system design:
//  - PRIMARY: `field-sizing: content` — the browser owns the height between
//    the existing CSS min/max bounds; NO script work per key at all.
//    Electron 36 (Chromium 136) supports it, as does any current Chromium.
//  - FALLBACK (engines without it): bounded measurement, rAF-coalesced so the
//    keystroke handler never pays for a layout pass (bursts collapse to one
//    measurement per frame), with the min-height read cached and invalidated
//    on width changes.

// (globalThis.CSS: callers may shadow the bare `CSS` identifier — dnd-kit's
// utility import does in MessageInput.)
const cssGlobal = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } }).CSS;
export const SUPPORTS_FIELD_SIZING =
  typeof cssGlobal?.supports === "function" && cssGlobal.supports("field-sizing", "content");

// raft-ui's composer input caps at max-h-32 (128px, five 24px lines and the
// padding); the script path stops at the same height.
export const COMPOSER_MAX_HEIGHT_PX = 128;

export function useComposerAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  options: { fieldSizingSupported?: boolean } = {},
) : {
  autoResize: () => void;
  scheduleAutoResize: () => void;
  cancelScheduledAutoResize: () => void;
} {
  const fieldSizing = options.fieldSizingSupported ?? SUPPORTS_FIELD_SIZING;
  const minHeightRef = useRef<number | null>(null);
  const resizeRafRef = useRef(0);

  const autoResize = useCallback(() => {
    if (fieldSizing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (minHeightRef.current === null) {
      minHeightRef.current = parseFloat(getComputedStyle(el).minHeight) || 0;
    }
    el.style.height = `${Math.max(Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX), minHeightRef.current)}px`;
  }, [fieldSizing, textareaRef]);

  const scheduleAutoResize = useCallback(() => {
    if (fieldSizing) return;
    if (resizeRafRef.current !== 0) return;
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = 0;
      autoResize();
    });
  }, [fieldSizing, autoResize]);

  // Drop a queued coalesced measurement so it cannot run after a synchronous
  // height clear and overwrite it. The next keystroke schedules a fresh frame,
  // so typing still autosizes.
  const cancelScheduledAutoResize = useCallback(() => {
    if (resizeRafRef.current === 0) return;
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = 0;
  }, []);

  // Reset the id as well as cancelling: StrictMode replays mount effects.
  useEffect(() => cancelScheduledAutoResize, [cancelScheduledAutoResize]);

  // Width changes (panel resize, breakpoint) change both wrap points and the
  // effective min-height style — re-measure with the cache invalidated. Height
  // mutations from autoResize itself are ignored via the width comparison.
  useEffect(() => {
    if (fieldSizing) return;
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      minHeightRef.current = null;
      scheduleAutoResize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fieldSizing, textareaRef, scheduleAutoResize]);

  return { autoResize, scheduleAutoResize, cancelScheduledAutoResize };
}

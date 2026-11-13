// The size of the assistant's popover on a desktop (#proj-assistant:8453f881,
// Artea; Jasper's rules): resized from its top edge, its left edge or its
// top-left corner (it is pinned to the bottom-right, by Ottie), between 320x360
// and the window less 16px all round (never over the top bar), remembered on
// this device. A double click on a handle goes back to the default.

import { create } from "zustand";

export type PanelSize = { width: number; height: number };

export const PANEL_DEFAULT: PanelSize = { width: 380, height: 540 };
export const PANEL_MIN: PanelSize = { width: 320, height: 360 };
/** Kept clear on every side of the window. */
export const PANEL_MARGIN = 16;
/** The top bar it never covers. */
const TOP_BAR = 44;

const STORAGE_KEY = "raft.assistantOtter.panelSize";

/** The largest it may be in this window. */
export function panelMax(viewport: { width: number; height: number }): PanelSize {
  return {
    width: Math.max(PANEL_MIN.width, viewport.width - PANEL_MARGIN * 2),
    height: Math.max(PANEL_MIN.height, viewport.height - TOP_BAR - PANEL_MARGIN * 2),
  };
}

/**
 * The largest it may be where it is (Jasper, #14073): pinned at its bottom-right
 * (above Ottie), it grows up and to the left, so its right and bottom edges set
 * the room: 16px from the window's left, and the top bar plus 16px above.
 */
export function panelMaxAt(rect: { right: number; bottom: number }): PanelSize {
  return {
    width: Math.max(PANEL_MIN.width, Math.floor(rect.right - PANEL_MARGIN)),
    height: Math.max(PANEL_MIN.height, Math.floor(rect.bottom - TOP_BAR - PANEL_MARGIN)),
  };
}

/** The popover's collision padding, the same rule: clear of the top bar plus 16px, and 16px elsewhere. */
export const PANEL_COLLISION_PADDING = { top: TOP_BAR + PANEL_MARGIN, right: PANEL_MARGIN, bottom: PANEL_MARGIN, left: PANEL_MARGIN } as const;

export function clampPanelSize(size: PanelSize, viewport: { width: number; height: number }, at?: { right: number; bottom: number } | null): PanelSize {
  const whole = panelMax(viewport);
  const here = at ? panelMaxAt(at) : null;
  const max = here ? { width: Math.min(whole.width, here.width), height: Math.min(whole.height, here.height) } : whole;
  return {
    width: Math.round(Math.min(max.width, Math.max(PANEL_MIN.width, size.width))),
    height: Math.round(Math.min(max.height, Math.max(PANEL_MIN.height, size.height))),
  };
}

function readSize(): PanelSize | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const { width, height } = value as Record<string, unknown>;
    return typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
  } catch {
    return null;
  }
}

const usePanelSizeStore = create<{ size: PanelSize | null }>(() => ({ size: readSize() }));

/** The remembered size, or null for the default. */
export function usePanelSize(): PanelSize | null {
  return usePanelSizeStore((state) => state.size);
}

/** Remembers `size` on this device; null goes back to the default. */
export function setPanelSize(size: PanelSize | null): void {
  usePanelSizeStore.setState({ size });
  try {
    if (size) localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the size holds until the page reloads.
  }
}

export function resetPanelSizeForTests(): void {
  usePanelSizeStore.setState({ size: null });
}

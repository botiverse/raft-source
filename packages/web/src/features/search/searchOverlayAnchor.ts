import type { CSSProperties } from "react";

/**
 * Desktop search-overlay anchor contract (WAWQAQ, 2026-09-24: "Slack 的锚点是挂
 * 在上面的搜索框那里"). In Slack the search panel grows out of the top search
 * field: the panel's top edge sits on the field's top edge and the panel header
 * IS the input. Horizontally the panel is centred on the window on both the
 * desktop and the web (WAWQAQ 2026-10-13), so it sits in the same place in both. Whoever renders the top
 * bar publishes the field's geometry as CSS custom properties on <html>: the
 * web's AppTopBar at desktop width (task #753), the desktop shell's title bar.
 * The overlay consumes them here. Anything without the variables — the
 * host-shell embed, an older desktop shell — falls back to the placements
 * below, so this is a pure CSS contract with no gating.
 */
export const DESKTOP_SEARCH_ANCHOR_VARS = {
  /** px from the viewport top to the search field's top edge */
  top: "--desktop-search-anchor-top",
  /** px width of the search field (informational; the panel keeps a readable minimum) */
  width: "--desktop-search-anchor-width",
} as const;

// Fallback = the pre-anchor placement EXACTLY (Web / shells that publish no
// anchor must not move). The old card sat in Modal's `p-4` container with
// `my-[8vh] self-start` inside an `m-auto` wrapper and `h-[min(680px,80vh)]`:
// vertically centred while card + 16vh margins fit the viewport, otherwise
// pinned at 16px + 8vh. That is max(8vh + 16px, (100vh - H) / 2) with the old
// height H = min(680px, 80vh). (Checked: 1000px window → 160px both ways,
// 800px → 80px, 700px → 72px.)
export const SEARCH_OVERLAY_FALLBACK_HEIGHT = "min(680px, 80vh)";
export const SEARCH_OVERLAY_FALLBACK_TOP = `max(calc(8vh + 16px), calc((100vh - ${SEARCH_OVERLAY_FALLBACK_HEIGHT}) / 2))`;

/** raft-ui DialogContent's top edge under `placement="top"` (dialog.md, "At the top"). */
export const DIALOG_TOP_VAR = "--dialog-top";

/**
 * Marks the top bar's search field (AppTopBar): the overlay grows out of it, and
 * focus goes back to it when the overlay is dismissed.
 */
export const SEARCH_ANCHOR_FIELD_SELECTOR = "[data-search-anchor-field]";

/**
 * Inline style for the overlay card, a raft-ui DialogContent with
 * `placement="top"`: its top edge (`--dialog-top`) on the field's top edge,
 * horizontally centred on the window, width the same readable panel width as
 * before, height bounded by the space below the anchor. The `var()` fallbacks
 * reproduce the old centred card (see SEARCH_OVERLAY_FALLBACK_TOP).
 */
/**
 * Column placement (task #143), for a web surface WITHOUT the top bar: today
 * that is the host-shell embed at desktop width (the signed-in web app has the
 * bar since task #753 and anchors to its field instead). There is no search
 * field to grow out of, and the centred fallback landed mid-way through the
 * channel header's tab row, so the panel's top sits at the top of the content column — its
 * input where the channel title is, the same "search lives at the top" read as
 * Slack and the desktop. Horizontally it is centred on the whole window, like
 * the desktop's panel (WAWQAQ 2026-10-13), so both apps put it in the same
 * place; it may overlap the sidebar's edge, as any transient overlay does.
 */
export type SearchOverlayColumn = { top: number };

/** Gap between the content column's top edge and the panel. */
export const SEARCH_OVERLAY_COLUMN_INSET_PX = 8;

export function searchOverlayColumnFromRect(rect: { top: number }): SearchOverlayColumn {
  return { top: rect.top + SEARCH_OVERLAY_COLUMN_INSET_PX };
}

export function searchOverlayCardStyle(column?: SearchOverlayColumn | null): CSSProperties {
  if (column) {
    const top = `${column.top}px`;
    return {
      [DIALOG_TOP_VAR]: top,
      width: "min(720px, 92vw)",
      height: `min(${SEARCH_OVERLAY_FALLBACK_HEIGHT}, calc(100vh - ${top} - 24px))`,
    } as CSSProperties;
  }
  const top = `var(${DESKTOP_SEARCH_ANCHOR_VARS.top}, ${SEARCH_OVERLAY_FALLBACK_TOP})`;
  return {
    // raft-ui's `placement="top"` puts the dialog's top edge here and keeps it
    // centred on the window, not on the field (WAWQAQ 2026-10-13): the field
    // sits a little right of centre (the traffic lights pad the bar's left),
    // and the panel is wider than the field, so it still covers it.
    [DIALOG_TOP_VAR]: top,
    // As wide as the anchor field when the shell publishes one (the panel reads
    // as the field expanding, Slack), never narrower than the readable minimum.
    width: `max(var(${DESKTOP_SEARCH_ANCHOR_VARS.width}, 0px), min(720px, 92vw))`,
    // Fallback height = the old cap (the calc() term never bites with the
    // fallback top); it only bites when an anchored top would push the card
    // past the window bottom.
    height: `min(${SEARCH_OVERLAY_FALLBACK_HEIGHT}, calc(100vh - ${top} - 24px))`,
  } as CSSProperties;
}

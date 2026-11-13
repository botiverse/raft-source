import type { CSSProperties } from "react";

/**
 * The docked profile panel's own box, shared with the fallback MainLayout shows while the panel's code loads, so
 * the first frame already has the panel's size and place (Raft DS › Responsive layout, "The first frame is the
 * settled one"). Before, the fallback filled the rest of the row and the panel then snapped to its saved width.
 *
 * - On a phone and a narrow tablet the panel covers the page.
 * - From 1024px it is an inline column at the remembered detail width (`columnWidthStore`, "detail").
 */
export const PROFILE_PANEL_OVERLAY_CLASS = "absolute inset-0 z-cover flex flex-col border-l-0 lg:relative lg:inset-auto lg:z-auto";

/** The inline desktop size: the remembered width, neither growing nor shrinking in the row. */
export function profilePanelDesktopStyle(width: number): CSSProperties {
  return { width, flex: "0 0 auto" };
}

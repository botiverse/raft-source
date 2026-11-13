import type { CSSProperties } from "react";

/**
 * The legacy task side panel's own box, shared with the fallback MainLayout shows while its code loads, so the first
 * frame already has the panel's size and place (Raft DS › Responsive layout, "The first frame is the settled one").
 * It covers the page below 1024px and is an inline column at the remembered detail width from there.
 */
export const LEGACY_TASK_SIDE_PANEL_CLASS = "absolute inset-0 z-cover flex flex-col bg-layer-canvas lg:relative lg:inset-auto lg:z-auto lg:max-w-[calc(100%-160px)] lg:border-l lg:border-line-seam";

export function legacyTaskSidePanelDesktopStyle(width: number): CSSProperties {
  return { width };
}

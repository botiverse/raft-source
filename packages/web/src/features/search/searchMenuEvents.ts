import type { MouseEvent as ReactMouseEvent } from "react";

// Focus the context menu's first item when it mounts, so keyboard users land
// inside the menu they just opened.
export function focusFirstMenuButton(node: HTMLDivElement | null) {
  node?.querySelector<HTMLButtonElement>("button")?.focus();
}

// Keep presses inside the context menu from reaching the dismiss backdrop.
export function stopMouseDownPropagation(event: ReactMouseEvent) {
  event.stopPropagation();
}

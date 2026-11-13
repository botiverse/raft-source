// The shortcut registry's public entry (#proj-frontend:#37): what a web app (src/apps/*) may use, the one module of
// features/shortcuts on scripts/ci/check-app-module-boundaries.ts's allowlist. Core code imports the modules directly.

export { isModalLayerOpen, matchesShortcut, SHORTCUT_SCOPE_ATTRIBUTE } from "./dispatcher";
export type { ShortcutHandler } from "./dispatcher";
export { useShortcut } from "./useShortcut";
export type { UseShortcutOptions } from "./useShortcut";
export { useShortcutBinding } from "./useShortcutBinding";
export type { ShortcutBinding } from "./useShortcutBinding";
export { useShortcutLayer } from "./useShortcutLayer";
export type { UseShortcutLayerOptions } from "./useShortcutLayer";

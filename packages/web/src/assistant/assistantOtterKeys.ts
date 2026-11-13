// The otter's shortcut on the web (#proj-assistant:#21): the platform's Mod key and the typing check its handler
// uses (AssistantOtterShortcut.tsx). Which shortcut is in effect is the shortcut registry's ("assistant-otter",
// features/shortcuts/overridesState.ts), changed in the keyboard shortcuts panel.

/** ⌘ on Apple platforms, Ctrl elsewhere (utils/keyboardShortcuts.ts reads the platform the same way). */
export function isApplePlatform(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE) !== null;
}

import type { IntlShape } from "react-intl";

export interface KeyboardShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

function isApplePlatform(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

export function isGlobalSearchShortcut(
  event: KeyboardShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "k") return false;
  return isApplePlatform(platform) ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
}

export function getGlobalSearchShortcutLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  formatMessage?: IntlShape["formatMessage"],
): string {
  if (isApplePlatform(platform)) return "⌘K";
  return formatMessage
    ? formatMessage({ id: "common.shortcut.ctrlK" })
    : "Ctrl+K";
}

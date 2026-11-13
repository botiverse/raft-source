import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { MessageId } from "../../i18n/messages/en";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";

/**
 * Keys a person can't give a command, with the reason the panel says: the browser keeps them (the page never sees
 * the key, or taking it breaks the browser), the OS does, or they are a text field's own editing keys. Checked on
 * both platforms, since a person's shortcuts are stored once for every device (`mod`): Ctrl+Q is free on Windows,
 * but on a Mac it is ⌘Q.
 */
export type ReservedReason =
  | "browserCloseTab" | "browserOpenTab" | "browserNewWindow" | "browserReopenTab" | "browserCloseWindow"
  | "browserSwitchTab" | "browserReload" | "browserAddressBar" | "browserZoom" | "browserDevTools" | "browserMenu"
  | "macQuit" | "macHide" | "macMinimize" | "macSwitchApps" | "macSwitchWindows" | "macSpotlight" | "macInputSource"
  | "macScreenshot" | "macForceQuit"
  | "windowsSecurity" | "windowsCloseWindow" | "windowsSwitchApps" | "windowsStartMenu" | "windowsTaskManager"
  | "windowsInputSource" | "windowsWindowMenu"
  | "textEditing";

export const RESERVED_REASON_MESSAGES: Readonly<Record<ReservedReason, MessageId>> = {
  browserCloseTab: "keyboardShortcuts.reserved.browserCloseTab",
  browserOpenTab: "keyboardShortcuts.reserved.browserOpenTab",
  browserNewWindow: "keyboardShortcuts.reserved.browserNewWindow",
  browserReopenTab: "keyboardShortcuts.reserved.browserReopenTab",
  browserCloseWindow: "keyboardShortcuts.reserved.browserCloseWindow",
  browserSwitchTab: "keyboardShortcuts.reserved.browserSwitchTab",
  browserReload: "keyboardShortcuts.reserved.browserReload",
  browserAddressBar: "keyboardShortcuts.reserved.browserAddressBar",
  browserZoom: "keyboardShortcuts.reserved.browserZoom",
  browserDevTools: "keyboardShortcuts.reserved.browserDevTools",
  browserMenu: "keyboardShortcuts.reserved.browserMenu",
  macQuit: "keyboardShortcuts.reserved.macQuit",
  macHide: "keyboardShortcuts.reserved.macHide",
  macMinimize: "keyboardShortcuts.reserved.macMinimize",
  macSwitchApps: "keyboardShortcuts.reserved.macSwitchApps",
  macSwitchWindows: "keyboardShortcuts.reserved.macSwitchWindows",
  macSpotlight: "keyboardShortcuts.reserved.macSpotlight",
  macInputSource: "keyboardShortcuts.reserved.macInputSource",
  macScreenshot: "keyboardShortcuts.reserved.macScreenshot",
  macForceQuit: "keyboardShortcuts.reserved.macForceQuit",
  windowsSecurity: "keyboardShortcuts.reserved.windowsSecurity",
  windowsCloseWindow: "keyboardShortcuts.reserved.windowsCloseWindow",
  windowsSwitchApps: "keyboardShortcuts.reserved.windowsSwitchApps",
  windowsStartMenu: "keyboardShortcuts.reserved.windowsStartMenu",
  windowsTaskManager: "keyboardShortcuts.reserved.windowsTaskManager",
  windowsInputSource: "keyboardShortcuts.reserved.windowsInputSource",
  windowsWindowMenu: "keyboardShortcuts.reserved.windowsWindowMenu",
  textEditing: "keyboardShortcuts.reserved.textEditing",
};

/** "m" ⌘ (mac only), "c" Control, "a" ⌥ / Alt, "s" ⇧, then the key, lowercase: "ms+t". */
type Entry = readonly [chord: string, reason: ReservedReason];

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ZOOM = ["0", "=", "+", "-"];
const EDITING = ["c", "v", "x", "a", "z"];

const MAC: readonly Entry[] = [
  ["m+q", "macQuit"], ["m+w", "browserCloseTab"], ["m+t", "browserOpenTab"], ["m+n", "browserNewWindow"],
  ["ms+n", "browserNewWindow"], ["ms+t", "browserReopenTab"], ["ms+w", "browserCloseWindow"],
  ["m+h", "macHide"], ["ma+h", "macHide"], ["m+m", "macMinimize"], ["m+tab", "macSwitchApps"], ["ms+tab", "macSwitchApps"],
  ["m+`", "macSwitchWindows"], ["m+ ", "macSpotlight"], ["c+ ", "macInputSource"], ["ma+escape", "macForceQuit"],
  ["ms+3", "macScreenshot"], ["ms+4", "macScreenshot"], ["ms+5", "macScreenshot"], ["ms+#", "macScreenshot"], ["ms+$", "macScreenshot"], ["ms+%", "macScreenshot"],
  ["m+r", "browserReload"], ["ms+r", "browserReload"], ["m+l", "browserAddressBar"], ["ma+i", "browserDevTools"],
  ["ms+z", "textEditing"],
  ...EDITING.map((key): Entry => [`m+${key}`, "textEditing"]),
  ...ZOOM.map((key): Entry => [`m+${key}`, "browserZoom"]),
  ...DIGITS.map((key): Entry => [`m+${key}`, "browserSwitchTab"]),
];

const OTHER: readonly Entry[] = [
  ["c+w", "browserCloseTab"], ["c+t", "browserOpenTab"], ["c+n", "browserNewWindow"], ["cs+n", "browserNewWindow"],
  ["cs+t", "browserReopenTab"], ["cs+w", "browserCloseWindow"], ["c+tab", "browserSwitchTab"], ["cs+tab", "browserSwitchTab"],
  ["c+pagedown", "browserSwitchTab"], ["c+pageup", "browserSwitchTab"],
  ["ca+delete", "windowsSecurity"], ["a+f4", "windowsCloseWindow"], ["a+tab", "windowsSwitchApps"], ["c+escape", "windowsStartMenu"],
  ["cs+escape", "windowsTaskManager"], ["c+ ", "windowsInputSource"], ["a+ ", "windowsWindowMenu"],
  ["c+r", "browserReload"], ["cs+r", "browserReload"], ["c+l", "browserAddressBar"], ["cs+i", "browserDevTools"],
  ["a+d", "browserAddressBar"], ["a+e", "browserMenu"], ["a+f", "browserMenu"],
  ["c+y", "textEditing"], ["cs+z", "textEditing"],
  ...EDITING.map((key): Entry => [`c+${key}`, "textEditing"]),
  ...ZOOM.map((key): Entry => [`c+${key}`, "browserZoom"]),
  ...DIGITS.map((key): Entry => [`c+${key}`, "browserSwitchTab"]),
];

const TABLES: Readonly<Record<KeyboardPlatform, ReadonlyMap<string, ReservedReason>>> = {
  mac: new Map(MAC),
  other: new Map(OTHER),
};

/** The combo as that platform reads it: ⌘ is `mod` on a Mac only; elsewhere `mod` and `ctrl` are both Ctrl. */
export function chordOf(combo: ShortcutCombo, platform: KeyboardPlatform): string {
  const mac = platform === "mac";
  const flags = `${mac && combo.mod ? "m" : ""}${(mac ? combo.ctrl : combo.mod || combo.ctrl) ? "c" : ""}${combo.alt ? "a" : ""}${combo.shift ? "s" : ""}`;
  return `${flags}+${combo.key.toLowerCase()}`;
}

/** Why `combo` can't be a command's, on the first platform (this one, then the other) that keeps it; null if neither does. */
export function reservedReason(combo: ShortcutCombo, platform: KeyboardPlatform): { reason: ReservedReason; platform: KeyboardPlatform } | null {
  for (const candidate of [platform, platform === "mac" ? "other" : "mac"] as const) {
    const reason = TABLES[candidate].get(chordOf(combo, candidate));
    if (reason) return { reason, platform: candidate };
  }
  return null;
}

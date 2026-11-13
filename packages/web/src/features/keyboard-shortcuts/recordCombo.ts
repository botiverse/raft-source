import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo, ShortcutModifiers } from "../../utils/keyboardShortcuts";

/** The keys that are only modifiers: held alone they show live in the recorder and never commit. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS", "AltGraph", "Hyper", "Super", "CapsLock", "Fn"]);

/** The US-QWERTY character of each punctuation key, by `code`. */
const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Slash: "/", Backslash: "\\", Period: ".", Comma: ",", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
};

export interface RecordedKey {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function isModifierKey(event: RecordedKey): boolean {
  return MODIFIER_KEYS.has(event.key);
}

/** The modifiers held, as a combo writes them on this platform: ⌘ is `mod` on a Mac, Ctrl is `mod` elsewhere. */
export function heldModifiers(event: RecordedKey, platform: KeyboardPlatform): ShortcutModifiers {
  const mac = platform === "mac";
  const held: ShortcutModifiers = {};
  if (mac ? event.metaKey : event.ctrlKey) held.mod = true;
  if (mac && event.ctrlKey) held.ctrl = true;
  if (event.altKey) held.alt = true;
  if (event.shiftKey) held.shift = true;
  return held;
}

/**
 * The combo a keydown records, as the registry's matcher will hear it (features/shortcuts/match.ts): a letter or
 * digit by its physical key (a Russian layout's л on the K key is K; ⌥M on a Mac types µ, it is M), named keys as
 * `KeyboardEvent.key` (Enter, ArrowUp, F5), punctuation as typed (⇧/ on US is ?), or by its key where ⌥ changed it.
 * Null for a modifier alone, or a Windows-key combo elsewhere (the OS's).
 */
export function comboFromKeydown(event: RecordedKey, platform: KeyboardPlatform): ShortcutCombo | null {
  if (isModifierKey(event)) return null;
  if (platform !== "mac" && event.metaKey) return null;
  const code = event.code ?? "";
  let key: string;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  // A digit key by its place (AZERTY types & on it), unless ⇧ typed punctuation there (German ⇧7 is /).
  else if (/^Digit[0-9]$/.test(code)) key = event.shiftKey && /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(event.key) ? event.key : code.slice(5);
  else if (event.key.length === 1 && event.key !== " ") {
    // Punctuation: as typed, unless ⌥ (or a dead key) changed it, then by its key.
    const byCode = PUNCTUATION_BY_CODE[code];
    key = byCode && (event.altKey || /[^\x20-\x7e]/.test(event.key)) ? byCode : event.key.toUpperCase();
  } else if (event.key === " " || code === "Space") key = " ";
  else if (event.key === "Dead" || event.key === "Unidentified") {
    const byCode = PUNCTUATION_BY_CODE[code];
    if (!byCode) return null;
    key = byCode;
  } else key = event.key;
  return { ...heldModifiers(event, platform), key };
}

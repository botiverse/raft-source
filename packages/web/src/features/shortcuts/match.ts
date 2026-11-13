import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { KeyboardShortcutEvent, ShortcutCombo } from "../../utils/keyboardShortcuts";

/** The US-QWERTY physical key of each punctuation key a combo may name. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  "/": "Slash", "\\": "Backslash", ".": "Period", ",": "Comma", ";": "Semicolon", "'": "Quote",
  "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "`": "Backquote",
};

const LATIN_ALNUM = /^[a-z0-9]$/i;
/**
 * Keys that are shortcuts of their own with ⌘ / Ctrl wherever a layout types them: a Latin letter or digit
 * (Dvorak types `t` on the K key, `z` on the `/` key), and the browser's zoom (⌘− / ⌘= / ⌘+: German, Spanish
 * and Nordic layouts type `-` on the US `/` key). The physical key never stands in for one of these.
 */
const NEVER_BY_PLACE = /^[a-z0-9=+-]$/i;

/** Whether `code` is the physical key a combo's key sits on in US-QWERTY (KeyK, Digit1, Slash); never for a named key. */
function isComboCode(code: string | undefined, combo: ShortcutCombo): boolean {
  const { key } = combo;
  if (!code) return false;
  if (/^[a-z]$/i.test(key)) return code === "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return code === "Digit" + key;
  return PUNCTUATION_CODES[key] === code;
}

/**
 * Mid-composition in an input method (Chinese, Japanese, Korean): the key belongs to the IME. Safari reports the
 * Enter that commits a candidate after compositionend, with keyCode 229; some IMEs send `key: "Process"`.
 */
export function isImeComposing(event: KeyboardShortcutEvent & { isComposing?: boolean; keyCode?: number }): boolean {
  return !!event.isComposing || event.keyCode === 229 || event.key === "Process";
}

/**
 * Whether one keydown is `combo` on `platform`: the one matching rule for every shortcut the registry dispatches.
 *
 * - `mod` is ⌘ on mac and Ctrl elsewhere, and the other one must be up, unless the combo has `ctrl` (⌃ on a Mac; Ctrl
 *   elsewhere, as `mod` is); ⌥ must match exactly.
 * - The typed character first (case-insensitive). A punctuation combo without ⇧ also takes the ⇧ that types it on
 *   this layout (German types `/` with ⇧7); a letter or named key takes ⇧ only when the combo has it.
 * - Then the physical key (`code`), only when the typed key isn't a Latin letter, digit or zoom key: ⌘K works on a
 *   Russian layout (л on KeyK), ⌥ on a Mac (⌥M types µ), and Dvorak's ⌘T never becomes ⌘K.
 */
export function matchCombo(event: KeyboardShortcutEvent, combo: ShortcutCombo, platform: KeyboardPlatform): boolean {
  const mac = platform === "mac";
  const wantMeta = mac && !!combo.mod;
  const wantCtrl = mac ? !!combo.ctrl : !!(combo.mod || combo.ctrl);
  if (!!event.metaKey !== wantMeta || !!event.ctrlKey !== wantCtrl || !!event.altKey !== !!combo.alt) return false;
  const shift = !!event.shiftKey;
  const typed = event.key.length === 1 && combo.key.length === 1
    ? event.key.toLowerCase() === combo.key.toLowerCase()
    : event.key === combo.key;
  if (typed) {
    const punctuation = combo.key.length === 1 && !LATIN_ALNUM.test(combo.key);
    return shift === !!combo.shift || (punctuation && !combo.shift);
  }
  if (!isComboCode(event.code, combo) || shift !== !!combo.shift) return false;
  return !NEVER_BY_PLACE.test(event.key) && event.key !== "?";
}

/**
 * `combo` with ⌘ or Ctrl as `mod` on any platform: the few handlers that took either before the registry (the
 * composer's ⌘⇧Enter, a preview's ⌘W, the drafts' ⌘Z) keep doing so while the person hasn't changed their keys.
 */
export function matchComboEitherMod(event: KeyboardShortcutEvent, combo: ShortcutCombo): boolean {
  return matchCombo(event, combo, "mac") || matchCombo(event, combo, "other");
}

/**
 * `combo` by its physical key only (`code`, US-QWERTY placement): ⇧. is the same key whether a layout types `>` or
 * `:` with it, and a key that types `.` elsewhere isn't it. The assistant otter's shortcut matched this way before
 * the registry (#proj-assistant:#21).
 */
export function matchComboPhysical(event: KeyboardShortcutEvent, combo: ShortcutCombo, platform: KeyboardPlatform): boolean {
  const mac = platform === "mac";
  const wantMeta = mac && !!combo.mod;
  const wantCtrl = mac ? !!combo.ctrl : !!(combo.mod || combo.ctrl);
  if (!!event.metaKey !== wantMeta || !!event.ctrlKey !== wantCtrl || !!event.altKey !== !!combo.alt) return false;
  return !!event.shiftKey === !!combo.shift && isComboCode(event.code, combo);
}

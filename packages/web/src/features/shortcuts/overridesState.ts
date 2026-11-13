// The shortcuts a person changed (#proj-frontend:#37), as the dispatcher and every hint read them: the account's
// `shortcutOverrides` (shared shortcutOverrides.ts; PATCH /auth/me), only the commands they changed, written with
// `mod`. The assistant otter's own stored shortcut (`assistantOtterShortcut`, set in Settings before the panel
// existed) still counts as its change until the person changes it in the panel: then the panel's map has it, and the
// old field is cleared in the same request (saveShortcutOverrides.ts).
//
// shortcutAccountBridge.ts publishes each account authStore holds here (publishShortcutUser), so this module imports
// no store and the registry's pure parts stay importable without one.

import { useSyncExternalStore } from "react";
import { effectiveAssistantOtterShortcut, normalizeShortcutOverrides } from "@botiverse/raft-shared";
import type { AssistantOtterShortcut, StoredShortcutCombo, StoredShortcutOverrides } from "@botiverse/raft-shared";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";

export const OTTER_COMMAND_ID = "assistant-otter";

/** Command id → its shortcuts, for the commands the person changed; [] = left without a shortcut. */
export type ShortcutOverrides = Readonly<Record<string, readonly ShortcutCombo[]>>;

/** What of the account this reads. */
export interface ShortcutUser {
  shortcutOverrides?: StoredShortcutOverrides | null;
  assistantOtterShortcut?: string | null;
}

/** The key each otter shortcut `code` stands for (the codes assistantOtterShortcut.ts allows). */
const OTTER_PUNCTUATION_KEYS: Readonly<Record<string, string>> = {
  Period: ".", Comma: ",", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
};

/** An otter shortcut (a physical key's code with Mod, Alt, Shift) as a combo; null where its code isn't a key we can name. */
export function assistantOtterCombo(shortcut: AssistantOtterShortcut): ShortcutCombo | null {
  const { code, modifiers } = shortcut;
  const key = code.startsWith("Key") ? code.slice(3)
    : code.startsWith("Digit") ? code.slice(5)
      : OTTER_PUNCTUATION_KEYS[code];
  if (!key || key.length !== 1) return null;
  return { mod: modifiers.includes("Mod"), alt: modifiers.includes("Alt"), shift: modifiers.includes("Shift"), key };
}

export function comboOfStored(stored: StoredShortcutCombo): ShortcutCombo {
  const combo: ShortcutCombo = { key: stored.key };
  if (stored.mod) combo.mod = true;
  if (stored.ctrl) combo.ctrl = true;
  if (stored.alt) combo.alt = true;
  if (stored.shift) combo.shift = true;
  return combo;
}

const cache = new WeakMap<object, ShortcutOverrides>();
export const NO_SHORTCUT_OVERRIDES: ShortcutOverrides = Object.freeze({});

/** The person's changes on `user` (ids the app doesn't know are kept here and ignored where read). */
export function overridesOf(user: ShortcutUser | null | undefined): ShortcutOverrides {
  if (!user) return NO_SHORTCUT_OVERRIDES;
  const cached = cache.get(user);
  if (cached) return cached;
  const { shortcutOverrides, assistantOtterShortcut } = user;
  const result: Record<string, readonly ShortcutCombo[]> = {};
  // The otter's Settings-era choice, until the panel's map has the otter.
  if (assistantOtterShortcut != null) {
    const shortcut = effectiveAssistantOtterShortcut(assistantOtterShortcut);
    const combo = shortcut ? assistantOtterCombo(shortcut) : null;
    if (!shortcut) result[OTTER_COMMAND_ID] = [];
    else if (combo) result[OTTER_COMMAND_ID] = [combo];
  }
  for (const [id, combos] of Object.entries(normalizeShortcutOverrides(shortcutOverrides))) result[id] = combos.map(comboOfStored);
  const frozen = Object.freeze(result);
  cache.set(user, frozen);
  return frozen;
}

let current: ShortcutOverrides = NO_SHORTCUT_OVERRIDES;
const listeners = new Set<() => void>();

/** authStore calls this with each account it holds (null when signed out). */
export function publishShortcutUser(user: ShortcutUser | null | undefined): void {
  const next = overridesOf(user);
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The changes in effect now (outside React: the dispatcher, element handlers). */
export function currentShortcutOverrides(): ShortcutOverrides {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The changes in effect, for a component. */
export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribe, currentShortcutOverrides, currentShortcutOverrides);
}

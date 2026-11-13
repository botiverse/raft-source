/**
 * The keyboard shortcuts a person changed (#proj-frontend:#37), stored on their account
 * (`users.shortcut_overrides`), so the same keys work on every device. Only the commands they
 * changed are stored: a command left out keeps the app's default, so a later default reaches
 * everyone who never touched it. An empty list is a command they left without a shortcut.
 *
 * Keys are written with `mod`, which is ⌘ on Apple platforms and Ctrl elsewhere, so one stored
 * shortcut works on both. `ctrl` is the Control key on a Mac (⌃); elsewhere it is Ctrl, as `mod` is.
 * The command ids are the web app's (features/shortcuts/registry.ts); the server checks the shape
 * only, and the web drops ids it doesn't know.
 */

export interface StoredShortcutCombo {
  /** `KeyboardEvent.key` as the web app names it: "K", "/", "Enter", "ArrowUp", "F10". */
  key: string;
  mod?: true;
  ctrl?: true;
  alt?: true;
  shift?: true;
}

export type StoredShortcutOverrides = Record<string, StoredShortcutCombo[]>;

/** At most this many changed commands; the app has fewer than 40. */
export const SHORTCUT_OVERRIDES_MAX_COMMANDS = 64;
/** At most this many shortcuts for one command (a pair is two). */
export const SHORTCUT_OVERRIDES_MAX_COMBOS = 4;

const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FLAGS = ["mod", "ctrl", "alt", "shift"] as const;

function comboOf(raw: unknown): StoredShortcutCombo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { key } = record;
  // One character, or a named key ("ArrowUp", "F10"); never a control character.
  if (typeof key !== "string" || key.length === 0 || key.length > 24 || Array.from(key).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const combo: StoredShortcutCombo = { key };
  for (const flag of FLAGS) {
    const value = record[flag];
    if (value === true) combo[flag] = true;
    else if (value !== undefined && value !== false) return null;
  }
  for (const name of Object.keys(record)) if (name !== "key" && !(FLAGS as readonly string[]).includes(name)) return null;
  return combo;
}

/**
 * Parses a whole map, or null where any part of it isn't one: an unknown field, a bad command id,
 * a malformed shortcut, too many commands or shortcuts.
 */
function parseMap(raw: unknown): StoredShortcutOverrides | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > SHORTCUT_OVERRIDES_MAX_COMMANDS) return null;
  const map: StoredShortcutOverrides = {};
  for (const [id, combos] of entries) {
    if (!COMMAND_ID.test(id) || !Array.isArray(combos) || combos.length > SHORTCUT_OVERRIDES_MAX_COMBOS) return null;
    const parsed = combos.map(comboOf);
    if (parsed.some((combo) => combo === null)) return null;
    map[id] = parsed as StoredShortcutCombo[];
  }
  return map;
}

/** What the account stores, read: anything that isn't a valid map is no change at all ({}). */
export function normalizeShortcutOverrides(value: unknown): StoredShortcutOverrides {
  return parseMap(value) ?? {};
}

/**
 * PATCH /auth/me's `shortcutOverrides`: undefined = unchanged; null or {} = every shortcut back to
 * its default (stored as null); a valid map replaces the stored one whole. Anything else throws.
 */
export function parseShortcutOverridesPreference(raw: unknown): StoredShortcutOverrides | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const map = parseMap(raw);
  if (!map) throw new Error("shortcutOverrides must be an object of command ids to lists of shortcuts ({ key, mod?, ctrl?, alt?, shift? })");
  return Object.keys(map).length === 0 ? null : map;
}

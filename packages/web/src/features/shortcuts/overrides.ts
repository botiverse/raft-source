import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { defaultCombos, getShortcutCommand } from "./registry";
import type { ShortcutCommand } from "./registry";
import { currentShortcutOverrides } from "./overridesState";
import type { ShortcutOverrides } from "./overridesState";

export { currentShortcutOverrides, useShortcutOverrides, OTTER_COMMAND_ID } from "./overridesState";
export type { ShortcutOverrides } from "./overridesState";

/** The command's keys on `platform` with the person's change applied; [] where it has none. */
export function resolvedCombos(
  command: ShortcutCommand,
  platform: KeyboardPlatform,
  overrides: ShortcutOverrides = currentShortcutOverrides(),
): readonly ShortcutCombo[] {
  const defaults = defaultCombos(command, platform);
  // A command one platform hasn't (⌘↑ / ⌘↓ on a Mac only) stays off there, whatever was set on the other.
  if (defaults.length === 0) return defaults;
  if (command.rebindable && Object.hasOwn(overrides, command.id)) return overrides[command.id]!;
  return defaults;
}

export function isShortcutOverridden(id: string, overrides: ShortcutOverrides = currentShortcutOverrides()): boolean {
  return getShortcutCommand(id).rebindable && Object.hasOwn(overrides, id);
}

/** Two lists of shortcuts are the same keys in the same order. */
export function sameCombos(a: readonly ShortcutCombo[], b: readonly ShortcutCombo[]): boolean {
  const flat = (combo: ShortcutCombo) => `${combo.mod ? 1 : 0}${combo.ctrl ? 1 : 0}${combo.alt ? 1 : 0}${combo.shift ? 1 : 0}${combo.key.toLowerCase()}`;
  return a.length === b.length && a.every((combo, index) => flat(combo) === flat(b[index]!));
}

/**
 * The next map after setting each of `changes` (id → shortcuts, or null for its default). A change equal to the
 * command's default on `platform` is stored as no change, so a later default still reaches the person.
 */
export function nextOverrides(
  current: ShortcutOverrides,
  changes: Readonly<Record<string, readonly ShortcutCombo[] | null>>,
  platform: KeyboardPlatform,
): ShortcutOverrides {
  const next: Record<string, readonly ShortcutCombo[]> = { ...current };
  for (const [id, combos] of Object.entries(changes)) {
    if (combos === null || sameCombos(combos, defaultCombos(getShortcutCommand(id), platform))) delete next[id];
    else next[id] = combos;
  }
  return next;
}


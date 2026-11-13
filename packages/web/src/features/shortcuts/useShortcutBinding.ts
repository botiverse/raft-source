import { useMemo } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { KbdKeyName, KeyboardPlatform } from "@botiverse/raft-ui/wip";
import { formatShortcut, keyboardPlatform, shortcutKeyNames } from "../../utils/keyboardShortcuts";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { getShortcutCommand } from "./registry";
import { currentShortcutOverrides, resolvedCombos, useShortcutOverrides } from "./overrides";
import type { ShortcutOverrides } from "./overrides";

export interface ShortcutBinding {
  platform: KeyboardPlatform;
  /** The keys, alternatives in order; empty where the command has none on this platform. */
  combos: readonly ShortcutCombo[];
  /** KbdShortcut's `keys` for each alternative, with `platform` passed alongside. */
  keyNames: KbdKeyName[][];
  /** For `aria-keyshortcuts`: "Meta+/" on a Mac, "Control+/" elsewhere; alternatives space-separated. */
  ariaKeyShortcuts: string;
  /** A menu's shortcut string, the platform's way (⌘/, Ctrl+/): the first alternative. */
  menuText: string;
}

function ariaOf(combo: ShortcutCombo, platform: KeyboardPlatform): string {
  const parts: string[] = [];
  if (combo.mod) parts.push(platform === "mac" ? "Meta" : "Control");
  if (combo.ctrl && (platform === "mac" || !combo.mod)) parts.push("Control");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  // aria-keyshortcuts is a space-separated list joined by "+": the space bar and the plus key go by name.
  parts.push(combo.key === " " ? "Space" : combo.key === "+" ? "Plus" : combo.key);
  return parts.join("+");
}

/** `combos` for `aria-keyshortcuts` on `platform`: "Meta+/" on a Mac, "Control+/" elsewhere; alternatives space-separated. */
export function ariaKeyShortcuts(combos: readonly ShortcutCombo[], platform: KeyboardPlatform): string {
  return combos.map((combo) => ariaOf(combo, platform)).join(" ");
}

/**
 * Command `id`'s keys for display on `platform` (`navigator.platform` by default, as the matchers read it), with the
 * person's change applied. A command left without a shortcut has no keys: no hint, no `aria-keyshortcuts`.
 */
export function shortcutBinding(
  id: string,
  formatMessage?: IntlShape["formatMessage"],
  navigatorPlatform = typeof navigator === "undefined" ? "" : navigator.platform,
  overrides: ShortcutOverrides = currentShortcutOverrides(),
): ShortcutBinding {
  const platform = keyboardPlatform(navigatorPlatform);
  const command = getShortcutCommand(id);
  const combos = resolvedCombos(command, platform, overrides);
  return {
    platform,
    combos,
    keyNames: combos.map(shortcutKeyNames),
    ariaKeyShortcuts: ariaKeyShortcuts(combos, platform),
    menuText: combos[0] ? formatShortcut(combos[0], navigatorPlatform, formatMessage) : "",
  };
}

/**
 * The display binding of registry command `id`, for KbdShortcut, a menu's shortcut and `aria-keyshortcuts`, so
 * every hint shows the keys the dispatcher listens for, the person's change included.
 */
export function useShortcutBinding(id: string): ShortcutBinding {
  const { formatMessage } = useIntl();
  const overrides = useShortcutOverrides();
  return useMemo(() => shortcutBinding(id, formatMessage, undefined, overrides), [id, formatMessage, overrides]);
}

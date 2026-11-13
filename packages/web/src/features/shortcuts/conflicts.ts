import type { KeyboardPlatform } from "@botiverse/raft-ui/wip";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { SHORTCUT_COMMANDS, conflictKeysOf, defaultCombos, getShortcutCommand, scopesOverlap } from "./registry";
import type { ShortcutCommand } from "./registry";
import { reservedReason } from "./reserved";
import type { ReservedReason } from "./reserved";
import { isShortcutOverridden, resolvedCombos, sameCombos } from "./overrides";
import type { ShortcutOverrides } from "./overrides";

/**
 * Why a recorded shortcut can't be saved as it is, in the order the panel checks:
 * - `single`: no ⌘, ⌃ or ⌥ (a bare key, or ⇧ with a key, is typing; no single-key shortcuts in v1);
 * - `pairKey`: a pair (⌘↑ / ⌘↓) takes new modifiers with one of its own keys only;
 * - `reserved`: the browser or the OS keeps it, or it is a text field's editing key (refused, recording stays open);
 * - `desktop`: one of the desktop app's menu shortcuts (no Replace or Swap: those can't be changed yet);
 * - `locked`: a command that can't be changed has it, where both can be active (no Replace or Swap);
 * - `conflict`: other commands have it where they can be active with this one (`others`, every one of them):
 *   held for Replace (each of them is left without a shortcut), Swap or Cancel. Swap is offered only when exactly
 *   one command has the keys, neither is a pair, this one had keys to give, and those keys clash with nothing where
 *   that command works (a swap never makes a new, silent clash).
 */
export type BindingProblem =
  | { kind: "single" }
  | { kind: "pairKey"; keys: readonly string[] }
  | { kind: "reserved"; reason: ReservedReason; platform: KeyboardPlatform; combo: ShortcutCombo }
  | { kind: "desktop"; other: ShortcutCommand }
  | { kind: "locked"; other: ShortcutCommand }
  | { kind: "conflict"; others: readonly ShortcutCommand[]; canSwap: boolean };

const PLATFORMS: readonly KeyboardPlatform[] = ["mac", "other"];

/** The keys the command listens for on `platform`, as the conflict check compares them (registry conflictKeysOf). */
function keysOn(command: ShortcutCommand, platform: KeyboardPlatform, overrides: ShortcutOverrides): Set<string> {
  const combos = resolvedCombos(command, platform, overrides);
  const either = !!command.eitherMod && !isShortcutOverridden(command.id, overrides);
  return new Set(combos.flatMap((combo) => conflictKeysOf(combo, platform, either, !!command.desktopMenu)));
}

/** The keys a pair command has on this platform (↑ and ↓), from its defaults. */
export function pairKeys(command: ShortcutCommand, platform: KeyboardPlatform): string[] {
  return defaultCombos(command, platform).map((combo) => combo.key);
}

/**
 * What a recorded combo becomes for `command`: the combo itself, or for a pair its modifiers with each of the
 * pair's keys. Null when a pair's combo isn't on one of its keys.
 */
export function bindingFromRecorded(command: ShortcutCommand, combo: ShortcutCombo, platform: KeyboardPlatform): ShortcutCombo[] | null {
  if (!command.pair) return [combo];
  const keys = pairKeys(command, platform);
  if (!keys.some((key) => key.toLowerCase() === combo.key.toLowerCase())) return null;
  return keys.map((key) => ({ ...combo, key }));
}

/** No ⌘/Ctrl, ⌃ or ⌥: a bare key or ⇧ with a key, which a text field would type. */
export function isSingleKey(combo: ShortcutCombo): boolean {
  return !combo.mod && !combo.ctrl && !combo.alt;
}

/**
 * The first problem with giving `id` the recorded `combo` (null: it may have it), against every other command
 * with the person's changes applied, on both platforms (one stored map serves every device).
 */
export function checkRecordedBinding(
  id: string,
  combo: ShortcutCombo,
  overrides: ShortcutOverrides,
  platform: KeyboardPlatform,
): BindingProblem | null {
  const command = getShortcutCommand(id);
  if (isSingleKey(combo)) return { kind: "single" };
  const combos = bindingFromRecorded(command, combo, platform);
  if (!combos) return { kind: "pairKey", keys: pairKeys(command, platform) };
  for (const candidate of combos) {
    const reserved = reservedReason(candidate, platform);
    if (reserved) return { kind: "reserved", ...reserved, combo: candidate };
  }
  return findTaken(command, combos, overrides);
}

type Taken =
  | { kind: "desktop"; other: ShortcutCommand }
  | { kind: "locked"; other: ShortcutCommand }
  | { kind: "rebindable"; others: ShortcutCommand[] };

/** Every command that has one of `combos` where it can be active with `command`; a desktop menu's or a fixed one first. */
function commandsTaking(command: ShortcutCommand, combos: readonly ShortcutCombo[], overrides: ShortcutOverrides): Taken | null {
  const others: ShortcutCommand[] = [];
  for (const other of SHORTCUT_COMMANDS) {
    if (other.id === command.id) continue;
    const desktop = !!other.desktopMenu;
    // A desktop menu shortcut is the app's wherever focus is: it blocks every web command.
    if (!desktop && !scopesOverlap(command.scope, other.scope)) continue;
    const taken = PLATFORMS.some((platform) => {
      const theirs = keysOn(other, platform, overrides);
      return combos.some((combo) => conflictKeysOf(combo, platform, false, desktop).some((key) => theirs.has(key)));
    });
    if (!taken) continue;
    if (desktop) return { kind: "desktop", other };
    if (!other.rebindable) return { kind: "locked", other };
    others.push(other);
  }
  return others.length > 0 ? { kind: "rebindable", others } : null;
}

function findTaken(command: ShortcutCommand, combos: readonly ShortcutCombo[], overrides: ShortcutOverrides): BindingProblem | null {
  const taken = commandsTaking(command, combos, overrides);
  if (!taken) return null;
  if (taken.kind !== "rebindable") return taken;
  const [only, ...rest] = taken.others;
  return { kind: "conflict", others: taken.others, canSwap: rest.length === 0 && canSwapWith(command, combos, only!, overrides) };
}

/** Whether `other` can take `command`'s keys from before while `command` takes `combos`, with no clash anywhere. */
function canSwapWith(command: ShortcutCommand, combos: readonly ShortcutCombo[], other: ShortcutCommand, overrides: ShortcutOverrides): boolean {
  if (command.pair || other.pair) return false;
  const after: ShortcutOverrides = { ...overrides, [command.id]: combos, [other.id]: [] };
  return PLATFORMS.every((platform) => {
    const before = resolvedCombos(command, platform, overrides);
    if (before.length === 0) return false;
    return commandsTaking(other, before, after) === null;
  });
}

/**
 * The changes Replace or Swap makes: `id` takes `combos`; every command that had them is left without a shortcut
 * (Replace), or the one that had them takes `id`'s keys from before (Swap, offered only when that clashes nowhere).
 */
export function resolveConflict(
  id: string,
  combos: readonly ShortcutCombo[],
  otherIds: readonly string[],
  how: "replace" | "swap",
  overrides: ShortcutOverrides,
  platform: KeyboardPlatform,
): Record<string, readonly ShortcutCombo[]> {
  const before = resolvedCombos(getShortcutCommand(id), platform, overrides);
  const changes: Record<string, readonly ShortcutCombo[]> = { [id]: combos };
  for (const otherId of otherIds) changes[otherId] = how === "swap" ? before : [];
  return changes;
}

/** Whether `combos` are the command's keys already (recording them again changes nothing). */
export function isCurrentBinding(id: string, combos: readonly ShortcutCombo[], overrides: ShortcutOverrides, platform: KeyboardPlatform): boolean {
  return sameCombos(resolvedCombos(getShortcutCommand(id), platform, overrides), combos);
}

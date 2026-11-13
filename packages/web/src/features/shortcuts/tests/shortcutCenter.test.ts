import assert from "node:assert/strict";
import { matchCombo, matchComboEitherMod, matchComboPhysical } from "../match";
import { conflictKeysOf, findDefaultConflicts, getShortcutCommand, scopesOverlap } from "../registry";
import type { ShortcutCommand } from "../registry";
import { overridesOf, publishShortcutUser, currentShortcutOverrides } from "../overridesState";
import { nextOverrides, resolvedCombos } from "../overrides";
import { reservedReason } from "../reserved";
import { bindingFromRecorded, checkRecordedBinding, resolveConflict } from "../conflicts";
import { comboFromKeydown } from "../../keyboard-shortcuts/recordCombo";

// The shortcut center's pure parts (#proj-frontend:#37): the matcher's ⌃ and physical-key modes, the conflict check
// (layers, shifted punctuation, desktop menus), the person's overrides, reserved keys and the recorder's combo.

const J = { mod: true, key: "J" };

test("⌃ on a Mac is its own modifier; elsewhere a stored ⌃ is Ctrl, as mod is", () => {
  assert.equal(matchCombo({ key: "j", ctrlKey: true }, { ctrl: true, key: "J" }, "mac"), true);
  assert.equal(matchCombo({ key: "j", metaKey: true }, { ctrl: true, key: "J" }, "mac"), false);
  assert.equal(matchCombo({ key: "j", ctrlKey: true, metaKey: true }, { mod: true, ctrl: true, key: "J" }, "mac"), true);
  assert.equal(matchCombo({ key: "j", ctrlKey: true }, { ctrl: true, key: "J" }, "other"), true);
  assert.equal(matchCombo({ key: "j", ctrlKey: true }, J, "mac"), false, "unchanged: Ctrl isn't ⌘");
});

test("eitherMod takes ⌘ or Ctrl on any platform; physical matches the key's place only", () => {
  const z = { mod: true, key: "Z" };
  assert.equal(matchComboEitherMod({ key: "z", ctrlKey: true }, z), true);
  assert.equal(matchComboEitherMod({ key: "z", metaKey: true }, z), true);
  assert.equal(matchComboEitherMod({ key: "z", ctrlKey: true, shiftKey: true }, z), false);
  const period = { mod: true, shift: true, key: "." };
  assert.equal(matchComboPhysical({ key: ">", code: "Period", ctrlKey: true, shiftKey: true }, period, "other"), true, "US");
  assert.equal(matchComboPhysical({ key: ":", code: "Period", ctrlKey: true, shiftKey: true }, period, "other"), true, "German");
  assert.equal(matchComboPhysical({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true }, period, "other"), false);
  assert.equal(matchComboPhysical({ key: ">", code: "Period", metaKey: true, shiftKey: true }, period, "mac"), true);
});

test("conflicts: a layer overlaps every scope; ⌘/ and ⌘⇧/ are one key on the web, two in the desktop menus", () => {
  assert.equal(scopesOverlap("lightbox", "thread"), true);
  assert.equal(scopesOverlap("dialog", "settings"), true);
  assert.equal(scopesOverlap("conversation", "thread"), false, "siblings still don't");
  assert.deepEqual(conflictKeysOf({ mod: true, key: "/" }, "mac", false), conflictKeysOf({ mod: true, shift: true, key: "/" }, "mac", false));
  assert.notDeepEqual(conflictKeysOf({ mod: true, key: "[" }, "mac", false, true), conflictKeysOf({ mod: true, shift: true, key: "[" }, "mac", false, true));
  assert.notDeepEqual(conflictKeysOf({ mod: true, key: "K" }, "mac", false), conflictKeysOf({ mod: true, shift: true, key: "K" }, "mac", false), "a letter keeps ⇧");
  assert.deepEqual(conflictKeysOf({ mod: true, key: "Z" }, "mac", true), ["mac:mod+z", "mac:ctrl+z"], "eitherMod: ⌃Z too on a Mac");
  const command = (id: string, scope: ShortcutCommand["scope"], key: string): ShortcutCommand => ({
    id, scope, group: "other", defaults: { all: [{ mod: true, key }] }, label: "keyboardShortcuts.search", rebindable: true, handler: "x",
  });
  assert.equal(findDefaultConflicts([command("a", "global", "/"), command("b", "thread", "?")]).length, 0, "different keys");
  assert.ok(findDefaultConflicts([command("a", "lightbox", "J"), command("b", "conversation", "J")]).length > 0, "a layer's command collides with a focus scope's");
});

test("the person's changes: the map, the otter's Settings-era choice, and platform-only commands", () => {
  assert.deepEqual(overridesOf(null), {});
  const user = { shortcutOverrides: { search: [{ key: "J", mod: true as const }], nope: [] }, assistantOtterShortcut: "Mod+Alt+KeyO" };
  const overrides = overridesOf(user);
  assert.deepEqual(overrides.search, [{ key: "J", mod: true }]);
  assert.deepEqual(overrides["assistant-otter"], [{ mod: true, alt: true, shift: false, key: "O" }]);
  assert.equal(overridesOf(user), overrides, "memoized per account object");
  assert.deepEqual(overridesOf({ assistantOtterShortcut: "off" })["assistant-otter"], [], "turned off: no shortcut");
  assert.deepEqual(overridesOf({ shortcutOverrides: { "assistant-otter": [J] }, assistantOtterShortcut: "off" })["assistant-otter"], [J], "the panel's map wins");
  const search = getShortcutCommand("search");
  assert.deepEqual(resolvedCombos(search, "other", overrides), [{ key: "J", mod: true }]);
  assert.deepEqual(resolvedCombos(search, "other", {}), [{ mod: true, key: "K" }]);
  const jumpEnds = getShortcutCommand("jump-ends");
  const pair = { "jump-ends": [{ alt: true, key: "ArrowUp" }, { alt: true, key: "ArrowDown" }] };
  assert.deepEqual(resolvedCombos(jumpEnds, "mac", pair), pair["jump-ends"]);
  assert.deepEqual(resolvedCombos(jumpEnds, "other", pair), [], "a Mac-only command stays off elsewhere");
  assert.deepEqual(resolvedCombos(getShortcutCommand("new-line"), "other", { "new-line": [J] }), [{ shift: true, key: "Enter" }], "a fixed command ignores a stored change");
  publishShortcutUser(user);
  assert.equal(currentShortcutOverrides(), overrides);
  publishShortcutUser(null);
  assert.deepEqual(currentShortcutOverrides(), {});
});

test("nextOverrides: a change back to the default is stored as no change", () => {
  assert.deepEqual(nextOverrides({}, { search: [J] }, "other"), { search: [J] });
  assert.deepEqual(nextOverrides({ search: [J] }, { search: [{ mod: true, key: "K" }] }, "other"), {});
  assert.deepEqual(nextOverrides({ search: [J], sidebar: [] }, { search: null }, "other"), { sidebar: [] });
});

test("reserved keys: the browser's and the OS's, on either platform, since one stored map serves both", () => {
  assert.deepEqual(reservedReason({ mod: true, key: "T" }, "mac"), { reason: "browserOpenTab", platform: "mac" });
  assert.deepEqual(reservedReason({ mod: true, key: "Q" }, "other"), { reason: "macQuit", platform: "mac" }, "free on Windows, ⌘Q on a Mac");
  assert.deepEqual(reservedReason({ mod: true, alt: true, key: "Delete" }, "other"), { reason: "windowsSecurity", platform: "other" });
  assert.deepEqual(reservedReason({ mod: true, key: "C" }, "other"), { reason: "textEditing", platform: "other" });
  assert.equal(reservedReason({ mod: true, key: "J" }, "mac"), null);
  assert.deepEqual(reservedReason({ ctrl: true, key: " " }, "mac"), { reason: "macInputSource", platform: "mac" });
});

test("checkRecordedBinding: single key, pair key, reserved, desktop menu, fixed command, conflict, and duplicates in disjoint scopes", () => {
  assert.deepEqual(checkRecordedBinding("search", { key: "J" }, {}, "other"), { kind: "single" });
  assert.deepEqual(checkRecordedBinding("search", { shift: true, key: "J" }, {}, "other"), { kind: "single" }, "⇧ with a letter types it");
  assert.deepEqual(checkRecordedBinding("jump-ends", { alt: true, key: "J" }, {}, "mac"), { kind: "pairKey", keys: ["ArrowUp", "ArrowDown"] });
  assert.equal(checkRecordedBinding("jump-ends", { alt: true, key: "ArrowDown" }, {}, "mac"), null, "a pair takes either of its keys");
  assert.equal(checkRecordedBinding("search", { mod: true, key: "W" }, {}, "other")?.kind, "reserved");
  const desktop = checkRecordedBinding("search", { mod: true, key: "," }, {}, "mac");
  assert.equal(desktop?.kind, "desktop");
  assert.equal(desktop?.kind === "desktop" && desktop.other.id, "open-settings");
  const locked = checkRecordedBinding("search", { mod: true, key: "Enter" }, {}, "other");
  assert.equal(locked?.kind, "locked", "the composer's ⌘Enter (send) can't be changed");
  const taken = checkRecordedBinding("sidebar", { mod: true, key: "K" }, {}, "other");
  assert.deepEqual(taken?.kind === "conflict" && [taken.others.map((other) => other.id), taken.canSwap], [["search"], true]);
  assert.equal(checkRecordedBinding("sidebar", { mod: true, key: "K" }, { search: [J] }, "other"), null, "free once search moved");
  assert.equal(checkRecordedBinding("search-thread", { mod: true, key: "E" }, { "search-channel": [{ mod: true, key: "E" }] }, "other"), null, "a channel and a thread never overlap");
  const unbound = checkRecordedBinding("sidebar", { mod: true, key: "K" }, { sidebar: [] }, "other");
  assert.equal(unbound?.kind === "conflict" && unbound.canSwap, false, "no keys to give: no Swap");
});

test("Replace leaves the other command without keys; Swap gives it this one's old keys; a pair records its modifiers", () => {
  assert.deepEqual(resolveConflict("sidebar", [{ mod: true, key: "K" }], ["search"], "replace", {}, "other"), { sidebar: [{ mod: true, key: "K" }], search: [] });
  assert.deepEqual(resolveConflict("sidebar", [{ mod: true, key: "K" }], ["search"], "swap", {}, "other"), { sidebar: [{ mod: true, key: "K" }], search: [{ mod: true, key: "\\" }] });
  assert.deepEqual(resolveConflict("search", [{ mod: true, key: "F" }], ["search-channel", "search-thread"], "replace", {}, "other"), { search: [{ mod: true, key: "F" }], "search-channel": [], "search-thread": [] });
  assert.deepEqual(bindingFromRecorded(getShortcutCommand("jump-ends"), { alt: true, key: "ArrowUp" }, "mac"), [{ alt: true, key: "ArrowUp" }, { alt: true, key: "ArrowDown" }]);
});

test("the recorder's combo: letters by their place, punctuation as typed, nothing for a modifier alone", () => {
  assert.deepEqual(comboFromKeydown({ key: "л", code: "KeyK", ctrlKey: true }, "other"), { mod: true, key: "K" });
  assert.deepEqual(comboFromKeydown({ key: "µ", code: "KeyM", metaKey: true, altKey: true }, "mac"), { mod: true, alt: true, key: "M" });
  assert.deepEqual(comboFromKeydown({ key: "?", code: "Slash", metaKey: true, shiftKey: true }, "mac"), { mod: true, shift: true, key: "?" });
  assert.deepEqual(comboFromKeydown({ key: "÷", code: "Slash", metaKey: true, altKey: true }, "mac"), { mod: true, alt: true, key: "/" }, "⌥ changed the character");
  assert.deepEqual(comboFromKeydown({ key: "ArrowUp", code: "ArrowUp", altKey: true }, "mac"), { alt: true, key: "ArrowUp" });
  assert.deepEqual(comboFromKeydown({ key: "j", code: "KeyJ", ctrlKey: true, metaKey: true }, "mac"), { mod: true, ctrl: true, key: "J" });
  assert.equal(comboFromKeydown({ key: "Meta", code: "MetaLeft", metaKey: true }, "mac"), null);
  assert.equal(comboFromKeydown({ key: "j", code: "KeyJ", metaKey: true }, "other"), null, "the Windows key's combos are the OS's");
});

test("every clashing command is reported; Swap only for one command, and only where its new keys clash nowhere", () => {
  const all = checkRecordedBinding("search", { mod: true, key: "F" }, {}, "other");
  assert.deepEqual(all?.kind === "conflict" && [all.others.map((other) => other.id), all.canSwap], [["search-channel", "search-thread", "artifact-find", "search-settings"], false]);
  const unsafe = checkRecordedBinding("search-channel", { mod: true, key: "K" }, {}, "other");
  assert.deepEqual(unsafe?.kind === "conflict" && [unsafe.others.map((other) => other.id), unsafe.canSwap], [["search"], false], "Search taking ⌘F would clash with the thread's, an Artifact's and Settings' find");
  const safe = checkRecordedBinding("open-help", { mod: true, key: "K" }, {}, "other");
  assert.equal(safe?.kind === "conflict" && safe.canSwap, true, "Search can take ⌘/: nothing else has it");
});

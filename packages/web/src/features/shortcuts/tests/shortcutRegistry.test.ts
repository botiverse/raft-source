import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isImeComposing, matchCombo } from "../match";
import { SHORTCUT_COMMANDS, defaultCombos, findDefaultConflicts, getShortcutCommand, scopesOverlap } from "../registry";
import type { ShortcutCommand } from "../registry";
import { ariaKeyShortcuts, shortcutBinding } from "../useShortcutBinding";
import { en } from "../../../i18n/messages/en";

const K = { mod: true, key: "K" };
const SLASH = { mod: true, key: "/" };
const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");

test("mod is ⌘ on a Mac and Ctrl elsewhere, with the other one up", () => {
  assert.equal(matchCombo({ key: "k", metaKey: true }, K, "mac"), true);
  assert.equal(matchCombo({ key: "k", ctrlKey: true }, K, "mac"), false, "Ctrl+K on a Mac is not ⌘K");
  assert.equal(matchCombo({ key: "k", metaKey: true, ctrlKey: true }, K, "mac"), false);
  assert.equal(matchCombo({ key: "k", ctrlKey: true }, K, "other"), true);
  assert.equal(matchCombo({ key: "k", metaKey: true }, K, "other"), false, "the Windows key is not Ctrl");
  assert.equal(matchCombo({ key: "k" }, K, "other"), false, "a bare K is typing");
  assert.equal(matchCombo({ key: "K", ctrlKey: true, shiftKey: true }, K, "other"), false, "⇧ only where the combo has it");
  assert.equal(matchCombo({ key: "k", ctrlKey: true, altKey: true }, K, "other"), false);
  assert.equal(matchCombo({ key: "Enter", ctrlKey: true, shiftKey: true }, { mod: true, shift: true, key: "Enter" }, "other"), true);
  assert.equal(matchCombo({ key: "Enter", ctrlKey: true }, { mod: true, shift: true, key: "Enter" }, "other"), false);
});

test("a non-Latin layout matches a letter by its physical key; a Latin one never does", () => {
  assert.equal(matchCombo({ key: "л", code: "KeyK", ctrlKey: true }, K, "other"), true, "Russian");
  assert.equal(matchCombo({ key: "κ", code: "KeyK", metaKey: true }, K, "mac"), true, "Greek");
  assert.equal(matchCombo({ key: "ל", code: "KeyK", ctrlKey: true }, K, "other"), true, "Hebrew");
  assert.equal(matchCombo({ key: "t", code: "KeyK", ctrlKey: true }, K, "other"), false, "Dvorak's ⌘T on the K key stays ⌘T");
  assert.equal(matchCombo({ key: "µ", code: "KeyM", metaKey: true, altKey: true }, { mod: true, alt: true, key: "M" }, "mac"), true, "⌥M types µ on a Mac");
  assert.equal(matchCombo({ key: "л", code: "KeyK", ctrlKey: true, shiftKey: true }, K, "other"), false, "⇧ still has to match");
});

test("punctuation: the typed character with the ⇧ that types it, the physical key never for a zoom key or ?", () => {
  assert.equal(matchCombo({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }, SLASH, "other"), true, "German ⇧7");
  assert.equal(matchCombo({ key: "-", code: "Slash", ctrlKey: true }, SLASH, "other"), false, "German Ctrl+− stays zoom");
  assert.equal(matchCombo({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true }, SLASH, "other"), false, "US ⇧/ is ?");
  assert.equal(matchCombo({ key: ".", code: "Slash", ctrlKey: true }, SLASH, "other"), true, "Russian types . there");
  assert.equal(matchCombo({ key: "z", code: "Slash", metaKey: true }, SLASH, "mac"), false, "Dvorak ⌘Z stays undo");
});

test("the IME guard: isComposing, Safari's keyCode 229, and an IME's Process key", () => {
  assert.equal(isImeComposing({ key: "k", isComposing: true }), true);
  assert.equal(isImeComposing({ key: "Enter", keyCode: 229 }), true);
  assert.equal(isImeComposing({ key: "Process" }), true);
  assert.equal(isImeComposing({ key: "k", keyCode: 75 }), false);
});

test("scopes overlap when one sits inside the other; siblings don't", () => {
  assert.equal(scopesOverlap("global", "thread"), true);
  assert.equal(scopesOverlap("composer", "conversation"), true);
  assert.equal(scopesOverlap("composer", "global"), true, "through its parents");
  assert.equal(scopesOverlap("conversation", "thread"), false);
  assert.equal(scopesOverlap("artifact", "settings"), false);
});

test("CI: no two default bindings collide in scopes that can be active together, on either platform", () => {
  assert.deepEqual(findDefaultConflicts(), []);
});

test("the conflict check catches a collision, and lets a declared shadow or a sibling scope through", () => {
  const command = (id: string, scope: ShortcutCommand["scope"], extra: Partial<ShortcutCommand> = {}): ShortcutCommand => ({
    id, scope, group: "other", defaults: { all: [{ mod: true, key: "J" }] }, label: "keyboardShortcuts.search", rebindable: true, handler: "x", ...extra,
  });
  assert.deepEqual(findDefaultConflicts([command("a", "global"), command("b", "thread")]), [
    "mac:mod+j: a (global) and b (thread)",
    "other:mod+j: a (global) and b (thread)",
  ]);
  assert.deepEqual(findDefaultConflicts([command("a", "conversation"), command("b", "thread")]), [], "siblings");
  assert.deepEqual(findDefaultConflicts([command("a", "global", { shadows: ["b"] }), command("b", "thread")]), []);
  const macOnly = command("b", "thread", { defaults: { mac: [{ mod: true, key: "j" }] } });
  assert.deepEqual(findDefaultConflicts([command("a", "global"), macOnly]), ["mac:mod+j: a (global) and b (thread)"], "per platform, any case");
  // The real registry, with ⌘F moved to global, fails the CI check.
  const moved = SHORTCUT_COMMANDS.map((entry) => (entry.id === "search-channel" ? { ...entry, scope: "global" as const } : entry));
  assert.ok(findDefaultConflicts(moved).some((line) => line.includes("search-channel (global) and search-thread (thread)")));
});

test("every command has a unique id, a label and where in the catalog, a handler file, and keys on some platform", () => {
  const ids = SHORTCUT_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const command of SHORTCUT_COMMANDS) {
    assert.ok(Object.hasOwn(en, command.label), `${command.id}: ${command.label}`);
    if (command.where) assert.ok(Object.hasOwn(en, command.where), `${command.id}: ${command.where}`);
    assert.ok(existsSync(resolve(REPO_ROOT, command.handler)), `${command.id}: ${command.handler}`);
    assert.ok(defaultCombos(command, "mac").length + defaultCombos(command, "other").length > 0, command.id);
  }
  assert.throws(() => getShortcutCommand("nope"), /Unknown shortcut command "nope"/);
});

test("the display binding: KbdShortcut names, aria-keyshortcuts and the menu string, for the platform", () => {
  assert.deepEqual(shortcutBinding("open-help", undefined, "MacIntel"), {
    platform: "mac", combos: [SLASH], keyNames: [["mod", "/"]], ariaKeyShortcuts: "Meta+/", menuText: "⌘/",
  });
  const search = shortcutBinding("search", undefined, "Win32");
  assert.equal(search.menuText, "Ctrl+K");
  assert.equal(search.ariaKeyShortcuts, "Control+K");
  assert.equal(shortcutBinding("redo-draft", undefined, "Linux x86_64").ariaKeyShortcuts, "Control+Shift+Z Control+Y", "alternatives space-separated");
  assert.deepEqual(shortcutBinding("jump-ends", undefined, "Win32").combos, [], "a Mac-only command has no keys elsewhere");
});

test("aria-keyshortcuts names the space bar and the plus key, which would break its space- and plus-joined list", () => {
  const combo = { mod: true, ctrl: false, alt: false, shift: true };
  assert.equal(ariaKeyShortcuts([{ ...combo, key: " " }], "mac"), "Meta+Shift+Space");
  assert.equal(ariaKeyShortcuts([{ ...combo, key: "+" }], "other"), "Control+Shift+Plus");
});

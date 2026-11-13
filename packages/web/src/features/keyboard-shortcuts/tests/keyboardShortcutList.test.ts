import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHORTCUT_GROUPS, assistantOtterCombo, visibleShortcutGroups } from "../keyboardShortcutList";
import type { ShortcutKeys } from "../keyboardShortcutList";
import { formatShortcut, isCommentOtherActionShortcut, isDraftRedoShortcut, isDraftUndoShortcut, isShortcutHelpShortcut, keyboardPlatform, shortcutKeyNames } from "../../../utils/keyboardShortcuts";
import type { KeyboardShortcutEvent, ShortcutCombo } from "../../../utils/keyboardShortcuts";
import { ASSISTANT_OTTER_SHORTCUT_DEFAULT, matchesAssistantOtterShortcut, parseAssistantOtterShortcut } from "@botiverse/raft-shared";
import { matchComboPhysical } from "../../shortcuts/match";
import { getShortcutCommand } from "../../shortcuts/registry";

// The panel's list is the one place the app says which keys do what. These
// checks keep it honest against the code that handles the keys.

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");
const PLATFORMS = [
  { name: "macOS", platform: "MacIntel", mod: "metaKey" },
  { name: "Windows", platform: "Win32", mod: "ctrlKey" },
  { name: "Linux", platform: "Linux x86_64", mod: "ctrlKey" },
] as const;
const rows = SHORTCUT_GROUPS.flatMap((group) => group.rows);

function combosOf(keys: ShortcutKeys): ShortcutCombo[] {
  if ("from" in keys) return [keys.from, keys.to];
  if ("keys" in keys) return keys.keys.map((key) => ({ mod: keys.mod, alt: keys.alt, shift: keys.shift, key }));
  return [keys];
}

/** The keydown a person sends for `combo` on that platform. */
function pressOf(combo: ShortcutCombo, mod: "metaKey" | "ctrlKey"): KeyboardShortcutEvent {
  return {
    key: combo.key.length === 1 ? combo.key.toLowerCase() : combo.key,
    [mod]: !!combo.mod,
    altKey: !!combo.alt,
    shiftKey: !!combo.shift,
  };
}

test("each row's handler file still exists", () => {
  for (const row of rows) {
    assert.ok(existsSync(resolve(REPO_ROOT, row.handler)), `${row.id}: ${row.handler} is gone; update the row (or remove it)`);
  }
});

test("a row whose key goes through one of the app's matchers is matched by it, on every platform", () => {
  const checked = rows.filter((row) => row.matches);
  assert.deepEqual(checked.map((row) => row.id), ["open-help", "search", "sidebar", "search-channel", "search-thread", "comment-selection", "comment-other-action", "artifact-find", "undo-draft", "redo-draft", "search-settings"]);
  for (const row of checked) {
    for (const { name, platform, mod } of PLATFORMS) {
      for (const combo of row.keys.flatMap(combosOf)) {
        assert.equal(row.matches!(pressOf(combo, mod), platform), true, `${row.id} on ${name}: ${formatShortcut(combo, platform)}`);
      }
    }
  }
});

test("a row's matcher is the one its handler file calls, or the handler takes the row's command through the registry", () => {
  // The list's test presses keys through the matcher; this ties the matcher
  // to the code that acts on the key, so moving the handling elsewhere fails.
  // A handler on the registry's dispatcher (useShortcut) is matched by the
  // registry's own matcher, which the row's matcher wraps.
  for (const row of rows.filter((candidate) => candidate.matches)) {
    const source = readFileSync(resolve(REPO_ROOT, row.handler), "utf8");
    const name = row.matches!.name;
    const viaRegistry = new RegExp(`\\b(?:useShortcut|matchesShortcut)\\([^)]*"${row.id}"`).test(source);
    assert.ok(viaRegistry || new RegExp(`\\b${name}\\(`).test(source), `${row.id}: ${row.handler} no longer calls ${name} nor useShortcut("${row.id}")`);
  }
});

test("the otter row shows the account's default otter shortcut, and its handler matches it by the physical key", () => {
  // matchesAssistantOtterShortcut reads KeyboardEvent.code (Period), not the
  // character, so the row is checked against the shared default here.
  const row = rows.find((candidate) => candidate.id === "assistant-otter")!;
  assert.deepEqual(row.keys, [{ mod: true, shift: true, key: "." }]);
  const shortcut = parseAssistantOtterShortcut(ASSISTANT_OTTER_SHORTCUT_DEFAULT)!;
  assert.deepEqual(shortcut, { modifiers: ["Mod", "Shift"], code: "Period" });
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", metaKey: true, shiftKey: true }, shortcut, true), true, "⌘⇧. on a Mac");
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", ctrlKey: true, shiftKey: true }, shortcut, false), true, "Ctrl+Shift+. elsewhere");
  // Through the registry since #proj-frontend:#37: its command matches by the physical key (matchComboPhysical).
  const source = readFileSync(resolve(REPO_ROOT, row.handler), "utf8");
  assert.match(source, /\buseShortcut\(\s*"assistant-otter"/, `${row.handler} no longer takes useShortcut("assistant-otter")`);
  assert.equal(getShortcutCommand("assistant-otter").physical, true);
  assert.equal(matchComboPhysical({ key: ":", code: "Period", ctrlKey: true, shiftKey: true }, row.keys[0] as ShortcutCombo, "other"), true, "German ⇧. types :");
  assert.equal(matchComboPhysical({ key: ".", code: "Comma", ctrlKey: true, shiftKey: true }, row.keys[0] as ShortcutCombo, "other"), false, "a key typing . elsewhere isn't it");
});

test("an Artifact's draft undo and redo, and a comment box's other action, keep apart from their neighbours", () => {
  // ArtifactReviewParts: either modifier on every platform (its handler never read the platform).
  for (const mod of ["metaKey", "ctrlKey"] as const) {
    assert.equal(isDraftUndoShortcut({ key: "z", [mod]: true }), true);
    assert.equal(isDraftUndoShortcut({ key: "Z", [mod]: true, shiftKey: true }), false, "⇧ makes it redo");
    assert.equal(isDraftRedoShortcut({ key: "Z", [mod]: true, shiftKey: true }), true);
    assert.equal(isDraftRedoShortcut({ key: "y", [mod]: true }), true);
    assert.equal(isDraftRedoShortcut({ key: "Y", [mod]: true, shiftKey: true }), false);
    assert.equal(isDraftUndoShortcut({ key: "z", [mod]: true, altKey: true }), false, "not with ⌥");
    assert.equal(isDraftRedoShortcut({ key: "y", [mod]: true, altKey: true }), false);
    assert.equal(isCommentOtherActionShortcut({ key: "Enter", [mod]: true }), true);
    assert.equal(isCommentOtherActionShortcut({ key: "Enter", [mod]: true, shiftKey: true }), false, "⇧Enter is a new line");
  }
  assert.equal(isDraftUndoShortcut({ key: "z" }), false);
  assert.equal(isCommentOtherActionShortcut({ key: "Enter" }), false, "Enter alone does the box's Enter action");
});

test("the otter row draws the person's own shortcut: a letter, a digit or punctuation, with its modifiers", () => {
  assert.deepEqual(assistantOtterCombo({ modifiers: ["Mod", "Shift"], code: "Period" }), { mod: true, alt: false, shift: true, key: "." });
  assert.deepEqual(assistantOtterCombo({ modifiers: ["Mod", "Alt"], code: "KeyO" }), { mod: true, alt: true, shift: false, key: "O" });
  assert.deepEqual(assistantOtterCombo({ modifiers: ["Mod", "Shift"], code: "Digit8" }), { mod: true, alt: false, shift: true, key: "8" });
  assert.deepEqual(assistantOtterCombo({ modifiers: ["Mod", "Shift"], code: "Backslash" }), { mod: true, alt: false, shift: true, key: "\\" });
  assert.equal(assistantOtterCombo({ modifiers: ["Mod"], code: "F13" }), null);
  const otterRow = (assistantOtter: Parameters<typeof visibleShortcutGroups>[0]["assistantOtter"]) => visibleShortcutGroups({ apple: true, desktopApp: false, assistantOtter })
    .flatMap((group) => group.rows).find((row) => row.id === "assistant-otter");
  assert.equal(otterRow(null), undefined, "no row without an assistant, with its switch off or the shortcut off");
  assert.deepEqual(otterRow({ mod: true, alt: true, key: "O" })?.keys, [{ mod: true, alt: true, key: "O" }], "the person's binding, not the default");
});

test("the desktop app's rows are the accelerators its menus set", () => {
  const source = (id: string) => readFileSync(resolve(REPO_ROOT, rows.find((row) => row.id === id)!.handler), "utf8");
  assert.match(source("open-settings"), /accelerator: "CmdOrCtrl\+,"/, "Settings… is ⌘, / Ctrl+,");
  assert.match(source("history"), /back: "CmdOrCtrl\+\[", forward: "CmdOrCtrl\+\]"/, "History on a Mac: ⌘[ / ⌘]");
  assert.match(source("history-other"), /back: "Alt\+Left", forward: "Alt\+Right"/, "elsewhere: Alt+← / Alt+→");
  const ids = (apple: boolean) => visibleShortcutGroups({ apple, desktopApp: true, assistantOtter: null }).flatMap((group) => group.rows.map((row) => row.id));
  assert.equal(ids(true).includes("history") && !ids(true).includes("history-other"), true);
  assert.equal(ids(false).includes("history-other") && !ids(false).includes("history"), true);
});

test("⌘/ is the character, not the key's place: European layouts keep ⌘− for zoom, and type / with Shift", () => {
  // German, Spanish, Italian, Portuguese, Nordic: the US `/` key types `-`; `/` is Shift+7.
  assert.equal(isShortcutHelpShortcut({ key: "-", code: "Slash", ctrlKey: true }, "Win32"), false, "Ctrl+− stays the browser's zoom out");
  assert.equal(isShortcutHelpShortcut({ key: "-", code: "Slash", metaKey: true }, "MacIntel"), false, "⌘− too");
  assert.equal(isShortcutHelpShortcut({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }, "Win32"), true, "German Ctrl+Shift+7 types /");
  assert.equal(isShortcutHelpShortcut({ key: "/", code: "Digit7", metaKey: true, shiftKey: true }, "MacIntel"), true, "German ⌘⇧7 types /");
  // US: Shift+/ is ?, not this shortcut.
  assert.equal(isShortcutHelpShortcut({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true }, "Win32"), false);
  assert.equal(isShortcutHelpShortcut({ key: "/", code: "Slash", ctrlKey: true }, "Win32"), true);
  // A layout that types neither / nor a zoom key there (Russian `.`): the physical key.
  assert.equal(isShortcutHelpShortcut({ key: ".", code: "Slash", ctrlKey: true }, "Win32"), true);
  // A Latin letter or digit there is its own shortcut: Dvorak's `z` (undo), a BÉPO / Turkish F style letter, a digit.
  assert.equal(isShortcutHelpShortcut({ key: "z", code: "Slash", ctrlKey: true }, "Win32"), false, "Dvorak Ctrl+Z stays undo");
  assert.equal(isShortcutHelpShortcut({ key: "z", code: "Slash", metaKey: true }, "MacIntel"), false, "Dvorak ⌘Z stays undo");
  assert.equal(isShortcutHelpShortcut({ key: "X", code: "Slash", ctrlKey: true }, "Linux x86_64"), false);
  assert.equal(isShortcutHelpShortcut({ key: "0", code: "Slash", ctrlKey: true }, "Win32"), false);
  for (const key of ["+", "="]) {
    assert.equal(isShortcutHelpShortcut({ key, code: "Slash", ctrlKey: true }, "Linux x86_64"), false, `Ctrl+${key} stays zoom`);
  }
  assert.equal(isShortcutHelpShortcut({ key: "/", code: "Slash", ctrlKey: true, altKey: true }, "Win32"), false);
});

test("a row's keys are KbdShortcut key names, a cap each; the keys are KeyboardEvent.key values", () => {
  const keysOf = (id: string) => rows.find((row) => row.id === id)!.keys.map((keys) => combosOf(keys).map(shortcutKeyNames));
  assert.deepEqual(keysOf("send-as-task"), [[["mod", "shift", "Enter"]]]);
  assert.deepEqual(keysOf("comment-selection"), [[["mod", "alt", "M"]]]);
  assert.deepEqual(keysOf("jump-ends"), [[["mod", "ArrowUp"]], [["mod", "ArrowDown"]]]);
  assert.deepEqual(keysOf("resize-big-steps"), [[["shift", "ArrowLeft"], ["shift", "ArrowRight"]], [["shift", "ArrowUp"], ["shift", "ArrowDown"]]]);
  for (const row of rows) {
    for (const combo of row.keys.flatMap(combosOf)) {
      assert.ok(combo.key.length === 1 || /^(Enter|Arrow(Up|Down|Left|Right)|F\d{1,2})$/.test(combo.key), `${row.id}: ${combo.key} is not a key name KbdShortcut and the browser share`);
    }
  }
});

test("the platform the caps are drawn for is the one the matchers read: Apple platforms are mac, the rest other", () => {
  for (const platform of ["MacIntel", "iPhone", "iPad"]) assert.equal(keyboardPlatform(platform), "mac", platform);
  for (const platform of ["Win32", "Linux x86_64", ""]) assert.equal(keyboardPlatform(platform), "other", platform);
});

test("a menu's shortcut is one string the platform's way: symbols on Apple platforms, Ctrl/Alt/Shift words elsewhere", () => {
  const openHelp = rows.find((row) => row.id === "open-help")!.keys[0] as ShortcutCombo;
  const comment = rows.find((row) => row.id === "comment-selection")!.keys[0] as ShortcutCombo;
  assert.equal(formatShortcut(openHelp, "MacIntel"), "⌘/");
  assert.equal(formatShortcut(openHelp, "Win32"), "Ctrl+/");
  assert.equal(formatShortcut(comment, "MacIntel"), "⌘⌥M");
  assert.equal(formatShortcut(comment, "Linux x86_64"), "Ctrl+Alt+M");
});

test("the web hides the desktop app's rows (workspaces, ⌘W); ⌘↑ / ⌘↓ is on Apple platforms only", () => {
  const ids = (groups: ReturnType<typeof visibleShortcutGroups>) => groups.flatMap((group) => group.rows.map((row) => row.id));
  const webMac = visibleShortcutGroups({ apple: true, desktopApp: false, assistantOtter: null });
  const webWindows = visibleShortcutGroups({ apple: false, desktopApp: false, assistantOtter: null });
  const desktopWindows = visibleShortcutGroups({ apple: false, desktopApp: true, assistantOtter: null });

  assert.equal(webMac.some((group) => group.id === "workspaces"), false, "an empty group is dropped, its title too");
  assert.equal(ids(webMac).includes("switch-workspace"), false);
  assert.equal(ids(webMac).includes("jump-ends"), true);
  assert.equal(ids(webWindows).includes("jump-ends"), false);
  assert.equal(ids(webMac).includes("close-preview"), false, "⌘W closes the browser tab on the web (Artea: desktop app only)");
  assert.equal(ids(desktopWindows).includes("close-preview"), true);
  assert.equal(ids(webMac).length, 21, "21 rows on the web on a Mac, without an assistant");
  assert.equal(ids(webWindows).length, 20, "and 20 on Windows / Linux");
  assert.equal(ids(visibleShortcutGroups({ apple: true, desktopApp: false, assistantOtter: { mod: true, shift: true, key: "." } })).length, 22, "22 with the otter's row");
  assert.deepEqual(desktopWindows.at(-1)?.rows.map((row) => row.id), ["switch-workspace", "step-workspace"]);
});

test("the message box's rows follow the account's send key (#triage:#210)", () => {
  const messageBox = (composerSendKey?: "enter" | "mod_enter") => visibleShortcutGroups({ apple: true, desktopApp: false, assistantOtter: null, composerSendKey })
    .find((group) => group.id === "message-box")!.rows;
  const row = (rowsOf: ReturnType<typeof messageBox>, id: string) => rowsOf.find((candidate) => candidate.id === id)!;
  for (const mode of [undefined, "enter"] as const) {
    assert.deepEqual(row(messageBox(mode), "new-line").keys, [{ shift: true, key: "Enter" }]);
    assert.equal(row(messageBox(mode), "send").where, "keyboardShortcuts.send.where", "Same as Enter");
  }
  const modEnter = messageBox("mod_enter");
  assert.deepEqual(row(modEnter, "new-line").keys, [{ key: "Enter" }, { shift: true, key: "Enter" }], "Enter alone is a new line too");
  assert.equal(row(modEnter, "new-line").where, "keyboardShortcuts.newLine.whereModEnter");
  assert.deepEqual(row(modEnter, "send").keys, [{ mod: true, key: "Enter" }]);
  assert.equal(row(modEnter, "send").where, "keyboardShortcuts.send.whereModEnter");
  assert.deepEqual(row(modEnter, "send-as-task").keys, row(messageBox(), "send-as-task").keys, "send as task is the same in both");
});

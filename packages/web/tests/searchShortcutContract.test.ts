import test from "node:test";
import assert from "node:assert/strict";

import { getGlobalSearchShortcutLabel, isGlobalSearchShortcut } from "../src/utils/keyboardShortcuts";

test("global search shortcut uses Command+K on Apple platforms", () => {
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: false }, "MacIntel"), true);
  assert.equal(isGlobalSearchShortcut({ key: "K", metaKey: true, ctrlKey: false }, "MacIntel"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: true }, "MacIntel"), false);
});

test("global search shortcut uses Ctrl+K on non-Apple platforms", () => {
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "Win32"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: false, ctrlKey: true }, "Linux x86_64"), true);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: false }, "Win32"), false);
  assert.equal(isGlobalSearchShortcut({ key: "k", metaKey: true, ctrlKey: true }, "Win32"), false);
});

test("global search shortcut ignores other keys", () => {
  assert.equal(isGlobalSearchShortcut({ key: "j", metaKey: true, ctrlKey: false }, "MacIntel"), false);
  assert.equal(isGlobalSearchShortcut({ key: "j", metaKey: false, ctrlKey: true }, "Win32"), false);
});

test("global search shortcut label matches the active platform shortcut", () => {
  assert.equal(getGlobalSearchShortcutLabel("MacIntel"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("iPhone"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("Win32"), "Ctrl+K");
  assert.equal(getGlobalSearchShortcutLabel("Linux x86_64"), "Ctrl+K");
});

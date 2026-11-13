import assert from "node:assert/strict";
import "./helpers/domSetup";

import {
  blurFocusedControlForScreenshotShortcut,
  COMMENT_SHORTCUT,
  getCommentShortcutKeys,
  getGlobalSearchShortcutLabel,
  isCommentShortcut,
  isGlobalSearchShortcut,
  isSystemScreenshotShortcut,
  shortcutKeyNames,
} from "../src/utils/keyboardShortcuts";

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

test("the comment shortcut is ⌘⌥M on Apple platforms and Ctrl+Alt+M elsewhere", () => {
  // ⌥M types "µ" on a Mac: the physical key decides.
  assert.equal(isCommentShortcut({ key: "µ", code: "KeyM", metaKey: true, altKey: true }, "MacIntel"), true);
  assert.equal(isCommentShortcut({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }, "MacIntel"), false);
  assert.equal(isCommentShortcut({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }, "Win32"), true);
  assert.equal(isCommentShortcut({ key: "M", ctrlKey: true, altKey: true }, "Linux x86_64"), true);
  assert.equal(isCommentShortcut({ key: "m", code: "KeyM", ctrlKey: true }, "Win32"), false, "Alt is required");
  assert.equal(isCommentShortcut({ key: "M", code: "KeyM", ctrlKey: true, altKey: true, shiftKey: true }, "Win32"), false);
  assert.equal(isCommentShortcut({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }, "Win32"), false);
  // The tooltips draw it from the combo (KbdShortcut): ⌥⌘M on a Mac, Ctrl Alt M elsewhere.
  assert.deepEqual(shortcutKeyNames(COMMENT_SHORTCUT), ["mod", "alt", "M"]);
  assert.equal(getCommentShortcutKeys("MacIntel"), "Meta+Alt+M");
  assert.equal(getCommentShortcutKeys("Win32"), "Control+Alt+M");
});

test("global search shortcut label matches the active platform shortcut", () => {
  assert.equal(getGlobalSearchShortcutLabel("MacIntel"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("iPhone"), "⌘K");
  assert.equal(getGlobalSearchShortcutLabel("Win32"), "Ctrl+K");
  assert.equal(getGlobalSearchShortcutLabel("Linux x86_64"), "Ctrl+K");
});

test("system screenshot shortcut recognizes OS capture chords without hijacking search", () => {
  assert.equal(isSystemScreenshotShortcut({ key: "3", metaKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, ctrlKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "5", metaKey: true, shiftKey: true }, "MacIntel"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: false }, "MacIntel"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true, altKey: true }, "MacIntel"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "PrintScreen" }, "Win32"), true);
  assert.equal(isSystemScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, "Win32"), false);
  assert.equal(isSystemScreenshotShortcut({ key: "k", metaKey: true }, "MacIntel"), false);
});

test("system screenshot shortcut clears focused button chrome but leaves typing focus alone", () => {
  const button = document.createElement("button");
  const input = document.createElement("input");
  input.type = "text";
  document.body.append(button, input);

  try {
    button.focus();
    assert.ok(document.activeElement === button);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, document, "MacIntel"),
      true,
    );
    assert.ok(document.activeElement !== button);

    input.focus();
    assert.ok(document.activeElement === input);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "4", metaKey: true, shiftKey: true }, document, "MacIntel"),
      false,
    );
    assert.ok(document.activeElement === input);
  } finally {
    button.remove();
    input.remove();
  }
});

test("macOS screenshot modifier prelude clears button chrome before the final capture key", () => {
  const button = document.createElement("button");
  const input = document.createElement("input");
  input.type = "search";
  document.body.append(button, input);

  try {
    button.focus();
    assert.ok(document.activeElement === button);
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "MacIntel"),
      true,
    );
    assert.ok(document.activeElement !== button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut(
        { key: "Control", metaKey: true, ctrlKey: true, shiftKey: true },
        document,
        "MacIntel",
      ),
      true,
    );
    assert.ok(document.activeElement !== button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut(
        { key: "Shift", metaKey: true, shiftKey: true, altKey: true },
        document,
        "MacIntel",
      ),
      false,
    );
    assert.ok(document.activeElement === button);

    button.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "Win32"),
      false,
    );
    assert.ok(document.activeElement === button);

    input.focus();
    assert.equal(
      blurFocusedControlForScreenshotShortcut({ key: "Shift", metaKey: true, shiftKey: true }, document, "MacIntel"),
      false,
    );
    assert.ok(document.activeElement === input);
  } finally {
    button.remove();
    input.remove();
  }
});

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ASSISTANT_OTTER_SHORTCUT_DEFAULT,
  assistantOtterShortcutFromEvent,
  assistantOtterShortcutLabel,
  assistantOtterShortcutProblem,
  effectiveAssistantOtterShortcut,
  matchesAssistantOtterShortcut,
  parseAssistantOtterShortcut,
  parseAssistantOtterShortcutPreference,
} from "./assistantOtterShortcut";

test("the default is ⌘⇧. / Ctrl+Shift+. and is allowed on every platform", () => {
  assert.equal(assistantOtterShortcutProblem(ASSISTANT_OTTER_SHORTCUT_DEFAULT, true), null);
  assert.equal(assistantOtterShortcutProblem(ASSISTANT_OTTER_SHORTCUT_DEFAULT, false), null);
  const shortcut = effectiveAssistantOtterShortcut(null)!;
  assert.equal(assistantOtterShortcutLabel(shortcut, true), "⌘⇧.");
  assert.equal(assistantOtterShortcutLabel(shortcut, false), "Ctrl+Shift+.");
});

test("a stored value: null is the default, off is none, anything else is itself", () => {
  assert.equal(effectiveAssistantOtterShortcut("off"), null);
  assert.deepEqual(effectiveAssistantOtterShortcut("Mod+Shift+Quote"), { modifiers: ["Mod", "Shift"], code: "Quote" });
  // A value an older or newer build can't read falls back to the default rather than nothing.
  assert.deepEqual(effectiveAssistantOtterShortcut("Hyper+KeyQ"), parseAssistantOtterShortcut(ASSISTANT_OTTER_SHORTCUT_DEFAULT));
});

test("matching: Mod is ⌘ on Apple platforms and Ctrl elsewhere, never both, and the extras must be exact", () => {
  const shortcut = effectiveAssistantOtterShortcut(null)!;
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", metaKey: true, shiftKey: true }, shortcut, true), true);
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", ctrlKey: true, shiftKey: true }, shortcut, true), false);
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", ctrlKey: true, shiftKey: true }, shortcut, false), true);
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", ctrlKey: true, metaKey: true, shiftKey: true }, shortcut, false), false);
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", metaKey: true }, shortcut, true), false);
  assert.equal(matchesAssistantOtterShortcut({ code: "Period", metaKey: true, shiftKey: true, altKey: true }, shortcut, true), false);
});

test("capture: modifiers only, or a key a shortcut can't use, is nothing yet", () => {
  assert.equal(assistantOtterShortcutFromEvent({ code: "ShiftLeft", shiftKey: true, metaKey: true }, true), null);
  assert.equal(assistantOtterShortcutFromEvent({ code: "Space", metaKey: true }, true), null);
  assert.equal(assistantOtterShortcutFromEvent({ code: "KeyO", metaKey: true, altKey: true }, true), "Mod+Alt+KeyO");
  assert.equal(assistantOtterShortcutFromEvent({ code: "KeyO", ctrlKey: true, shiftKey: true }, false), "Mod+Shift+KeyO");
});

test("refused: no Mod, Mod with a letter alone, AltGr off Apple platforms, and combos already taken", () => {
  assert.equal(assistantOtterShortcutProblem("Shift+KeyO", true), "needs_mod");
  assert.equal(assistantOtterShortcutProblem("Mod+KeyO", true), "reserved");
  assert.equal(assistantOtterShortcutProblem("Mod+Digit1", true), "reserved");
  assert.equal(assistantOtterShortcutProblem("Mod+Alt+KeyO", false), "alt_gr");
  assert.equal(assistantOtterShortcutProblem("Mod+Alt+KeyO", true), null);
  for (const taken of ["Mod+Shift+KeyT", "Mod+Shift+KeyP", "Mod+Shift+Digit4", "Mod+Backslash", "Mod+Slash", "Mod+Shift+BracketLeft", "Mod+Alt+KeyM"]) {
    assert.equal(assistantOtterShortcutProblem(taken, true), "reserved", taken);
  }
  assert.equal(assistantOtterShortcutProblem("Shift+Mod+Period", true), "invalid", "modifiers in the canonical order only");
  assert.equal(assistantOtterShortcutProblem("Mod+Shift+Space", true), "invalid");
});

test("the account accepts null, off, or a shortcut allowed everywhere; anything else is refused with the reason", () => {
  assert.equal(parseAssistantOtterShortcutPreference(undefined), undefined);
  assert.equal(parseAssistantOtterShortcutPreference(null), null);
  assert.equal(parseAssistantOtterShortcutPreference("off"), "off");
  assert.equal(parseAssistantOtterShortcutPreference("Mod+Shift+Quote"), "Mod+Shift+Quote");
  assert.throws(() => parseAssistantOtterShortcutPreference("Mod+Alt+KeyO"), /alt_gr/);
  assert.throws(() => parseAssistantOtterShortcutPreference("Mod+Shift+KeyT"), /reserved/);
  assert.throws(() => parseAssistantOtterShortcutPreference(42), /must be a shortcut/);
});

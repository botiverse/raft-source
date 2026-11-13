import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPOSER_SEND_KEY_DEFAULT, normalizeComposerSendKey, parseComposerSendKeyPreference } from "./composerSendKey";

test("the stored send key reads as the default unless it is mod_enter", () => {
  assert.equal(COMPOSER_SEND_KEY_DEFAULT, "enter");
  assert.equal(normalizeComposerSendKey(null), "enter");
  assert.equal(normalizeComposerSendKey(undefined), "enter");
  assert.equal(normalizeComposerSendKey("bogus"), "enter");
  assert.equal(normalizeComposerSendKey("mod_enter"), "mod_enter");
});

test("PATCH's composerSendKey: absent leaves it, enter or null is the default (null), mod_enter is kept, anything else is refused", () => {
  assert.equal(parseComposerSendKeyPreference(undefined), undefined);
  assert.equal(parseComposerSendKeyPreference(null), null);
  assert.equal(parseComposerSendKeyPreference("enter"), null);
  assert.equal(parseComposerSendKeyPreference("mod_enter"), "mod_enter");
  for (const bad of ["MOD_ENTER", "ctrl_enter", "", 1, true, {}]) {
    assert.throws(() => parseComposerSendKeyPreference(bad), /composerSendKey must be/);
  }
});

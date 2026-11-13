import assert from "node:assert/strict";

import {
  COMPUTER_RELEASE_NOTES_MAX_CHARS,
  normalizeComputerReleaseNotes,
  pickComputerReleaseNotesText,
} from "./computerReleaseNotes";

test("normalizeComputerReleaseNotes keeps only non-empty strings for known locales", () => {
  assert.deepEqual(
    normalizeComputerReleaseNotes("1.0.40", { en: " - fixed\n", "zh-CN": "- 修复", fr: "- corrigé" }),
    { version: "1.0.40", en: "- fixed", "zh-CN": "- 修复" },
  );
  assert.deepEqual(
    normalizeComputerReleaseNotes("1.0.40", { en: 42, "zh-CN": "- 修复" }),
    { version: "1.0.40", "zh-CN": "- 修复" },
  );
});

test("normalizeComputerReleaseNotes rejects malformed shapes", () => {
  assert.equal(normalizeComputerReleaseNotes("1.0.40", null), null);
  assert.equal(normalizeComputerReleaseNotes("1.0.40", ["- a"]), null);
  assert.equal(normalizeComputerReleaseNotes("1.0.40", "- a"), null);
  assert.equal(normalizeComputerReleaseNotes("1.0.40", { en: "", "zh-CN": "   " }), null);
  assert.equal(normalizeComputerReleaseNotes("1.0.40", { en: { text: "- a" } }), null);
  assert.equal(normalizeComputerReleaseNotes(140, { en: "- a" }), null);
  assert.equal(normalizeComputerReleaseNotes("", { en: "- a" }), null);
  assert.equal(
    normalizeComputerReleaseNotes("1.0.40", { en: "x".repeat(COMPUTER_RELEASE_NOTES_MAX_CHARS + 1) }),
    null,
  );
});

test("pickComputerReleaseNotesText prefers the UI language and falls back to the other", () => {
  const both = { version: "1.0.40", en: "- fixed", "zh-CN": "- 修复" };
  assert.equal(pickComputerReleaseNotesText(both, "en"), "- fixed");
  assert.equal(pickComputerReleaseNotesText(both, "zh-cn"), "- 修复");
  assert.equal(pickComputerReleaseNotesText(both, "zh-tw"), "- 修复", "Traditional Chinese reads the Chinese notes");
  assert.equal(pickComputerReleaseNotesText(both, "es"), "- fixed");
  assert.equal(pickComputerReleaseNotesText({ version: "1.0.40", en: "- fixed" }, "zh-cn"), "- fixed");
  assert.equal(pickComputerReleaseNotesText({ version: "1.0.40", "zh-CN": "- 修复" }, "en"), "- 修复");
  assert.equal(pickComputerReleaseNotesText(null, "en"), null);
});

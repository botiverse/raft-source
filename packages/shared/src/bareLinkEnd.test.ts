import assert from "node:assert/strict";
import { bareLinkBeforeFullWidthPunctuation, FULL_WIDTH_PUNCTUATION } from "./bareLinkEnd";

// A bare address ends before the full-width punctuation a CJK sentence puts
// straight after it (#proj-deploy:#17): the content Worker's Markdown and the
// server's contentLinks.ts cut it the same way.
const ARTIFACT = "https://app.raft.build/artifacts/H6XqAbcDEF123";

test("an address followed by a CJK aside ends before its opening parenthesis", () => {
  assert.equal(bareLinkBeforeFullWidthPunctuation(`${ARTIFACT}\uff08v10\uff0c\u7b2c`), ARTIFACT);
});

test("each kind of full-width punctuation ends the address", () => {
  const marks = [
    "\u3000", "\u3001", "\u3002", "\u300a", "\u300b", "\u300c", "\u300d", "\u300e", "\u3010", "\u3011", "\u3014", "\u301c", "\u303f",
    "\uff01", "\uff08", "\uff09", "\uff0c", "\uff0f", "\uff1a", "\uff1b", "\uff1f", "\uff20", "\uff3b", "\uff3d", "\uff40",
    "\uff5b", "\uff5d", "\uff5e", "\uff61", "\uff62", "\uff63", "\uff64", "\uff65",
  ];
  for (const mark of marks) {
    assert.equal(bareLinkBeforeFullWidthPunctuation(`${ARTIFACT}${mark}rest`), ARTIFACT, mark.codePointAt(0)!.toString(16));
  }
});

test("full-width letters and digits, other CJK text and ASCII punctuation are left in", () => {
  // Fullwidth digits (U+FF10-FF19), Latin letters (U+FF21-FF3A, U+FF41-FF5A), halfwidth katakana (U+FF66-) and fullwidth signs (U+FFE0-).
  for (const kept of ["\uff10", "\uff19", "\uff21", "\uff3a", "\uff41", "\uff5a", "\uff66", "\uffe0", "\u7b2c", "(", ")", ",", "."]) {
    const address = `${ARTIFACT}/a${kept}b`;
    assert.equal(bareLinkBeforeFullWidthPunctuation(address), address, kept.codePointAt(0)!.toString(16));
  }
});

test("an address with none is whole; the cut is at the first one", () => {
  assert.equal(bareLinkBeforeFullWidthPunctuation(ARTIFACT), ARTIFACT);
  assert.equal(bareLinkBeforeFullWidthPunctuation(""), "");
  assert.equal(bareLinkBeforeFullWidthPunctuation(`${ARTIFACT}/x\u3002y\uff0cz`), `${ARTIFACT}/x`);
});

test("the character class is the same set, written as escapes", () => {
  const set = new RegExp(`^[${FULL_WIDTH_PUNCTUATION}]$`);
  assert.ok(set.test("\u3000") && set.test("\u303f") && set.test("\uff01") && set.test("\uff65"));
  assert.ok(!set.test("\u2fff") && !set.test("\u3040") && !set.test("\uff00") && !set.test("\uff10") && !set.test("\uff66"));
  assert.match(FULL_WIDTH_PUNCTUATION, /^[\\u0-9a-f-]+$/, "escapes only, no raw characters");
});

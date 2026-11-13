import assert from "node:assert/strict";
import { jsonByteLength, shrinkTextToFit, truncateUtf8 } from "./payloadBudget";

test("truncateUtf8 cuts on a code point boundary and marks the cut", () => {
  assert.equal(truncateUtf8("hello", 5), "hello", "text within the budget is unchanged");
  assert.equal(truncateUtf8("hello world", 8), "hello…");
  // 3 bytes a character: 10 bytes leave room for two characters and the ellipsis.
  assert.equal(truncateUtf8("漢字漢字漢字", 10), "漢字…");
  // An emoji is a surrogate pair (4 bytes); it is never split.
  const cut = truncateUtf8("😀😀😀", 9);
  assert.equal(cut, "😀…");
  assert.ok(Buffer.byteLength(cut, "utf8") <= 9);
  assert.equal(truncateUtf8("abcdef", 2), "", "no room for anything but the ellipsis");
});

test("shrinkTextToFit brings the serialized size within the budget, escapes included", () => {
  const payload = { title: "t", body: `${'"'.repeat(500)}${"漢".repeat(500)}` };
  shrinkTextToFit(() => jsonByteLength(payload), 600, () => payload.body, (value) => { payload.body = value; });
  assert.ok(jsonByteLength(payload) <= 600, `${jsonByteLength(payload)} bytes`);
  assert.ok(payload.body.endsWith("…"));

  const small = { body: "short" };
  shrinkTextToFit(() => jsonByteLength(small), 600, () => small.body, (value) => { small.body = value; });
  assert.equal(small.body, "short");
});

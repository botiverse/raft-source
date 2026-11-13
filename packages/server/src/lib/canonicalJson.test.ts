import assert from "node:assert/strict";
import { test } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "./canonicalJson";

test("canonical JSON ignores key order and spacing, keeps every field (RFC 8785)", () => {
  const a = JSON.parse('{ "b": [1, 2.5, "x"], "a": { "z": null, "y": true } }');
  const b = JSON.parse('{"a":{"y":true,"z":null},"b":[1,2.5,"x"]}');
  assert.equal(canonicalJson(a), '{"a":{"y":true,"z":null},"b":[1,2.5,"x"]}');
  assert.equal(canonicalJsonSha256(a), canonicalJsonSha256(b));
  assert.notEqual(canonicalJsonSha256({ ...b, extra: 1 }), canonicalJsonSha256(b), "an extra field changes the digest");
  assert.notEqual(canonicalJsonSha256({ a: b.a }), canonicalJsonSha256(b), "a missing field changes the digest");
  // Keys sort by UTF-16 code units, as RFC 8785 §3.2.3 requires: U+1F600 (high
  // surrogate 0xD83D) sorts before U+FB33, the reverse of code-point order.
  assert.equal(canonicalJson({ "\ufb33": 1, "😀": 2, "€": 3, "\r": 4, "1": 5 }), '{"\\r":4,"1":5,"€":3,"😀":2,"\ufb33":1}');
  assert.equal(canonicalJson({ s: "line\nbreak \"q\"" }), '{"s":"line\\nbreak \\"q\\""}');
});

test("canonical JSON refuses values that have no single JSON form", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, new Date(0), () => 1, 1n]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
});

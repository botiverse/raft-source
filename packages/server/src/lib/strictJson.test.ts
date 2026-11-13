import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { hasControlCharacterKey, parseStrictJson, StrictJsonError } from "./strictJson";

// Protocol addendum 4 §4: an object key holding a C0 control character after
// unescaping makes the whole protocol document invalid, at any depth; values
// are unaffected. K1 (refused at prepare) belongs to C2b; K2-K6 are here, for
// the strict parser and for the raw-text check v1 preview answers get before
// JSON.parse. The shared vectors (linkCardDescription.test.ts) cover it too.
afterEach(() => { vi.restoreAllMocks(); });

const C0_KEYS = [
  '{"\\u0000":1}', '{"\\u001f":1}', '{"\\u001F":1}', '{"a\\nb":1}', '{"\\t":1}', '{"\\n":1}', '{"\\u000a":1}', '{"\\u001b":"x"}',
  '{"\\b":1}', '{"\\f":1}', '{"\\r":1}', '{"x\\u0001y":1}',
];
const NESTED_C0_KEYS = ['{"a":{"\\u001b":1}}', '{"a":[{"\\u0001":1}]}', '{"a":[{"b":{"\\t":"x"}}]}', '{"a":[[{"ok":1},{"\\r":2}]]}'];
const ALLOWED_KEYS = ['{"\\u007f":1}', '{"\\u2028":1}', '{"\\\\u001b":1}', '{"\\\\n":1}', '{" ":1}', '{"a b":1}', '{"\\u0020":1}', '{"\\/":1}'];
const C0_VALUES = ['{"a":"第一行\\n第二行"}', '{"a":"\\u001b[31m"}', '{"a":["\\t",{"b":"\\u0000"}]}', '{"\\\\u001b":"line1\\nline2\\u001b"}'];

test("K2: a key with a C0 control character is refused, short and \\u escapes alike", () => {
  for (const text of C0_KEYS) {
    assert.throws(() => parseStrictJson(text), (error: unknown) => error instanceof StrictJsonError && /control character in key/.test(error.message), text);
    assert.equal(hasControlCharacterKey(text), true, text);
  }
});

test("K3: nested keys are refused too, in objects and in objects inside arrays", () => {
  for (const text of NESTED_C0_KEYS) {
    assert.throws(() => parseStrictJson(text), /control character in key/, text);
    assert.equal(hasControlCharacterKey(text), true, text);
  }
});

test("K4: DEL, U+2028 and a literal backslash-u key are not C0 and pass", () => {
  for (const text of ALLOWED_KEYS) {
    assert.doesNotThrow(() => parseStrictJson(text), text);
    assert.equal(hasControlCharacterKey(text), false, text);
  }
  assert.deepEqual(Object.keys(parseStrictJson('{"\\\\u001b":1}')), ["\\u001b"], "a backslash and five characters");
});

test("K5: control characters in values pass", () => {
  for (const text of C0_VALUES) {
    assert.doesNotThrow(() => parseStrictJson(text), text);
    assert.equal(hasControlCharacterKey(text), false, text);
  }
  assert.equal(parseStrictJson(C0_VALUES[0]!).a, "第一行\n第二行");
  // A value string followed by ':' inside another string is still a value.
  assert.equal(hasControlCharacterKey('{"a":"\\n:","b":"x"}'), false);
  assert.equal(hasControlCharacterKey('{"a" : "x", "b\\t"  :  1}'), true, "whitespace before the colon");
});

test("K6: the checks read the raw text, so a native parser that corrupts the key changes nothing", () => {
  // Node 24's JSON.parse has been seen decoding the key "\u001b" as "\\".
  const corrupt = vi.spyOn(JSON, "parse").mockImplementation(() => ({ "\\": "x" }));
  const text = '{"\\u001b":"x"}';
  assert.deepEqual(JSON.parse(text), { "\\": "x" }, "the stub is in place");
  assert.throws(() => parseStrictJson(text), /control character in key/);
  assert.equal(hasControlCharacterKey(text), true);
  for (const nested of NESTED_C0_KEYS) assert.equal(hasControlCharacterKey(nested), true, nested);
  assert.ok(corrupt.mock.calls.length === 1, "neither check calls JSON.parse");
});

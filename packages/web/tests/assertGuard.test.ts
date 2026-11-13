// The node:assert guard the web Vitest config aliases in (tests/helpers/assertGuard.ts).
// Every import form below must resolve to the guard; every comparison must
// decide exactly as the real node:assert does; a failure must not read a
// getter or grow with the operand.
import assert from "node:assert/strict";
import legacyDefault from "node:assert";
import * as legacyNamespace from "node:assert";
import { strict as namedStrict, strictEqual as namedStrictEqual, AssertionError } from "node:assert";
import * as strictNamespace from "node:assert/strict";
import bareLegacy from "assert";
import bareStrictPath from "assert/strict";
// @ts-expect-error jsdom ships no types here; tests are not typechecked against it.
import { JSDOM } from "jsdom";
import {
  assertGuardLegacy,
  assertGuardStrict,
  realAssertForTest,
  setSummariserForTest,
  summarise,
} from "./helpers/assertGuard";

const real = realAssertForTest;
// The aliased imports are typed as @types/node; compare identities untyped.
const same = (a: unknown, b: unknown) => a === b;
const ns = (value: unknown) => value as Record<string, unknown>;

type Outcome = { threw: false } | { threw: true; name: string; code: unknown; operator: unknown };

function outcome(run: () => void): Outcome {
  try {
    run();
    return { threw: false };
  } catch (error) {
    const e = error as { name?: string; code?: unknown; operator?: unknown };
    return { threw: true, name: String(e.name), code: e.code, operator: e.operator };
  }
}

function caught(run: () => void): Error & Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("expected a throw");
}

// The guard throws natively shaped errors; real node:assert with an Error
// message would throw that Error instead, so compare against a real call given
// a string message (its operator / code / name are the native ones).
function nativeOutcome(run: (message: string) => void): Outcome {
  return outcome(() => run("m"));
}

describe("alias coverage", () => {
  test("every node:assert import form resolves to the guard", () => {
    assert.ok(same(legacyDefault, assertGuardLegacy), "import x from 'node:assert'");
    assert.ok(same(bareLegacy, assertGuardLegacy), "import x from 'assert'");
    assert.ok(same(assert, assertGuardStrict), "import x from 'node:assert/strict'");
    assert.ok(same(bareStrictPath, assertGuardStrict), "import x from 'assert/strict'");
    assert.ok(same(namedStrict, assertGuardStrict), "import { strict } from 'node:assert'");
    assert.ok(namedStrictEqual === assertGuardLegacy.strictEqual, "import { strictEqual } from 'node:assert'");
    assert.ok(same(ns(legacyNamespace).default, assertGuardLegacy), "import * as x from 'node:assert' (default)");
    assert.ok(same(ns(legacyNamespace).deepEqual, assertGuardLegacy.deepEqual), "import * as x from 'node:assert'");
    assert.ok(same(ns(strictNamespace).equal, assertGuardStrict.equal), "import * as x from 'node:assert/strict'");
    assert.ok(!same(ns(assertGuardLegacy).strictEqual, real.legacy.strictEqual), "the guard wraps the real function");
    assert.ok(AssertionError === real.legacy.AssertionError, "AssertionError is the real class");
  });
});

describe("comparison parity with the real node:assert", () => {
  const shared = { a: 1 };
  const pairs: Array<[string, unknown, unknown]> = [
    ["same reference", shared, shared],
    ["equal primitives", 1, 1],
    ["loose only", 1, "1"],
    ["NaN", Number.NaN, Number.NaN],
    ["-0 / 0", -0, 0],
    ["null / undefined", null, undefined],
    ["equal structures", { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
    ["different structures", { a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }],
    ["prototype differs", Object.create(null), {}],
    ["subset", { a: 1, b: 2 }, { a: 1 }],
    ["dates", new Date(0), new Date(0)],
    ["maps", new Map([[1, { x: 1 }]]), new Map([[1, { x: 1 }]])],
  ];
  const names = [
    "ok",
    "equal",
    "notEqual",
    "strictEqual",
    "notStrictEqual",
    "deepEqual",
    "notDeepEqual",
    "deepStrictEqual",
    "notDeepStrictEqual",
    "partialDeepStrictEqual",
  ] as const;

  for (const mode of ["legacy", "strict"] as const) {
    const guard = mode === "legacy" ? assertGuardLegacy : assertGuardStrict;
    const native = real[mode];
    for (const name of names) {
      test(`${mode}.${name}`, () => {
        for (const [label, a, b] of pairs) {
          const call = (target: typeof native, message?: string) =>
            name === "ok"
              ? (target.ok as (v: unknown, m?: string) => void)(a, message)
              : (target[name] as (x: unknown, y: unknown, m?: string) => void)(a, b, message);
          const expected = nativeOutcome((message) => call(native, message));
          assert.deepEqual(outcome(() => call(guard)), expected, `${label} (no message)`);
          assert.deepEqual(outcome(() => call(guard, "m")), expected, `${label} (caller message)`);
        }
      });
    }
  }

  test("two different elements with the same tag fail strictEqual, the same one passes", () => {
    const { window } = new JSDOM("<div id='a' class='x y'></div><div id='b'></div>");
    const [first, second] = window.document.querySelectorAll("div");
    assertGuardStrict.equal(first, first);
    const error = caught(() => assertGuardStrict.equal(first, second));
    assert.equal(error.operator, "strictEqual");
    assert.equal(error.code, "ERR_ASSERTION");
    assert.equal(error.generatedMessage, true);
    assert.ok(error instanceof real.legacy.AssertionError, "a real AssertionError");
    assert.ok(String(error.message).length < 1000, String(error.message).slice(0, 200));
  });

  test("DOM nodes are summarised as tag#id.class when Node is global", () => {
    const { window } = new JSDOM("<div id='a' class='x y'></div>");
    const previous = (globalThis as { Node?: unknown }).Node;
    (globalThis as { Node?: unknown }).Node = window.Node;
    try {
      const div = window.document.querySelector("div");
      const error = caught(() => assertGuardStrict.equal(div, null));
      assert.equal(error.message, "Expected values to be strictly equal:\nactual: <div#a.x.y> (DOM node)\nexpected: null");
      assert.equal(error.actual, "<div#a.x.y> (DOM node)");
      assert.equal(error.expected, "null");
    } finally {
      (globalThis as { Node?: unknown }).Node = previous;
    }
  });

  test("the entry modules export every real node:assert export by name", () => {
    assert.deepEqual(Object.keys(legacyNamespace).filter((key) => key !== "default").sort(), Object.keys(real.legacy).sort());
    assert.deepEqual(Object.keys(strictNamespace).filter((key) => key !== "default").sort(), Object.keys(real.strict).sort());
  });

  test("throws / rejects / match / fail / ifError are the real functions", () => {
    for (const name of ["throws", "rejects", "doesNotThrow", "doesNotReject", "match", "doesNotMatch", "fail", "ifError"] as const) {
      assert.ok(assertGuardLegacy[name] === real.legacy[name], name);
      assert.ok(assertGuardStrict[name] === real.strict[name], name);
    }
  });

  test("too few operands keep the native argument error", () => {
    const guardError = caught(() => (assertGuardStrict.strictEqual as (a: unknown) => void)(1));
    const nativeError = caught(() => (real.strict.strictEqual as (a: unknown) => void)(1));
    assert.equal(guardError.code, nativeError.code);
    assert.equal(guardError.code, "ERR_MISSING_ARGS");
  });
});

describe("nested differences", () => {
  test("the generated message points at the first nested difference", () => {
    const error = caught(() =>
      assertGuardStrict.deepEqual({ data: { items: [{ id: 1, name: "a" }] } }, { data: { items: [{ id: 2, name: "a" }] } }),
    );
    assert.match(String(error.message), /first difference at \.data\.items\[0\]\.id: 1 vs 2$/);
  });

  test("no hint where Object.is is not the rule, and cycles end", () => {
    const loose = String(caught(() => assertGuardLegacy.deepEqual({ a: 1, b: { c: 2 } }, { a: "1", b: { c: 3 } })).message);
    assert.ok(!loose.includes("first difference"), loose);
    const partial = String(caught(() => assertGuardStrict.partialDeepStrictEqual({ x: { extra: 1, a: 1 } }, { x: { a: 2 } })).message);
    assert.ok(!partial.includes("first difference"), partial);
    const left: Record<string, unknown> = { k: 1 };
    left.self = left;
    const right: Record<string, unknown> = { k: 1, self2: 1 };
    right.self = right;
    assert.match(String(caught(() => assertGuardStrict.deepEqual(left, right)).message), /first difference at \.self2: <missing> vs 1/);
  });

  test("missing keys, lengths and same-shape references are named", () => {
    assert.match(String(caught(() => assertGuardStrict.deepEqual({ a: { b: 1 } }, { a: {} })).message), /at \.a\.b: 1 vs <missing>/);
    assert.match(String(caught(() => assertGuardStrict.deepEqual({ list: [1] }, { list: [1, 2] })).message), /at \.list\.length: 1 vs 2/);
    assert.match(String(caught(() => assertGuardStrict.equal({ a: 1 }, { a: 1 })).message), /same own data, different references/);
  });
});

describe("caller messages", () => {
  test("a string message is the thrown message, not generated", () => {
    const error = caught(() => assertGuardStrict.deepEqual({ a: 1 }, { a: 2 }, "values differ"));
    assert.equal(error.message, "values differ");
    assert.equal(error.generatedMessage, false);
    assert.equal(error.operator, "deepStrictEqual");
    assert.equal(error.code, "ERR_ASSERTION");
  });

  test("an Error message is thrown as is, as natively", () => {
    const mine = new TypeError("mine");
    assert.ok(caught(() => assertGuardStrict.equal(1, 2, mine)) === mine, "strict.equal");
    assert.ok(caught(() => assertGuardLegacy.ok(0, mine)) === mine, "ok");
  });

  test("the stack starts at the caller", () => {
    const error = caught(function callerFrame() {
      assertGuardStrict.equal(1, 2);
    });
    const firstFrame = String(error.stack).split("\n").find((line) => line.trimStart().startsWith("at "));
    assert.match(String(firstFrame), /callerFrame/);
  });
});

describe("bounded, getter-free failure output", () => {
  function counted(): { value: Record<string, unknown>; reads: () => number } {
    let reads = 0;
    const value: Record<string, unknown> = { plain: 1 };
    Object.defineProperty(value, "watched", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    return { value, reads: () => reads };
  }

  for (const name of ["equal", "deepEqual", "deepStrictEqual", "partialDeepStrictEqual", "notDeepStrictEqual"] as const) {
    test(`strict.${name} reads getters only as often as the real comparison`, () => {
      const run = (target: typeof real.strict, message?: unknown) => {
        const left = counted();
        const right = name === "notDeepStrictEqual" ? left : counted();
        if (name !== "notDeepStrictEqual") right.value.plain = 2;
        caught(() => (target[name] as (a: unknown, b: unknown, m?: unknown) => void)(left.value, right.value, message));
        return left.reads() + (right === left ? 0 : right.reads());
      };
      // Real node:assert given an Error message compares and throws it, printing nothing.
      const compareOnly = run(real.strict, new Error("print nothing"));
      // Through the aliased import, so dropping the alias turns this red.
      const aliased = assert as unknown as typeof real.strict;
      assert.equal(run(aliased), compareOnly, "guard, no message");
      assert.equal(run(aliased, "m"), compareOnly, "guard, caller message");
      assert.ok(run(real.strict) > compareOnly, "the real generated message reads getters");
    });
  }

  test("circular and 100k-key objects summarise within bounds, quickly", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    assert.equal(summarise(circular), '{ name: "loop", self: [Circular] }');

    const wide: Record<string, number> = {};
    for (let index = 0; index < 100_000; index += 1) wide[`k${index}`] = index;
    const started = performance.now();
    // The guard itself, not the alias: without the guard this diff runs for minutes.
    const error = caught(() => assertGuardStrict.deepEqual(wide, {}));
    assert.ok(performance.now() - started < 1000, "summary under a second");
    assert.ok(String(error.message).length < 2500, `message length ${String(error.message).length}`);
    assert.match(String(error.actual), /… 99980 more keys/);

    const long = "x".repeat(1_000_000);
    assert.ok(summarise(long).length < 300);
    assert.ok(summarise(Array.from({ length: 1_000_000 }, (_, index) => index)).length < 300);
  });

  test("a fiber-shaped object is labelled, not walked", () => {
    function Card() {}
    const fiber: Record<string, unknown> = { type: Card, stateNode: null, memoizedProps: {}, child: null };
    fiber.return = fiber;
    assert.equal(summarise(fiber), "[React fiber Card]");
  });

  test("a throwing summariser still fails the assertion", () => {
    setSummariserForTest(() => {
      throw new Error("summariser broke");
    });
    try {
      const error = caught(() => assert.equal(1, 2));
      assert.ok(error instanceof real.legacy.AssertionError, "still an AssertionError");
      assert.equal(error.operator, "strictEqual");
    } finally {
      setSummariserForTest(null);
    }
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    assert.equal(summarise(proxy), "[value could not be summarised]");
    assert.ok(caught(() => assert.deepEqual(proxy, { a: 1 })) instanceof Error, "proxy failure still throws");
  });
});

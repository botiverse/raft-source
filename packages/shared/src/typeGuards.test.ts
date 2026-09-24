import assert from "node:assert/strict";
import test from "node:test";
import { makeIsMember } from "./typeGuards.js";

const KINDS = ["turn", "step", "observation"] as const;
type Kind = (typeof KINDS)[number];
const isKind = makeIsMember(KINDS);

// --- Type-level guarantee (enforced by `tsc --noEmit`) ---
// Inside the guard, the value narrows to the precise union with no cast:
function narrowsWithoutCast(raw: unknown): Kind | null {
  if (isKind(raw)) {
    const k: Kind = raw; // would not compile if the guard didn't narrow
    return k;
  }
  return null;
}

test("makeIsMember accepts members and rejects non-members", () => {
  assert.equal(isKind("turn"), true);
  assert.equal(isKind("step"), true);
  assert.equal(isKind("observation"), true);
  assert.equal(isKind("nope"), false);
  assert.equal(isKind(""), false);
});

test("makeIsMember rejects non-string inputs without throwing", () => {
  assert.equal(isKind(undefined), false);
  assert.equal(isKind(null), false);
  assert.equal(isKind(42), false);
  assert.equal(isKind(["turn"]), false);
  assert.equal(isKind({ kind: "turn" }), false);
});

test("makeIsMember narrows to the precise union inside the guard", () => {
  assert.equal(narrowsWithoutCast("step"), "step");
  assert.equal(narrowsWithoutCast("other"), null);
});

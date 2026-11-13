import assert from "node:assert/strict";
import { newContinuationId, stepIdempotencyKey } from "./id";
import { asContinuationId, parseContinuationId } from "./record";

test("continuation ids are ten characters of lower-case Crockford base32, fresh every time", () => {
  const ids = Array.from({ length: 1000 }, () => newContinuationId());
  for (const id of ids) assert.match(id, /^[0-9a-hjkmnp-tv-z]{10}$/);
  assert.equal(new Set(ids).size, ids.length);
});

test("a typed id parses: trimmed, lower-cased, Crockford look-alikes read as digits; anything else is null", () => {
  assert.equal(parseContinuationId("k7q2m3x9ab"), "k7q2m3x9ab");
  assert.equal(parseContinuationId("  K7Q2M3X9AB\n"), "k7q2m3x9ab");
  assert.equal(parseContinuationId("k7q2m3x9aI"), "k7q2m3x9a1");
  assert.equal(parseContinuationId("L0O1lIoOk7"), "10011100k7");
  for (const bad of ["", "k7q2m3x9a", "k7q2m3x9abc", "k7q2m3x9au", "k7q2-m3x9a", "k7q2 m3x9a", "k7q2m3x9a!"]) {
    assert.equal(parseContinuationId(bad), null, JSON.stringify(bad));
  }
  for (let i = 0; i < 100; i += 1) {
    const id = newContinuationId();
    assert.equal(parseContinuationId(id.toUpperCase()), id);
  }
});

test("a step's idempotency key depends only on the chain's root id and the step id", () => {
  const root = asContinuationId("k7q2m3x9ab");
  assert.equal(stepIdempotencyKey(root, "send"), stepIdempotencyKey(asContinuationId("k7q2m3x9ab"), "send"));
  assert.notEqual(stepIdempotencyKey(root, "send"), stepIdempotencyKey(root, "check"));
  assert.notEqual(stepIdempotencyKey(root, "send"), stepIdempotencyKey(asContinuationId("other00000"), "send"));
});

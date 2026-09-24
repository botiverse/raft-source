import assert from "node:assert/strict";
import test from "node:test";
import { bucketDelayMs, computeTraceJitter, NO_JITTER } from "./traceJitter.js";

test("computeTraceJitter is deterministic for the same lockId", () => {
  const a = computeTraceJitter("machine-abcdef0123456789");
  const b = computeTraceJitter("machine-abcdef0123456789");
  assert.deepEqual(a, b);
});

test("computeTraceJitter produces different phases for different lockIds", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 32; i += 1) {
    const jitter = computeTraceJitter(`machine-fleet-${i}`);
    seen.add(`${jitter.initialUploadDelayMs}:${jitter.uploadIntervalJitterMs}:${jitter.maxFileAgeJitterMs}`);
  }
  // A deterministic hash should give high uniqueness for 32 distinct seeds.
  // We allow minor collisions but not total clustering.
  assert.ok(seen.size >= 30, `expected >=30 distinct jitter tuples, got ${seen.size}`);
});

test("computeTraceJitter stays within declared bounds", () => {
  for (let i = 0; i < 256; i += 1) {
    const jitter = computeTraceJitter(`machine-bounds-${i}`);
    assert.ok(jitter.initialUploadDelayMs >= 0 && jitter.initialUploadDelayMs < 30_000);
    assert.ok(jitter.uploadIntervalJitterMs >= 0 && jitter.uploadIntervalJitterMs < 60_000);
    assert.ok(jitter.maxFileAgeJitterMs >= 0 && jitter.maxFileAgeJitterMs < 60_000);
    assert.ok(Number.isInteger(jitter.initialUploadDelayMs));
    assert.ok(Number.isInteger(jitter.uploadIntervalJitterMs));
    assert.ok(Number.isInteger(jitter.maxFileAgeJitterMs));
  }
});

test("computeTraceJitter offsets are independent across the three slots", () => {
  // If we pulled all three offsets from the same byte offset we would expect
  // the three offsets modulo the smallest span to be equal. Ensure that the
  // three offsets disagree often enough to be considered independent.
  let disagreements = 0;
  for (let i = 0; i < 128; i += 1) {
    const jitter = computeTraceJitter(`machine-independence-${i}`);
    const a = jitter.initialUploadDelayMs % 30_000;
    const b = jitter.uploadIntervalJitterMs % 30_000;
    const c = jitter.maxFileAgeJitterMs % 30_000;
    if (!(a === b && b === c)) disagreements += 1;
  }
  assert.ok(disagreements >= 120, `expected high independence, got ${disagreements}/128`);
});

test("NO_JITTER is all zeros — safe fallback for tests and missing lockId", () => {
  assert.equal(NO_JITTER.initialUploadDelayMs, 0);
  assert.equal(NO_JITTER.uploadIntervalJitterMs, 0);
  assert.equal(NO_JITTER.maxFileAgeJitterMs, 0);
});

test("bucketDelayMs returns stable coarse labels", () => {
  assert.equal(bucketDelayMs(0), "0-1s");
  assert.equal(bucketDelayMs(999), "0-1s");
  assert.equal(bucketDelayMs(1_000), "1-5s");
  assert.equal(bucketDelayMs(4_999), "1-5s");
  assert.equal(bucketDelayMs(5_000), "5-15s");
  assert.equal(bucketDelayMs(14_999), "5-15s");
  assert.equal(bucketDelayMs(15_000), "15-30s");
  assert.equal(bucketDelayMs(29_999), "15-30s");
  assert.equal(bucketDelayMs(30_000), "30-60s");
  assert.equal(bucketDelayMs(59_999), "30-60s");
  assert.equal(bucketDelayMs(60_000), "60s-5m");
  assert.equal(bucketDelayMs(299_999), "60s-5m");
  assert.equal(bucketDelayMs(300_000), "5-10m");
  assert.equal(bucketDelayMs(599_999), "5-10m");
  assert.equal(bucketDelayMs(600_000), "10m+");
  assert.equal(bucketDelayMs(3_600_000), "10m+");
});

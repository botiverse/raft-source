import assert from "node:assert/strict";
import { test } from "vitest";
import { MARKETPLACE_INSTALL_BUCKET_LABELS, marketplaceInstallBucket } from "./marketplaceInstalls";

// The thresholds the install badge has always shown (10+, 100+, 1k+); below 10 nothing is shown.
test("install counts fall into the badge's buckets at 10, 100 and 1000", () => {
  const cases: Array<[number, string | null]> = [
    [0, null], [9, null],
    [10, "10_plus"], [99, "10_plus"],
    [100, "100_plus"], [999, "100_plus"],
    [1000, "1k_plus"], [1_000_000, "1k_plus"],
  ];
  for (const [count, bucket] of cases) assert.equal(marketplaceInstallBucket(count), bucket, String(count));
  assert.deepEqual(MARKETPLACE_INSTALL_BUCKET_LABELS, { "10_plus": "10+", "100_plus": "100+", "1k_plus": "1k+" });
});

test("an install count is a non-negative whole number", () => {
  for (const count of [-1, 1.5, Number.NaN]) assert.throws(() => marketplaceInstallBucket(count), /non-negative integer/u);
});

#!/usr/bin/env node

import { readFileSync } from "node:fs";

const [reportPath, expectedCountText, ...expectedNames] = process.argv.slice(2);
const expectedCount = Number(expectedCountText);

if (!reportPath || !Number.isInteger(expectedCount) || expectedCount < 1) {
  throw new Error("usage: assert-vitest-selection <report.json> <expected-count> <exact-test-name>...");
}
if (expectedNames.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} names, received ${expectedNames.length}`);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? []);
const passedNames = assertions
  .filter((assertion) => assertion.status === "passed")
  .map((assertion) => assertion.fullName);
const failedNames = assertions
  .filter((assertion) => assertion.status === "failed")
  .map((assertion) => assertion.fullName);
const expectedSet = new Set(expectedNames);
const missing = expectedNames.filter((name) => !passedNames.includes(name));
const unexpected = passedNames.filter((name) => !expectedSet.has(name));

if (report.success !== true || failedNames.length > 0) {
  throw new Error(`Vitest report was not successful; failed=${failedNames.join(", ") || "unknown"}`);
}
if (passedNames.length !== expectedCount || missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    `selected test mismatch: expected=${expectedCount}, passed=${passedNames.length}, ` +
    `missing=${missing.join(" | ") || "none"}, unexpected=${unexpected.join(" | ") || "none"}`,
  );
}

console.log(`Vitest selection attested: ${passedNames.length} exact test(s) passed`);

import assert from "node:assert/strict";
import test from "node:test";
import { dynamicImportFailureKey, isDynamicImportFailure } from "../src/utils/dynamicImportRecovery.js";

test("dynamic import fetch failures are recognized by chunk URL", () => {
  const error = new TypeError(
    "Failed to fetch dynamically imported module: https://app.raft.build/assets/MachineDetailPanel-DHMJmg8X.js",
  );

  const key = dynamicImportFailureKey(error);

  assert.equal(key, "slock:dynamic-import-failure:https://app.raft.build/assets/MachineDetailPanel-DHMJmg8X.js");
  assert.equal(isDynamicImportFailure(error), true);
});

test("ordinary render errors do not trigger stale-build recovery", () => {
  assert.equal(dynamicImportFailureKey(new Error("Cannot read properties of undefined")), null);
  assert.equal(isDynamicImportFailure(new Error("Cannot read properties of undefined")), false);
});

test("Vite preload failures are recognized", () => {
  const error = new Error("Unable to preload CSS for /assets/MachineDetailPanel-DHMJmg8X.css");

  assert.match(dynamicImportFailureKey(error) ?? "", /^slock:dynamic-import-failure:/);
});

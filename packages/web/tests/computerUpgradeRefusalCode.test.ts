import assert from "node:assert/strict";
import { test } from "vitest";
import { upgradeRefusalFromCode } from "../src/components/machine/useComputerUpgradeCard";

test("a scope_unavailable refusal (a page loaded before the server knew) shows the system-service state, not 'try again later'", () => {
  assert.equal(upgradeRefusalFromCode("scope_unavailable"), "system_service");
  assert.equal(upgradeRefusalFromCode("computer_managed_by_desktop"), "managed_by_desktop");
  assert.equal(upgradeRefusalFromCode("something_new"), "unknown");
  assert.equal(upgradeRefusalFromCode(undefined), "unknown");
});

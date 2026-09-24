import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentMigrationRequiresUpgrade,
  isMigrationProPlanRequiredError,
  MIGRATION_PRO_PLAN_REQUIRED_CODE,
} from "../src/utils/agentMigrationBilling";

test("migration paid-entry projection follows the shared trial and paid-plan policy", () => {
  const duringTrial = new Date("2026-05-01T00:00:00.000Z");
  const afterTrial = new Date("2026-07-01T00:00:00.000Z");

  assert.equal(agentMigrationRequiresUpgrade("free", duringTrial), false);
  assert.equal(agentMigrationRequiresUpgrade("free", afterTrial), true);
  assert.equal(agentMigrationRequiresUpgrade("pro", afterTrial), false);
  assert.equal(agentMigrationRequiresUpgrade("founder", afterTrial), false);
  assert.equal(agentMigrationRequiresUpgrade("partner", afterTrial), false);
});

test("migration paid-entry projection fails open when the projection is unavailable or unknown", () => {
  const afterTrial = new Date("2026-07-01T00:00:00.000Z");

  assert.equal(agentMigrationRequiresUpgrade(null, afterTrial), false);
  assert.equal(agentMigrationRequiresUpgrade(undefined, afterTrial), false);
  assert.equal(agentMigrationRequiresUpgrade("team", afterTrial), false);
});

test("migration paid-entry recognizes only the exact backend denial code", () => {
  assert.equal(isMigrationProPlanRequiredError({
    response: { data: { code: MIGRATION_PRO_PLAN_REQUIRED_CODE } },
  }), true);
  assert.equal(isMigrationProPlanRequiredError({
    response: { data: { code: `${MIGRATION_PRO_PLAN_REQUIRED_CODE}_OLD` } },
  }), false);
  assert.equal(isMigrationProPlanRequiredError(new Error("MIGRATION_PRO_PLAN_REQUIRED")), false);
  assert.equal(isMigrationProPlanRequiredError(null), false);
});

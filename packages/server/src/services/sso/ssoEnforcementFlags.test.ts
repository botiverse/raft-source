// An unreadable flag (RFC 083 §6.2): enforcement treats it as on, turning
// `required` on treats it as not reviewed, and the settings show it as
// reviewed because it enforces.
import assert from "node:assert/strict";
import { test, vi } from "vitest";

vi.mock("../featureFlagService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../featureFlagService")>();
  return {
    ...actual,
    evaluateFeatureFlag: vi.fn(async () => { throw new Error("flag store unreachable"); }),
  };
});

const { ssoRequirementFlagsOn, ssoRequirementReviewed } = await import("./ssoEnforcement");
const executor = {} as never;

test("an unreadable flag keeps a requirement enforced", async () => {
  assert.equal(await ssoRequirementFlagsOn("server-1", executor), true);
});

test("an unreadable review reads as not reviewed when turning `required` on, and as reviewed for the settings", async () => {
  assert.equal(await ssoRequirementReviewed("server-1", executor), false);
  assert.equal(await ssoRequirementReviewed("server-1", executor, { unreadable: true }), true);
});

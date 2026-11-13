import assert from "node:assert/strict";
import {
  appPermissionsChangedCurrentSet,
  expectedAppPermissionsBody,
  isAppPermissionsChangedError,
  isExpectedPermissionsRequiredError,
} from "../src/lib/appPermissionExpectation";

const changed = (data: Record<string, unknown>) => ({ response: { status: 409, data: { code: "APP_PERMISSIONS_CHANGED", ...data } } });

test("the expected body copies the shown set", () => {
  const scopes = ["openid"];
  const body = expectedAppPermissionsBody(scopes, ["server"]);
  assert.deepEqual(body, { expected_scopes: ["openid"], expected_groups: ["server"] });
  assert.ok(body.expected_scopes !== scopes);
});

test("409 APP_PERMISSIONS_CHANGED yields the server's current set", () => {
  const error = changed({ current_scopes: ["openid", "email"], current_groups: [] });
  assert.equal(isAppPermissionsChangedError(error), true);
  assert.deepEqual(appPermissionsChangedCurrentSet(error), { scopes: ["openid", "email"], groups: [] });
});

test("a 409 without a usable set, or another code, yields no set", () => {
  assert.equal(appPermissionsChangedCurrentSet(changed({})), null);
  assert.equal(appPermissionsChangedCurrentSet(changed({ current_scopes: [1], current_groups: [] })), null);
  assert.equal(appPermissionsChangedCurrentSet({ response: { status: 409, data: { code: "OTHER" } } }), null);
  assert.equal(appPermissionsChangedCurrentSet(null), null);
});

test("400 EXPECTED_PERMISSIONS_REQUIRED is told apart from other 400s", () => {
  assert.equal(isExpectedPermissionsRequiredError({ response: { status: 400, data: { code: "EXPECTED_PERMISSIONS_REQUIRED" } } }), true);
  assert.equal(isExpectedPermissionsRequiredError({ response: { status: 400, data: {} } }), false);
  assert.equal(isExpectedPermissionsRequiredError(new Error("network")), false);
});

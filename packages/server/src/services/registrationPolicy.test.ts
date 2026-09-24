import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertRegistrationEnabled,
  getRegistrationBlockedReason,
} from "./registrationPolicy.js";

test("registration policy allows staging", () => {
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.DEPLOYMENT_ENV = "staging";

  assert.equal(getRegistrationBlockedReason(), null);
  assert.doesNotThrow(() => assertRegistrationEnabled());

  if (previousDeploymentEnv === undefined) {
    delete process.env.DEPLOYMENT_ENV;
  } else {
    process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
  }
});

test("registration policy allows production", () => {
  const previousDeploymentEnv = process.env.DEPLOYMENT_ENV;
  process.env.DEPLOYMENT_ENV = "production";

  assert.equal(getRegistrationBlockedReason(), null);
  assert.doesNotThrow(() => assertRegistrationEnabled());

  if (previousDeploymentEnv === undefined) {
    delete process.env.DEPLOYMENT_ENV;
  } else {
    process.env.DEPLOYMENT_ENV = previousDeploymentEnv;
  }
});

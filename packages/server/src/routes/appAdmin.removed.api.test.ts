import { createApiTest } from "../test/integration/apiTest.js";

import assert from "node:assert/strict";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("public API does not expose app-admin routes", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/app-admin/me`);
  assert.equal(res.status, 404);
});

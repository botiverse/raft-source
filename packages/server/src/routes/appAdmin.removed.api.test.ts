import { createApiTest } from "../test/integration/apiTest";

import assert from "node:assert/strict";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("public API does not expose app-admin routes", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/app-admin/me`);
  assert.equal(res.status, 404);
});

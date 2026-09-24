import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV } from "../services/agentCredentialService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("self-hosted runner bootstrap exchange route is not mounted by default", async () => {
  const oldValue = process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV];
  delete process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const res = await fetch(`${app.baseUrl}/api/agent/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapToken: "abtk_test" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await app.close();
    if (oldValue === undefined) {
      delete process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV];
    } else {
      process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV] = oldValue;
    }
  }
});

test("self-hosted runner bootstrap exchange route can be explicitly enabled", async () => {
  const oldValue = process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV];
  process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV] = "true";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const res = await fetch(`${app.baseUrl}/api/agent/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "missing_bootstrap_token");
  } finally {
    await app.close();
    if (oldValue === undefined) {
      delete process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV];
    } else {
      process.env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV] = oldValue;
    }
  }
});

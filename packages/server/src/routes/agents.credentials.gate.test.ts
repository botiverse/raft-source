import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Smoke test for `POST /api/agents/:id/credentials`.
 *
 * As of #1918 v0 the route is mounted in `app.ts` BEFORE the
 * `agentRouter` mount, using only `requireAuth` + `requireVerified`
 * (NOT `requireServer`) — server context is derived from `agent.serverId`
 * inside the handler. See `agentCredentials.ts` for the rationale.
 *
 * `requireAuth` runs ahead of the handler, so an unauthenticated caller
 * always gets 401 before the gate-flag check. That order is the intended
 * security posture (no enumeration of feature flags via status codes),
 * so we keep this file minimal:
 *
 *   - **Route is mounted**: an unauthenticated POST returns 401, not 404.
 *     This is the "route exists" sanity check that protects against
 *     accidental code-path bypass (e.g. someone re-introducing the route
 *     under `agentRouter` and breaking the no-X-Server-Id contract).
 *
 * End-to-end positive + authorization paths live in
 * `agentCredentials.api.test.ts`.
 */

import assert from "node:assert/strict";


const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const TARGET_PATH = "/api/agents/agent-unknown/credentials";

test("agent credential mint route is mounted (unauth returns 401, not 404)", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}${TARGET_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  // Auth middleware runs before the route handler — we expect a
  // standard unauthenticated response. We don't pin the exact code
  // (could be 401 or 403 depending on middleware wiring), only
  // that it is NOT the 404 a missing-route would return.
  assert.notEqual(
    res.status,
    404,
    `route appears unmounted — got 404, expected an auth-middleware response`,
  );
  assert.ok(
    res.status === 401 || res.status === 403,
    `expected 401/403 for unauthenticated call, got ${res.status}`,
  );
  for (const method of ["GET", "DELETE"]) {
    const suffix = method === "DELETE" ? "/credential-unknown" : "";
    const denied = await fetch(`${app.baseUrl}${TARGET_PATH}${suffix}`, { method });
    assert.equal(denied.status, 401);
  }
});

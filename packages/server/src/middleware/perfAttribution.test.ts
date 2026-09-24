import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { openTestApp } from "../test/integration/app.js";
import {
  buildPerfAttributionEvent,
  PERF_ATTRIBUTION_ENV,
  PERF_CALLER_CONTEXT_HEADER,
  PERF_SCENARIO_ID_HEADER,
} from "./perfAttribution.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("buildPerfAttributionEvent normalizes 5xx responses into the 5xx bucket", () => {
  const req: any = {
    method: "GET",
    originalUrl: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    url: "/api/servers/550e8400-e29b-41d4-a716-446655440000/members/123/profile?limit=20",
    baseUrl: "/api/servers",
    route: { path: "/:id/members/:memberId/profile" },
    userId: "user-123",
    machineId: undefined,
    header(name: string) {
      const lower = name.toLowerCase();
      if (lower === PERF_CALLER_CONTEXT_HEADER) return "members_load";
      if (lower === PERF_SCENARIO_ID_HEADER) return "staging-members-burst";
      return undefined;
    },
  };
  const res: any = { statusCode: 503 };

  const event = buildPerfAttributionEvent(req, res);
  assert.ok(event);
  assert.equal(event.status_bucket, "5xx");
  assert.equal(event.response_status, 503);
  assert.equal(event.route_pattern, "/api/servers/:id/members/:memberId/profile?limit=*");
  assert.equal(event.caller_context, "members_load");
  assert.equal(event.scenario_id, "staging-members-burst");
  assert.equal(event.user_id, "user:user-123");
});

test("perfAttributionMiddleware logs a 429 auth limiter event when perf headers are present", async () => {
  const previous = process.env[PERF_ATTRIBUTION_ENV];
  process.env[PERF_ATTRIBUTION_ENV] = "1";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const originalInfo = console.info;
  const captured: string[] = [];
  console.info = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };

  try {
    let sawRateLimit = false;
    for (let i = 0; i < 220; i++) {
      const res = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Perf-Caller-Context": "unknown",
          "X-Perf-Scenario-Id": "ci-run-24610986389",
        },
        body: JSON.stringify({ email: "nobody@slock.test", password: "wrong-password" }),
      });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
      assert.equal(res.status, 401);
    }
    assert.equal(sawRateLimit, true, "expected auth limiter to emit a 429 within 220 attempts");

    const attributionLine = captured.find((line) => line.startsWith("[perf-attribution] "));
    assert.ok(attributionLine, "expected a perf attribution log line");
    const payload = JSON.parse(attributionLine!.slice("[perf-attribution] ".length)) as {
      route_pattern: string;
      response_status: number;
      status_bucket: string;
      caller_context: string;
      scenario_id: string | null;
    };
    assert.equal(payload.route_pattern, "/api/auth/login");
    assert.equal(payload.response_status, 429);
    assert.equal(payload.status_bucket, "429");
    assert.equal(payload.caller_context, "unknown");
    assert.equal(payload.scenario_id, "ci-run-24610986389");
  } finally {
    console.info = originalInfo;
    if (previous === undefined) delete process.env[PERF_ATTRIBUTION_ENV];
    else process.env[PERF_ATTRIBUTION_ENV] = previous;
    await app.close();
  }
});

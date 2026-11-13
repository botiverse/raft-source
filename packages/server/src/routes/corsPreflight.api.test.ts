import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { CORS_PREFLIGHT_MAX_AGE_SECONDS } from "../app";
import { getWebCorsOrigins } from "../config/appUrl";

const test = createApiTest();

// task #17: the web app is cross-origin to the API and sends Authorization, so
// every call is preflighted. Without Access-Control-Max-Age the browser keeps a
// preflight for 5s, and most API calls paid an extra OPTIONS round trip.
test("API preflights tell the browser to cache them for 2 hours", async ({ app }) => {
  const origin = getWebCorsOrigins()[0];
  assert.ok(origin, "a web origin is configured for the test app");
  const res = await fetch(`${app.baseUrl}/api/servers`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-server-id",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  assert.equal(res.headers.get("access-control-max-age"), String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
  assert.equal(CORS_PREFLIGHT_MAX_AGE_SECONDS, 7200, "Chrome caps preflight caching at 7200s");
});

// Raft Desktop serves this web app from app://raft and calls the API from that
// origin. The API allows exactly that origin, as it allows the web's: the
// origin is echoed (never `*`), with the same credentials and preflight cache.
// A look-alike app:// origin, or any other unlisted origin, gets no CORS grant.
test("Raft Desktop's app://raft origin is allowed exactly, like a web origin", async ({ app }) => {
  const preflight = (origin: string) => fetch(`${app.baseUrl}/api/servers`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,x-server-id",
    },
  });
  const desktop = await preflight("app://raft");
  assert.equal(desktop.status, 204);
  assert.equal(desktop.headers.get("access-control-allow-origin"), "app://raft");
  assert.equal(desktop.headers.get("access-control-allow-credentials"), "true");
  assert.equal(desktop.headers.get("access-control-max-age"), String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
  assert.match(desktop.headers.get("vary") ?? "", /Origin/);

  const get = await fetch(`${app.baseUrl}/robots.txt`, { headers: { Origin: "app://raft" } });
  assert.equal(get.headers.get("access-control-allow-origin"), "app://raft");

  for (const origin of ["app://raft.evil", "app://evil", "app://raft:1", "https://evil.example.com", "null"]) {
    const res = await preflight(origin);
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
  }
});

// Resource Timing segments for our own pages only (AndyLok, #triage:8c0d2318):
// the API echoes an allowed Origin in Timing-Allow-Origin, never `*`, and an
// unlisted origin gets none.
test("Timing-Allow-Origin echoes only our own origins", async ({ app }) => {
  const get = (origin: string) => fetch(`${app.baseUrl}/robots.txt`, { headers: { Origin: origin } });
  for (const origin of [getWebCorsOrigins()[0]!, "app://raft"]) {
    const res = await get(origin);
    assert.equal(res.headers.get("timing-allow-origin"), origin, origin);
  }
  for (const origin of ["https://evil.example.com", "app://evil", "null"]) {
    const res = await get(origin);
    assert.equal(res.headers.get("timing-allow-origin"), null, origin);
  }
  const noOrigin = await fetch(`${app.baseUrl}/robots.txt`);
  assert.equal(noOrigin.headers.get("timing-allow-origin"), null);
});

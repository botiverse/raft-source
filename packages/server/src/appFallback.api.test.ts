import { createApiTest } from "./test/integration/apiTest.js";
import assert from "node:assert/strict";


const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("unmatched app routes return a noindex JSON 404", async ({ app }) => {
  const root = await fetch(`${app.baseUrl}/`);
  assert.equal(root.status, 404);
  assert.match(root.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(root.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepEqual(await root.json(), {
    error: "Not found",
    code: "not_found",
    path: "/",
  });

  const missing = await fetch(`${app.baseUrl}/not-a-real-path`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(missing.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepEqual(await missing.json(), {
    error: "Not found",
    code: "not_found",
    path: "/not-a-real-path",
  });

  const missingApi = await fetch(`${app.baseUrl}/api/not-a-real-path`);
  assert.equal(missingApi.status, 404);
  assert.match(missingApi.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(missingApi.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepEqual(await missingApi.json(), {
    error: "Not found",
    code: "not_found",
    path: "/api/not-a-real-path",
  });
});

test("health keeps its JSON body and carries the API noindex header", async ({ app }) => {
  const health = await fetch(`${app.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("ordinary app never mounts Playwright scenario lifecycle routes", async ({ app }) => {
  for (const [method, path] of [
    ["POST", "/__playwright/scenarios"],
    ["DELETE", "/__playwright/scenarios/not-owned"],
    ["POST", "/__playwright/scenarios/not-owned/thread-window"],
  ]) {
    const response = await fetch(`${app.baseUrl}${path}`, { method });
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, "not_found");
  }
});

test("API robots.txt explicitly rejects crawlers", async ({ app }) => {
  const robots = await fetch(`${app.baseUrl}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(robots.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(await robots.text(), [
    "# Raft API host: authenticated API surface with no indexable public pages.",
    "User-agent: *",
    "Disallow: /",
    "",
  ].join("\n"));
});

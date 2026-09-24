import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import argon2 from "argon2";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createFeatureFlag, createFeatureFlagRule } from "../services/featureFlagService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// Absence tooth for the server-side feature-flag admin surface (Group C).
//
// Feature-flag administration belongs to the standalone Feature Flag Admin Worker,
// which authorizes itself and reaches the production database over its own
// least-privilege connection. The main server must not carry flag-admin CRUD.
//
// The HTTP checks below prove the product router remains mounted while these exact
// paths are absent. A separate source contract proves the production router carries
// no admin route declarations or operator-roster environment seam, so a 404 cannot
// be satisfied by leaving an inaccessible handler behind.
async function readProductionServerSources(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources: string[] = [];

  for (const entry of entries) {
    if (entry.name === "test" || entry.name === "__tests__") continue;
    const entryUrl = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      sources.push(...await readProductionServerSources(entryUrl));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    sources.push(await readFile(entryUrl, "utf8"));
  }

  return sources;
}

test("production routers and services carry no admin declarations or core operator roster", async () => {
  const [featureFlagsSource, oauthSource, productionSources] = await Promise.all([
    readFile(new URL("./featureFlags.ts", import.meta.url), "utf8"),
    readFile(new URL("./oauth.ts", import.meta.url), "utf8"),
    readProductionServerSources(new URL("../", import.meta.url)),
  ]);

  assert.doesNotMatch(featureFlagsSource, /["']\/admin\/flags/, "core featureFlags router must not declare admin routes");
  assert.doesNotMatch(oauthSource, /["']\/operator\/feature-flags/, "core OAuth router must not declare flag admin routes");
  assert.doesNotMatch(oauthSource, /["']\/operator\/announcements/, "core OAuth router must not declare announcement admin routes");

  const retiredCoreEnvNames = [
    ["RAFT", "FEATURE", "FLAG", "OPERATOR", "USER", "IDS"].join("_"),
    ["FEATURE", "FLAG", "OPERATOR", "PRINCIPAL", "IDS"].join("_"),
    ["RAFT", "ANNOUNCEMENT", "OPERATOR", "PRINCIPAL", "IDS"].join("_"),
    ["FEATURE", "FLAG", "OPERATOR", "OAUTH", "CLIENT", "ID"].join("_"),
    ["ANNOUNCEMENT", "OPERATOR", "OAUTH", "CLIENT", "ID"].join("_"),
  ];
  const productionSource = productionSources.join("\n");
  for (const envName of retiredCoreEnvNames) {
    assert.equal(productionSource.includes(envName), false, `${envName} must not remain in Raft core production code`);
  }
});

test("public API does not expose feature-flag admin routes", async () => {
  const authorityEnv = "RAFT_FEATURE_FLAG_OPERATOR_USER_IDS";
  const previousAuthority = process.env[authorityEnv];
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [operator] = await db.insert(users).values({
      email: "ff-admin-removed@slock.test",
      name: "ff-admin-removed",
      passwordHash,
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    process.env[authorityEnv] = operator.id;

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: operator.email, password: "password123" }),
    });
    assert.equal(loginRes.status, 200, await loginRes.clone().text());
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const suffix = operator.id.replaceAll("-", "").slice(0, 12);
    const fixtureKey = `removed_probe_${suffix}`;
    const createKey = `removed_create_${suffix}`;
    await createFeatureFlag({
      key: fixtureKey,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "removed-admin-fixture",
    });
    const fixtureRule = await createFeatureFlagRule({
      flagKey: fixtureKey,
      stage: "server",
      decision: "allow",
      values: [],
    });
    const removedRoutes: ReadonlyArray<{ method: string; path: string; body?: unknown }> = [
      { method: "GET", path: "/api/feature-flags/admin/flags" },
      {
        method: "POST",
        path: "/api/feature-flags/admin/flags",
        body: { key: createKey, randomizationUnit: "server", defaultEnabled: false },
      },
      { method: "GET", path: `/api/feature-flags/admin/flags/${fixtureKey}` },
      {
        method: "PATCH",
        path: `/api/feature-flags/admin/flags/${fixtureKey}`,
        body: { description: "removed route fixture" },
      },
      {
        method: "POST",
        path: `/api/feature-flags/admin/flags/${fixtureKey}/kill-switch`,
        body: { killSwitch: true },
      },
      {
        method: "POST",
        path: `/api/feature-flags/admin/flags/${fixtureKey}/rules`,
        body: { stage: "server", decision: "allow", values: [] },
      },
      {
        method: "PATCH",
        path: `/api/feature-flags/admin/flags/${fixtureKey}/rules/${fixtureRule.id}`,
        body: { priority: 1 },
      },
      {
        method: "DELETE",
        path: `/api/feature-flags/admin/flags/${fixtureKey}/rules/${fixtureRule.id}`,
      },
      { method: "DELETE", path: `/api/feature-flags/admin/flags/${fixtureKey}` },
    ];

    // Positive control: the product-side evaluate route on the same router is still
    // reachable for this caller. Without it, a mis-mounted router would make every
    // assertion below pass for the wrong reason.
    const evaluate = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ keys: [] }),
    });
    assert.notEqual(
      evaluate.status,
      404,
      "product evaluate route must still exist; a 404 here means the whole router is gone",
    );

    const statuses: Array<{ method: string; path: string; status: number }> = [];
    for (const { method, path, body } of removedRoutes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      statuses.push({ method, path, status: res.status });
    }
    assert.deepEqual(
      statuses,
      removedRoutes.map(({ method, path }) => ({ method, path, status: 404 })),
      "every generic feature-flag admin method/path must be route-absent; real flag/rule fixtures make each B-side handler non-404",
    );
  } finally {
    if (previousAuthority === undefined) delete process.env[authorityEnv];
    else process.env[authorityEnv] = previousAuthority;
    await close();
  }
});

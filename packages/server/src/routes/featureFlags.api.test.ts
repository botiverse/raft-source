import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer } from "../services/serverService";
import {
  createFeatureFlag,
  createFeatureFlagRule,
  setFeatureFlagKillSwitch,
} from "../services/featureFlagService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// A default-on, server-randomized flag owned by this test.
const DEFAULT_ON_FLAG_KEY = "api_default_on_v0";

// Flag fixtures are built through the service layer on purpose. Flag administration
// lives in the standalone Feature Flag Admin Worker, so the main server exposes no
// admin CRUD to drive setup with; see featureFlagsAdmin.removed.api.test.ts for the
// tooth that keeps it that way. What this file covers is the product-side contract:
// /evaluate is member-scoped and honours server rules, platform rules, and the kill
// switch.



function authHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

test("feature flags API: product eval is member-scoped and honours rules", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner] = await db.insert(users).values({
      email: "feature-api-owner@slock.test",
      name: "feature-api-owner",
      passwordHash,
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [outsider] = await db.insert(users).values({
      email: "feature-api-outsider@slock.test",
      name: "feature-api-outsider",
      passwordHash,
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Feature API", "feature-api", owner.id);
    const ownerToken = await tokenForHuman(owner.email);
    const outsiderToken = await tokenForHuman(outsider.email);

    await createFeatureFlag({
      key: DEFAULT_ON_FLAG_KEY,
      randomizationUnit: "server",
      defaultEnabled: true,
      salt: DEFAULT_ON_FLAG_KEY,
    });

    const productEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, keys: [DEFAULT_ON_FLAG_KEY] }),
    });
    assert.equal(productEval.status, 200, await productEval.clone().text());
    assert.deepEqual((await productEval.json()) as unknown, {
      evaluations: [{
        key: DEFAULT_ON_FLAG_KEY,
        enabled: true,
        reason: "default",
      }],
    });

    const outsiderEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ serverId: server.id, keys: [DEFAULT_ON_FLAG_KEY] }),
    });
    assert.equal(outsiderEval.status, 403);

    await createFeatureFlag({
      key: "api_test_v0",
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "api-test-salt",
    });
    await createFeatureFlagRule({
      flagKey: "api_test_v0",
      stage: "server",
      decision: "allow",
      values: [server.id],
    });
    await createFeatureFlagRule({
      flagKey: "api_test_v0",
      stage: "platform",
      decision: "deny",
      values: ["mobile"],
    });

    const serverRuleEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, keys: ["api_test_v0"] }),
    });
    assert.equal(serverRuleEval.status, 200, await serverRuleEval.clone().text());
    assert.deepEqual((await serverRuleEval.json()) as unknown, {
      evaluations: [{
        key: "api_test_v0",
        enabled: true,
        reason: "server_rule",
      }],
    });

    const webEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, platform: "web", keys: ["api_test_v0"] }),
    });
    assert.equal(webEval.status, 200);
    assert.deepEqual((await webEval.json()) as unknown, {
      evaluations: [{
        key: "api_test_v0",
        enabled: true,
        reason: "server_rule",
      }],
    });

    const mobileEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, platform: "mobile", keys: ["api_test_v0"] }),
    });
    assert.equal(mobileEval.status, 200);
    assert.deepEqual((await mobileEval.json()) as unknown, {
      evaluations: [{
        key: "api_test_v0",
        enabled: false,
        reason: "platform_rule",
      }],
    });

    const invalidPlatformEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, platform: "desktop", keys: ["api_test_v0"] }),
    });
    assert.equal(invalidPlatformEval.status, 400);

    await setFeatureFlagKillSwitch(DEFAULT_ON_FLAG_KEY, true);

    const productEvalAfterKill = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, keys: [DEFAULT_ON_FLAG_KEY] }),
    });
    assert.equal(productEvalAfterKill.status, 200);
    assert.deepEqual((await productEvalAfterKill.json()) as unknown, {
      evaluations: [{
        key: DEFAULT_ON_FLAG_KEY,
        enabled: false,
        reason: "kill_switch",
      }],
    });
  } finally {
    await close();
  }
});

test("feature flags API: client facts from the mobile body drive client rules and never fail the request", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const [owner] = await getDb().insert(users).values({
      email: "feature-api-client@slock.test",
      name: "feature-api-client",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Feature API Client", "feature-api-client", owner.id);
    const token = await tokenForHuman(owner.email);
    await createFeatureFlag({ key: "api_client_v0", randomizationUnit: "server", defaultEnabled: false, salt: "api-client" });
    await createFeatureFlagRule({
      flagKey: "api_client_v0",
      stage: "client",
      decision: "allow",
      values: [server.id],
      clientOs: ["android"],
      minClientBuild: 1120131,
    });
    const evaluate = async (extra: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ serverId: server.id, platform: "mobile", keys: ["api_client_v0"], ...extra }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { evaluations: Array<{ enabled: boolean; reason: string }> }).evaluations[0];
    };

    // Exactly what the mobile client sends (buildNumber is a string on the wire).
    assert.deepEqual(
      await evaluate({ os: "android", appVersion: "1.12.0", buildNumber: "1120131", buildType: "alpha" }),
      { key: "api_client_v0", enabled: true, reason: "client_rule" },
    );
    assert.equal((await evaluate({ os: "android", buildNumber: "1120130" })).enabled, false);
    await createFeatureFlag({ key: "api_client_alpha_v0", randomizationUnit: "server", defaultEnabled: false, salt: "api-client-alpha" });
    await createFeatureFlagRule({
      flagKey: "api_client_alpha_v0",
      stage: "client",
      decision: "allow",
      values: [server.id],
      clientBuildTypes: ["alpha"],
    });
    const alpha = async (buildType: unknown) => {
      const response = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ serverId: server.id, platform: "mobile", keys: ["api_client_alpha_v0"], os: "android", buildNumber: "1000031", buildType }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { evaluations: Array<{ enabled: boolean }> }).evaluations[0].enabled;
    };
    assert.equal(await alpha("alpha"), true);
    assert.equal(await alpha("release"), false);
    assert.equal(await alpha("ALPHA"), false); // not normalised by the server: the client sends lowercase
    assert.equal(await alpha("connectedTest"), false); // CI-only Android build type is outside the allowed set
    assert.equal(await alpha(null), false);
    // Old clients, unknown OS, and malformed builds are "not reported": no match, still 200.
    for (const extra of [
      {},
      { os: "desktop", buildNumber: "1120200" },
      { os: "android", buildNumber: "1.12.0" },
      { os: "android", buildNumber: null },
      { os: "android", buildNumber: -5 },
      { os: 7, buildNumber: 1120200 },
    ]) {
      assert.deepEqual(await evaluate(extra), { key: "api_client_v0", enabled: false, reason: "default" }, JSON.stringify(extra));
    }
  } finally {
    await close();
  }
});

// Raft's app hosts were here (#11375) and moved to the per-deploy client config
// (GET /api/public/client-config, publicClientConfig.api.test.ts): this answer is
// the flags only, whatever the deployment's hosts are.
test("feature flags API: the answer is the flags only; Raft's app hosts are not in it", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const before = { APP_URL: process.env.APP_URL, APP_PERMALINK_HOSTS: process.env.APP_PERMALINK_HOSTS };
  try {
    const [owner] = await getDb().insert(users).values({
      email: "feature-api-hosts@slock.test",
      name: "feature-api-hosts",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Feature API Hosts", "feature-api-hosts", owner.id);
    const token = await tokenForHuman(owner.email);
    process.env.APP_URL = "https://chat.example.test";
    process.env.APP_PERMALINK_HOSTS = "https://raft-staging.pages.dev, Staging.Example.Dev";
    for (const body of [{ serverId: server.id, platform: "web", keys: ["api_hosts_v0"] }, { keys: ["api_hosts_v0"] }]) {
      const response = await fetch(`${baseUrl}/api/feature-flags/evaluate`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      const answer = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(answer), ["evaluations"], JSON.stringify(body));
    }
  } finally {
    if (before.APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = before.APP_URL;
    if (before.APP_PERMALINK_HOSTS === undefined) delete process.env.APP_PERMALINK_HOSTS;
    else process.env.APP_PERMALINK_HOSTS = before.APP_PERMALINK_HOSTS;
    await close();
  }
});

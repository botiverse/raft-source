import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import {
  ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
  createFeatureFlag,
  createFeatureFlagRule,
  setFeatureFlagKillSwitch,
} from "../services/featureFlagService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
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

    const productEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, keys: [ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY] }),
    });
    assert.equal(productEval.status, 200, await productEval.clone().text());
    assert.deepEqual((await productEval.json()) as unknown, {
      evaluations: [{
        key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        enabled: true,
        reason: "default",
      }],
    });

    const outsiderEval = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(outsiderToken),
      body: JSON.stringify({ serverId: server.id, keys: [ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY] }),
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

    await setFeatureFlagKillSwitch(ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY, true);

    const productEvalAfterKill = await fetch(`${baseUrl}/api/feature-flags/evaluate`, {
      method: "POST",
      headers: authHeaders(ownerToken),
      body: JSON.stringify({ serverId: server.id, keys: [ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY] }),
    });
    assert.equal(productEvalAfterKill.status, 200);
    assert.deepEqual((await productEvalAfterKill.json()) as unknown, {
      evaluations: [{
        key: ATTACHMENT_COMMENTS_FEATURE_FLAG_KEY,
        enabled: false,
        reason: "kill_switch",
      }],
    });
  } finally {
    await close();
  }
});

import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { featureFlags, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createFeatureFlag, createFeatureFlagRule } from "../services/featureFlagService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// Task #205: GET /api/public/feature-flags answers before login. Fixtures go through the service
// layer plus a direct column write for pre_auth_evaluable, because flag administration lives in the
// standalone Feature Flag Admin Worker.

async function markPreAuth(key: string) {
  await getDb().update(featureFlags).set({ preAuthEvaluable: true }).where(eq(featureFlags.key, key));
}

test("public feature flags: only marked flags answer, from kill switch, enabled, platform rules and default", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "public-flags-owner@slock.test",
      name: "public-flags-owner",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Public Flags", "public-flags", owner.id);
    const ownerToken = await tokenForHuman(owner.email);

    // Marked, default on.
    await createFeatureFlag({ key: "preauth_default_on_v0", randomizationUnit: "user", defaultEnabled: true });
    await markPreAuth("preauth_default_on_v0");
    // Same configuration, not marked: must answer false.
    await createFeatureFlag({ key: "preauth_unmarked_v0", randomizationUnit: "user", defaultEnabled: true });
    // Marked but switched off two ways.
    await createFeatureFlag({ key: "preauth_disabled_v0", randomizationUnit: "user", defaultEnabled: true, enabled: false });
    await markPreAuth("preauth_disabled_v0");
    await createFeatureFlag({ key: "preauth_killed_v0", randomizationUnit: "user", defaultEnabled: true, killSwitch: true });
    await markPreAuth("preauth_killed_v0");
    // Marked, default off, on for mobile by platform rule.
    await createFeatureFlag({ key: "preauth_mobile_v0", randomizationUnit: "server", defaultEnabled: false });
    await createFeatureFlagRule({ flagKey: "preauth_mobile_v0", stage: "platform", decision: "allow", values: ["mobile"] });
    await markPreAuth("preauth_mobile_v0");
    // Marked, default off, with an identity rule that can never match before login.
    await createFeatureFlag({ key: "preauth_server_rule_v0", randomizationUnit: "server", defaultEnabled: false });
    await createFeatureFlagRule({ flagKey: "preauth_server_rule_v0", stage: "server", decision: "allow", values: [server.id] });
    await markPreAuth("preauth_server_rule_v0");

    const keys = [
      "preauth_default_on_v0",
      "preauth_unmarked_v0",
      "preauth_disabled_v0",
      "preauth_killed_v0",
      "preauth_mobile_v0",
      "preauth_server_rule_v0",
      "preauth_missing_v0",
    ].join(",");

    const mobile = await fetch(`${baseUrl}/api/public/feature-flags?keys=${keys}&platform=mobile`);
    assert.equal(mobile.status, 200, await mobile.clone().text());
    assert.equal(mobile.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(await mobile.json(), {
      flags: {
        preauth_default_on_v0: true,
        preauth_unmarked_v0: false,
        preauth_disabled_v0: false,
        preauth_killed_v0: false,
        preauth_mobile_v0: true,
        preauth_server_rule_v0: false,
        preauth_missing_v0: false,
      },
    });

    const web = await fetch(`${baseUrl}/api/public/feature-flags?keys=${keys}&platform=web`);
    assert.equal(web.status, 200);
    assert.equal(((await web.json()) as { flags: Record<string, boolean> }).flags.preauth_mobile_v0, false);

    const noPlatform = await fetch(`${baseUrl}/api/public/feature-flags?keys=preauth_mobile_v0,preauth_default_on_v0`);
    assert.equal(noPlatform.status, 200);
    assert.deepEqual(await noPlatform.json(), { flags: { preauth_mobile_v0: false, preauth_default_on_v0: true } });

    // Credentials are ignored: a member of the server whose rule allows the flag still gets the
    // before-login answer, so one URL has one cacheable answer.
    const withAuth = await fetch(`${baseUrl}/api/public/feature-flags?keys=${keys}&platform=mobile`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(withAuth.status, 200);
    assert.deepEqual(await withAuth.json(), await (await fetch(`${baseUrl}/api/public/feature-flags?keys=${keys}&platform=mobile`)).json());
  } finally {
    await close();
  }
});

test("public feature flags: rejects bad keys and platforms", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    for (const query of [
      "",
      "keys=",
      "keys=Bad_Key",
      `keys=${Array.from({ length: 51 }, (_, index) => `k${index}`).join(",")}`,
      "keys=ok_v0&platform=android",
    ]) {
      const response = await fetch(`${baseUrl}/api/public/feature-flags?${query}`);
      assert.equal(response.status, 400, query);
    }
  } finally {
    await close();
  }
});

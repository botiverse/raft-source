import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { oauthAccessTokens, users } from "../db/schema.js";
import { createOAuthClient } from "../services/oauthService.js";
import { createServer } from "../services/serverService.js";
import * as featureFlagService from "../services/featureFlagService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("authorized operator identity still gets 404 for every removed feature-flag operator route", async () => {
  const authorityEnv = "FEATURE_FLAG_OPERATOR_PRINCIPAL_IDS";
  const previousAuthority = process.env[authorityEnv];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const suffix = randomUUID();
    const [operator] = await getDb().insert(users).values({
      email: `removed-ff-operator-${suffix}@slock.test`,
      name: `removed-ff-operator-${suffix}`,
      passwordHash: "not-used",
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    process.env[authorityEnv] = operator.id;
    const server = await createServer("Removed Feature Flag Operator", `removed-ff-${suffix}`, operator.id);
    const { client } = await createOAuthClient({
      serverId: server.id,
      createdByUserId: operator.id,
      clientId: "slock-feature-flag-admin",
      name: "Feature Flag Admin",
      allowedScopes: ["openid", "profile"],
    });
    const token = `removed-ff-${randomUUID()}`;
    await getDb().insert(oauthAccessTokens).values({
      serverId: server.id,
      principalType: "human",
      userId: operator.id,
      clientId: client.id,
      tokenHash: hashSecret(token),
      scopes: ["openid", "profile"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const fixtureKey = `removed_operator_${suffix.replaceAll("-", "").slice(0, 12)}`;
    await featureFlagService.createFeatureFlag({
      key: fixtureKey,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "removed-operator-fixture",
    });
    const expectedConfigVersion = await featureFlagService.getFeatureFlagConfigVersion();
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      {
        path: `/api/oauth/operator/feature-flags/${fixtureKey}/evaluate-preview`,
        body: { serverId: server.id, userId: operator.id, platform: "web" },
      },
      {
        path: `/api/oauth/operator/feature-flags/${fixtureKey}/server-allowlist/rules`,
        body: {
          serverIds: [server.id],
          reason: "removed route fixture",
          expectedConfigVersion,
        },
      },
      {
        path: "/api/oauth/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules",
        body: { reason: "removed route fixture", expectedConfigVersion },
      },
    ];
    const statuses: Array<{ path: string; status: number }> = [];
    for (const probe of cases) {
      const response = await fetch(`${app.baseUrl}${probe.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(probe.body),
      });
      statuses.push({ path: probe.path, status: response.status });
    }
    assert.deepEqual(
      statuses,
      cases.map(({ path }) => ({ path, status: 404 })),
      "every feature-flag operator path must be route-absent; real flags make each B-side handler non-404",
    );
  } finally {
    if (previousAuthority === undefined) delete process.env[authorityEnv];
    else process.env[authorityEnv] = previousAuthority;
    await app.close();
  }
});

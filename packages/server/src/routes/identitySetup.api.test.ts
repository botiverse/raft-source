import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  newsletterAudienceContacts,
  onboardingEmailJourneys,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import {
  resetNewsletterTestOverrides,
  setNewsletterConfigForTest,
  setNewsletterContactClientForTest,
} from "../services/newsletterService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function register(baseUrl: string, suffix: string, name?: string) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `identity-${suffix}@slock.test`,
      password: "password123",
      ...(name ? { name } : {}),
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });
  const body = await response.json() as {
    user: {
      id: string;
      name: string;
      profileSetupCompletedAt: string | null;
      profileSetupSuggestedHandle: string | null;
      profileSetupProvider: "google" | "github" | "apple" | null;
    };
    accessToken: string;
  };
  return { response, body };
}

test("identity setup creates a pending account, gates business writes, and completes with CAS replay semantics", async () => {
  const syncedFirstNames: string[] = [];
  setNewsletterConfigForTest({ apiKey: "test-key", segmentId: "identity-segment" });
  setNewsletterContactClientForTest({
    syncContact: async (input) => {
      syncedFirstNames.push(input.firstName ?? "");
      return { id: "identity-contact" };
    },
  });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const { response, body } = await register(app.baseUrl, "pending-flow");
    assert.equal(response.status, 200);
    assert.match(body.user.name, /^pending_[0-9a-f]{20}$/);
    assert.equal(body.user.profileSetupCompletedAt, null);
    assert.equal(body.user.profileSetupSuggestedHandle, "identity-pending-flow");
    assert.equal(body.user.profileSetupProvider, null);

    const recovered = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${body.accessToken}` },
    });
    assert.equal(recovered.status, 200);
    assert.equal(
      (await recovered.json() as { profileSetupProvider: "google" | "github" | "apple" | null }).profileSetupProvider,
      null,
    );
    assert.equal(
      (await getDb().select().from(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.userId, body.user.id))).length,
      0,
      "pending registration must not start the name-dependent onboarding journey",
    );
    assert.equal((await getDb().select().from(newsletterAudienceContacts)).length, 0);
    assert.deepEqual(syncedFirstNames, []);

    await getDb().update(users).set({ emailVerified: true }).where(eq(users.id, body.user.id));
    const blocked = await fetch(`${app.baseUrl}/api/servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Blocked Server", slug: "blocked-server" }),
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), {
      error: "Profile setup required",
      code: "PROFILE_SETUP_REQUIRED",
    });
    assert.equal((await getDb().select().from(servers)).length, 0);
    assert.equal((await getDb().select().from(serverMembers)).length, 0);

    const reserved = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "pending_not_allowed", displayName: "Pending User" }),
    });
    assert.equal(reserved.status, 400);
    assert.equal((await reserved.json() as { code: string }).code, "PROFILE_SETUP_NAME_RESERVED");

    const completeBody = { name: "final-handle", displayName: "Final User" };
    const complete = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completeBody),
    });
    assert.equal(complete.status, 200);
    const completed = await complete.json() as { name: string; displayName: string; profileSetupCompletedAt: string | null };
    assert.equal(completed.name, completeBody.name);
    assert.equal(completed.displayName, completeBody.displayName);
    assert.ok(completed.profileSetupCompletedAt);
    assert.equal(
      (await getDb().select().from(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.userId, body.user.id))).length,
      1,
      "profile completion starts the idempotent onboarding journey after commit",
    );
    assert.equal((await getDb().select().from(newsletterAudienceContacts)).length, 1);
    assert.deepEqual(syncedFirstNames, ["Final User"]);

    const replay = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completeBody),
    });
    assert.equal(replay.status, 200);

    const changedReplay = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...completeBody, displayName: "Changed User" }),
    });
    assert.equal(changedReplay.status, 409);
    assert.equal(
      (await changedReplay.json() as { code: string }).code,
      "PROFILE_SETUP_ALREADY_COMPLETED",
    );

    const allowed = await fetch(`${app.baseUrl}/api/servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Allowed Server", slug: "allowed-server" }),
    });
    assert.equal(allowed.status, 200);

    const concurrentRegistration = await register(app.baseUrl, "concurrent-cas");
    assert.equal(concurrentRegistration.response.status, 200);
    const completeConcurrent = (displayName: string) => fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${concurrentRegistration.body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "concurrent-handle", displayName }),
    });
    const concurrentResponses = await Promise.all([
      completeConcurrent("Concurrent A"),
      completeConcurrent("Concurrent B"),
    ]);
    assert.deepEqual(
      concurrentResponses.map((item) => item.status).sort((a, b) => a - b),
      [200, 409],
      "CAS permits exactly one distinct profile payload",
    );
    assert.equal(
      (await concurrentResponses.find((item) => item.status === 409)!.json() as { code: string }).code,
      "PROFILE_SETUP_ALREADY_COMPLETED",
    );
  } finally {
    resetNewsletterTestOverrides();
    await app.close();
  }
});

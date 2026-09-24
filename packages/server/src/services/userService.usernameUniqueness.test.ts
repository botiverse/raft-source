import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";

import { createSocialUser } from "./userService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("concurrent social signups retain unique-name retry semantics", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const displayName = `Social Race ${suffix}`;
  const create = (label: string) => createSocialUser(
    {
      provider: "google",
      providerUserId: `social-race-${label}-${randomUUID()}`,
      email: `social-race-${label}-${randomUUID()}@slock.test`,
      emailVerified: true,
      displayName,
      avatarUrl: null,
    },
    {
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
  );

  const [first, second] = await Promise.all([create("a"), create("b")]);

  assert.notEqual(first.name, second.name);
  assert.match(first.name, /^social-race-/);
  assert.match(second.name, /^social-race-/);
});

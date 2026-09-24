import assert from "node:assert/strict";
import test from "node:test";
import { requiresAccountProfileSetup } from "../src/utils/accountProfileSetup";
import type { User } from "../src/store/authStore";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    gravatarHash: "hash",
    name: "user-name",
    displayName: "User Name",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

test("account profile setup gate is durable and only opens after verification", () => {
  // A new account carries the placeholder handle it was created with until it picks one.
  const fresh = { name: "pending_9f2c1a" };
  assert.equal(requiresAccountProfileSetup(null), false);
  assert.equal(requiresAccountProfileSetup(user({ ...fresh, emailVerified: false, profileSetupCompletedAt: null })), false);
  assert.equal(requiresAccountProfileSetup(user({ ...fresh, emailVerified: true, profileSetupCompletedAt: null })), true);
  assert.equal(requiresAccountProfileSetup(user({ profileSetupCompletedAt: "2026-07-11T01:00:00.000Z" })), false);
});

test("a NULL stamp on an account that already has a handle is a missed backfill, not a missing person", () => {
  // @Jianwei, 2026-07-13: forcing this person back through "Set up your account" would ask a
  // long-standing user to re-pick a username they cannot change — undismissable, and through
  // no fault of theirs. The stamp is the record; the handle is the fact.
  assert.equal(
    requiresAccountProfileSetup(user({ name: "wenyi", emailVerified: true, profileSetupCompletedAt: null })),
    false,
  );
});

test("missing field is treated as legacy-complete during additive rollout", () => {
  assert.equal(requiresAccountProfileSetup(user({ profileSetupCompletedAt: undefined })), false);
});

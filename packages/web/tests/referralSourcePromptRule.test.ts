import assert from "node:assert/strict";

import {
  REFERRAL_SOURCE_OTHER_MAX_LENGTH,
  REFERRAL_SOURCE_PROMPT_ACCOUNT_AGE_MS,
  REFERRAL_SOURCE_SKIP_FIELDS,
  referralSourceAnswerFields,
  shouldShowReferralSourcePrompt,
} from "../src/components/onboarding/referralSourcePromptRule";
import type { ReferralSourcePromptFacts } from "../src/components/onboarding/referralSourcePromptRule";

const NOW_MS = Date.parse("2026-11-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(NOW_MS - msAgo).toISOString();
}

// A member who joined someone else's server yesterday and was never asked.
function facts(overrides: Partial<ReferralSourcePromptFacts> = {}): ReferralSourcePromptFacts {
  return {
    flagEnabled: true,
    user: {
      id: "user-1",
      referralSource: null,
      referralSourceSkippedAt: null,
      profileSetupCompletedAt: iso(DAY_MS),
    },
    serverRole: "member",
    setupGate: "ready",
    sawOnboardingThisSession: false,
    displayStylePending: false,
    announcementPending: false,
    settingsPage: false,
    embedded: false,
    agentActivityPage: false,
    dismissedForUserId: null,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function withUser(overrides: Partial<NonNullable<ReferralSourcePromptFacts["user"]>>): ReferralSourcePromptFacts {
  return facts({ user: { ...facts().user!, ...overrides } });
}

test("a new, unasked account inside a server is asked, whatever its role there", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts()), true);
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "admin" })), true);
  // An owner whose setup is behind them (the gate reads ready) but who has no answer.
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "owner" })), true);
});

test("the flag off hides it", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts({ flagEnabled: false })), false);
});

test("nobody signed in, or no server on screen, hides it", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts({ user: null })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: null })), false);
});

test("an answer or a recorded skip on the user record hides it for good", () => {
  assert.equal(shouldShowReferralSourcePrompt(withUser({ referralSource: "search" })), false);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ referralSourceSkippedAt: iso(0) })), false);
});

test("only accounts at most 30 days old are asked", () => {
  assert.equal(REFERRAL_SOURCE_PROMPT_ACCOUNT_AGE_MS, 30 * DAY_MS);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: iso(30 * DAY_MS) })), true);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: iso(30 * DAY_MS + 1) })), false);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: iso(400 * DAY_MS) })), false);
  // No stamp, or one that cannot be read, is not evidence of a new account.
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: null })), false);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: undefined })), false);
  assert.equal(shouldShowReferralSourcePrompt(withUser({ profileSetupCompletedAt: "not a date" })), false);
});

test("it never shows while the owner setup flow is owed or still being read", () => {
  // blocked: a setup step, the owner survey or the handoff is on screen.
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "owner", setupGate: "blocked" })), false);
  // pending: the gate has not answered yet, so it might be about to show one.
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "owner", setupGate: "pending" })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ setupGate: "pending" })), false);
});

test("it stays hidden for the rest of the session on a server whose setup was on screen", () => {
  // The gate reads ready between a closed setup step and the server's answer
  // that the survey is owed; the session memory is what covers that window.
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "owner", setupGate: "ready", sawOnboardingThisSession: true })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "owner", setupGate: "blocked", sawOnboardingThisSession: true })), false);
});

test("one prompt at a time: it waits for the display style dialog and for an announcement", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts({ displayStylePending: true })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ announcementPending: true })), false);
});

test("it stays off guest pages, Settings, client WebViews and the embedded Activity page", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts({ serverRole: "guest" })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ settingsPage: true })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ embedded: true })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ agentActivityPage: true })), false);
});

test("not now hides it for the person who closed it, not for the next account on the tab", () => {
  assert.equal(shouldShowReferralSourcePrompt(facts({ dismissedForUserId: "user-1" })), false);
  assert.equal(shouldShowReferralSourcePrompt(facts({ dismissedForUserId: "user-2" })), true);
});

test("submit sends the source, and the free text only for Other", () => {
  assert.deepEqual(referralSourceAnswerFields("search", ""), { referralSource: "search" });
  // Text typed before switching away from Other is not sent: the server refuses nothing
  // here, but it would be noise in the request.
  assert.deepEqual(referralSourceAnswerFields("search", "a meetup"), { referralSource: "search" });
  assert.deepEqual(referralSourceAnswerFields("other", "  a meetup  "), {
    referralSource: "other",
    referralSourceOther: "a meetup",
  });
  assert.deepEqual(referralSourceAnswerFields("other", "   "), { referralSource: "other" });
  assert.equal(
    referralSourceAnswerFields("other", "x".repeat(REFERRAL_SOURCE_OTHER_MAX_LENGTH + 50)).referralSourceOther?.length,
    REFERRAL_SOURCE_OTHER_MAX_LENGTH,
  );
});

test("skip sends the skip field PATCH /api/auth/me already accepts, and no answer", () => {
  assert.deepEqual(REFERRAL_SOURCE_SKIP_FIELDS, { referralSourceSkipped: true });
});

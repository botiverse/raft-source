import assert from "node:assert/strict";
import test from "node:test";
import { accountNeedsIdentitySetup, hasPlaceholderHandle } from "./index.js";

/**
 * @Jianwei, 2026-07-13: migration 0170 stamps `profile_setup_completed_at` for everyone who
 * already has a handle. If that backfill misses a row, reading the NULL alone would force a
 * long-standing user back through "Set up your account" — asking them to pick a username they
 * chose years ago and cannot change afterwards. Undismissable, and through no fault of theirs.
 *
 * The stamp is the RECORD. The handle is the FACT. The absence of a record never outweighs
 * the presence of the thing the record was supposed to describe.
 */
test("a legacy account the backfill missed is not dragged back through signup", () => {
  assert.equal(
    accountNeedsIdentitySetup({ name: "wenyi", profileSetupCompletedAt: null }),
    false,
    "a real handle means identity setup happened, stamp or no stamp",
  );

  // A genuinely new account still owes it: placeholder handle, no stamp.
  assert.equal(accountNeedsIdentitySetup({ name: "pending_9f2c1a", profileSetupCompletedAt: null }), true);
  assert.equal(accountNeedsIdentitySetup({ name: "PENDING_9F2C1A", profileSetupCompletedAt: null }), true, "case-insensitive");
  assert.equal(accountNeedsIdentitySetup({ name: null, profileSetupCompletedAt: null }), true);

  // A stamp cannot vouch for a name that isn't there.
  //
  // This used to assert `false` — stamped means set up, whatever the handle says — which
  // contradicts the principle at the top of this file. Anything that stamped the date without
  // giving the person a handle produced a user who passed the gate still called
  // `pending_7ec59ca5…`, and the onboarding agent then greeted them by it. The gate exists to
  // ask "has this person got a name"; the row answers that directly, and the stamp was only
  // ever a proxy for the answer.
  assert.equal(
    accountNeedsIdentitySetup({ name: "pending_9f2c1a", profileSetupCompletedAt: "2026-07-01T00:00:00Z" }),
    true,
    "a placeholder handle still owes identity setup, stamp or no stamp",
  );

  // And the ordinary case: stamped, with a real handle. Nothing owed.
  assert.equal(accountNeedsIdentitySetup({ name: "wenyi", profileSetupCompletedAt: "2026-07-01T00:00:00Z" }), false);

  assert.equal(hasPlaceholderHandle("pending_abc"), true);
  assert.equal(hasPlaceholderHandle("wenyi"), false);
  assert.equal(hasPlaceholderHandle(null), false);
});

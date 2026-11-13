import assert from "node:assert/strict";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";

import { PREVIOUS_PRIVACY_VERSION, TermsChangedError, requireCurrentLegalAcceptance } from "./legalAcceptanceService";

// Tenny, 2026-10-21: the mobile apps send the previous privacy version as a
// fixed value, so the grace window runs to the end of 2026, not a week.
test("the previous privacy version is accepted, sharing off, through 2026-12-30 and refused from 2026-12-31", () => {
  const previous = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: PREVIOUS_PRIVACY_VERSION };

  assert.deepEqual(requireCurrentLegalAcceptance(previous, new Date("2026-12-30T23:59:59.000Z")), {
    termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
    privacyVersion: PREVIOUS_PRIVACY_VERSION,
    sawUsageDataNotice: false,
  });
  assert.throws(() => requireCurrentLegalAcceptance(previous, new Date("2026-12-31T00:00:00.000Z")), TermsChangedError);
});

import assert from "node:assert/strict";
import {
  THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS,
  THIRD_PARTY_EVENT_ID_PATTERN,
  isThirdPartyEventId,
  normalizeThirdPartyEventId,
} from "./thirdPartyEventId";

test("third-party event ids are UUIDs, matched case-insensitively and normalized to lowercase", () => {
  const lower = "0f3b6c2e-8d41-4a7b-9c55-1e2f3a4b5c6d";
  const upper = lower.toUpperCase();
  assert.equal(isThirdPartyEventId(lower), true);
  assert.equal(isThirdPartyEventId(upper), true);
  assert.equal(normalizeThirdPartyEventId(upper), lower);
  for (const bad of ["", "0f3b6c2e", "not-a-uuid", `${lower}x`, ` ${lower}`, 42, null, undefined]) {
    assert.equal(isThirdPartyEventId(bad), false, String(bad));
  }
  assert.equal(THIRD_PARTY_EVENT_ID_PATTERN.flags.includes("i"), true);
  assert.equal(THIRD_PARTY_EVENT_DELIVERED_REPORT_MAX_IDS, 200);
});

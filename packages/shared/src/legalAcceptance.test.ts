import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_LEGAL_ACCEPTANCE, PRIVACY_URL, TERMS_URL } from "./legalAcceptance.js";

test("current legal acceptance links use the Raft public domain", () => {
  assert.equal(TERMS_URL, "https://raft.build/terms");
  assert.equal(PRIVACY_URL, "https://raft.build/privacy");
  assert.equal(CURRENT_LEGAL_ACCEPTANCE.termsUrl, TERMS_URL);
  assert.equal(CURRENT_LEGAL_ACCEPTANCE.privacyUrl, PRIVACY_URL);
});

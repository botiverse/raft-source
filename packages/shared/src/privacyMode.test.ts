import assert from "node:assert/strict";
import { PRIVACY_MODE_ENV, PrivacyModeConfigError, parsePrivacyMode, privacyModeFromEnv } from "./privacyMode";

test("unset, empty and the off words are off", () => {
  for (const raw of [undefined, "", "  ", "0", "false", "off", "no", "OFF", " No "]) {
    assert.equal(parsePrivacyMode(raw), false, String(raw));
  }
});

test("the on words are on, in any case and with surrounding space", () => {
  for (const raw of ["1", "true", "on", "yes", "ON", " True "]) {
    assert.equal(parsePrivacyMode(raw), true, raw);
  }
});

test("anything else is a configuration error, never a guess", () => {
  for (const raw of ["2", "enabled", "y", "privacy"]) {
    assert.throws(() => parsePrivacyMode(raw), PrivacyModeConfigError, raw);
  }
});

test("privacyModeFromEnv reads RAFT_PRIVACY_MODE", () => {
  assert.equal(PRIVACY_MODE_ENV, "RAFT_PRIVACY_MODE");
  assert.equal(privacyModeFromEnv({}), false);
  assert.equal(privacyModeFromEnv({ RAFT_PRIVACY_MODE: "on" }), true);
  assert.throws(() => privacyModeFromEnv({ RAFT_PRIVACY_MODE: "maybe" }), /RAFT_PRIVACY_MODE/);
});

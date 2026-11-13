import assert from "node:assert/strict";
import { PrivacyModeConfigError } from "@botiverse/raft-shared";
import { clientLogoUrl, initPrivacyModeFromEnv, isPrivacyModeOn, setPrivacyModeForTest } from "./privacyMode";

afterEach(() => setPrivacyModeForTest(false));

test("startup read: unset is off, on is remembered", () => {
  assert.equal(initPrivacyModeFromEnv({}), false);
  assert.equal(isPrivacyModeOn(), false);
  assert.equal(initPrivacyModeFromEnv({ RAFT_PRIVACY_MODE: "on" }), true);
  assert.equal(isPrivacyModeOn(), true);
});

test("startup read: an invalid value throws (server.ts exits) and is not remembered as on", () => {
  assert.throws(() => initPrivacyModeFromEnv({ RAFT_PRIVACY_MODE: "sometimes" }), PrivacyModeConfigError);
  assert.equal(isPrivacyModeOn(), false);
});

test("clientLogoUrl: under privacy mode a Raft template logo is the web's own copy; anything else is unchanged", () => {
  const raft = "https://app.raft.build/app-logos/notion.svg";
  const other = "https://cdn.example.test/logo.png";
  assert.equal(clientLogoUrl(raft), raft, "off: unchanged");
  setPrivacyModeForTest(true);
  assert.equal(clientLogoUrl(raft), "/app-logos/notion.svg");
  assert.equal(clientLogoUrl(other), other);
  assert.equal(clientLogoUrl("/api/integration-logos/x"), "/api/integration-logos/x");
  assert.equal(clientLogoUrl(null), null);
  assert.equal(clientLogoUrl("https://app.raft.build/app-logos/a/../b.svg"), null, "never a path the web does not ship");
});

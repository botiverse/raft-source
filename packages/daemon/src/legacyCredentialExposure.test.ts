import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLegacyMachineKey, legacyCredentialExposureForReady, machineKeyFingerprint, recordLegacyCredentialExposure } from "./legacyCredentialExposure";

const KEY = "sk_machine_FIXTURE_not_a_real_key";
let home: string;
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), "credential-exposure-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("the fingerprint is the server's scheme and the file never holds the key", () => {
  assert.equal(machineKeyFingerprint(KEY), createHash("sha256").update(KEY).digest("hex").slice(0, 16));
  recordLegacyCredentialExposure(home, KEY, Date.parse("2026-11-03T11:00:00Z"));
  const text = readFileSync(path.join(home, "legacy-credential-exposure.json"), "utf8");
  assert.equal(text.includes(KEY), false);
  assert.deepEqual(legacyCredentialExposureForReady(home, KEY), { foundAt: "2026-11-03T11:00:00.000Z", keyFingerprint: machineKeyFingerprint(KEY) });
});

test("the first finding for a key is kept across restarts", () => {
  recordLegacyCredentialExposure(home, KEY, Date.parse("2026-11-03T11:00:00Z"));
  recordLegacyCredentialExposure(home, KEY, Date.parse("2026-11-04T11:00:00Z"));
  assert.equal(legacyCredentialExposureForReady(home, KEY)?.foundAt, "2026-11-03T11:00:00.000Z");
});

test("a finding about another key, or under a Computer key, is dropped and not reported", () => {
  recordLegacyCredentialExposure(home, KEY, 1);
  assert.equal(legacyCredentialExposureForReady(home, "sk_machine_rotated_key"), null);
  assert.equal(existsSync(path.join(home, "legacy-credential-exposure.json")), false);
  recordLegacyCredentialExposure(home, KEY, 1);
  assert.equal(legacyCredentialExposureForReady(home, "sk_computer_x"), null);
  assert.equal(isLegacyMachineKey("sk_computer_x"), false);
  assert.equal(isLegacyMachineKey(KEY), true);
});

test("nothing found, or a malformed file, reports nothing", () => {
  assert.equal(legacyCredentialExposureForReady(home, KEY), null);
  writeFileSync(path.join(home, "legacy-credential-exposure.json"), JSON.stringify({ foundAt: "x", keyFingerprint: "nothex" }));
  assert.equal(legacyCredentialExposureForReady(home, KEY), null);
});

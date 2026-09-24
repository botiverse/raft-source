import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

/**
 * Instruction-lockstep tooth (Cardy task #233; wording Maggie, canonical
 * sentence #proj-raft-app:2f567f36 msg fb52e87e): the Manual's serverinfo
 * tier contract must state BOTH fail-closed directions in BOTH locations.
 * Runtime projection is covered by the real `/oauth/serverinfo` API tests;
 * this file owns only the published instruction artifact.
 *
 * Granularity = per location × per direction (four independent facts):
 * deleting any one of the four must go RED. No literal full-sentence
 * equality — reasonable rewordings stay GREEN.
 */

const manual = readFileSync(new URL("../../../../manual/agent-knowledge/integration.md", import.meta.url), "utf8");

/** The two Manual locations carrying the contract (line ~21 bullet, line ~138 prose). */
const LOCATIONS = [
  /response id\/slug\/name\/avatar_url\/picture plus coarse paid-tier fields[^\n]*/,
  /current server's public profile[^\n]*/,
];

test("Manual states both fail-closed directions in both locations (2×2 independent facts)", () => {
  let found = 0;
  for (const pattern of LOCATIONS) {
    const match = manual.match(pattern);
    if (!match) continue;
    found += 1;
    const sentence = match[0];
    assert.match(sentence, /missing tier field means unknown/i, "location must name the state UNKNOWN");
    assert.match(sentence, /never default to `?paid`?/i, "location must include the entitlement direction (never default to paid)");
    assert.match(sentence, /never default to `?free`?/i, "location must include the display direction (never default to free)");
  }
  assert.equal(found, 2, "expected both Manual locations to carry the tier contract");
});

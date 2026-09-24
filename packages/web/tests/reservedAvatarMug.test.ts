import assert from "node:assert/strict";
import test from "node:test";

import {
  AVATAR_KEYS,
  RESERVED_AVATAR_KEYS,
  getAvatarData,
  parsePixelAvatar,
} from "../src/components/agent/PixelAvatar";

// Behavior coverage for the Cindy OA "mug" reserved avatar (replaces finch;
// final design squareBig+latte+wink, cindyz 2026-07-01, Duoyu DM). These
// assert runtime behavior only —
// the renderer resolves the sprite, and the reserved-key filter actually keeps
// it out of the pickable/random set. Per artin 铁律1 we do NOT scan source for
// the filter's shape (e.g. "must not regress to a bare Object.keys"); that's a
// lint/detector concern. The filter's behavior is what these tests pin.

test("mug sprite exists and renders by direct key lookup", () => {
  // Cindy OA agent's avatarUrl="pixel:mug" must resolve through the renderer
  // even though mug is reserved: getAvatarData looks up the AVATARS map
  // directly, not AVATAR_KEYS, so a reserved key stays usable by explicit ref.
  const mug = getAvatarData("mug");
  assert.ok(mug, "getAvatarData('mug') must return the sprite");
  assert.equal(mug?.bg, "#F8EEDF", "mug bg must be the soft-cream one-off");
  assert.equal(mug?.grid.length, 8, "mug grid must be 8 rows");
  for (const row of mug?.grid ?? []) {
    assert.equal(row.length, 8, "every mug row must be 8 cells");
  }
  assert.equal(parsePixelAvatar("pixel:mug"), "mug");
});

test("mug is reserved and excluded from the pickable/random AVATAR_KEYS", () => {
  // Reserved avatars must not be picked randomly (CreateAgentDialog) or
  // surfaced in the manual picker grid (AgentDetailPanel). Both call sites
  // iterate AVATAR_KEYS, so excluding mug from AVATAR_KEYS is the single-point
  // enforcement covering them both.
  assert.ok(RESERVED_AVATAR_KEYS.includes("mug"), "mug must be reserved");
  assert.ok(!AVATAR_KEYS.includes("mug"), "AVATAR_KEYS must NOT contain mug");

  // finch stays reserved too (mug replaces it, but a `pixel:finch` reference
  // must still render).
  assert.ok(!AVATAR_KEYS.includes("finch"), "finch stays excluded from AVATAR_KEYS");
  assert.ok(getAvatarData("finch"), "finch sprite still renders by key");

  // Sanity: a non-reserved avatar still survives the filter.
  assert.ok(AVATAR_KEYS.includes("robot"), "non-reserved keys still pass through");
});

test("the reserved-key filter holds both ways (no reserved leaks, no pickable is reserved)", () => {
  for (const reserved of RESERVED_AVATAR_KEYS) {
    assert.ok(
      !AVATAR_KEYS.includes(reserved),
      `reserved avatar '${reserved}' must be excluded from AVATAR_KEYS`,
    );
  }
  for (const key of AVATAR_KEYS) {
    assert.ok(
      !RESERVED_AVATAR_KEYS.includes(key),
      `pickable avatar '${key}' must not be reserved`,
    );
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  AVATAR_KEYS,
  RESERVED_AVATAR_KEYS,
  getAvatarData,
  parsePixelAvatar,
} from "../src/components/agent/PixelAvatar";

const repoRoot = resolve(import.meta.dirname, "..");

test("reserved Cindy sprites exist and render by direct key lookup", () => {
  // Cindy OA reserved avatarUrl values must still resolve through the
  // renderer even though they are reserved. getAvatarData looks up the
  // AVATARS map directly, not AVATAR_KEYS, so reserved keys remain usable
  // when referenced explicitly.
  const finch = getAvatarData("finch");
  assert.ok(finch, "getAvatarData('finch') must return the sprite");
  assert.equal(finch?.bg, "#D7F3FB", "finch bg must be the soft-sky one-off");
  assert.equal(finch?.grid.length, 8, "finch grid must be 8 rows");
  for (const row of finch?.grid ?? []) {
    assert.equal(row.length, 8, "every finch row must be 8 cells");
  }

  // mug's own sprite (bg/grid) is asserted in reservedAvatarMug.test.ts — keep it
  // there so the final latte spec has a single source of truth (no #FFF1E6 dup).

  // parsePixelAvatar returns the slug after `pixel:` (or null) — `"pixel:finch"` → `"finch"`.
  assert.equal(parsePixelAvatar("pixel:finch"), "finch");
});

test("reserved Cindy sprites are excluded from AVATAR_KEYS", () => {
  // Reserved avatars must not be picked randomly (CreateAgentDialog) or
  // surfaced in the manual picker grid (AgentDetailPanel). Both call sites
  // iterate AVATAR_KEYS, so filtering Cindy-only avatars out of AVATAR_KEYS is the
  // single-point enforcement that covers them both. Duoyu 2026-06-02 DM,
  // cindyz approved.
  for (const key of ["finch", "mug"]) {
    assert.ok(
      RESERVED_AVATAR_KEYS.includes(key),
      `${key} must be listed in RESERVED_AVATAR_KEYS`,
    );
    assert.ok(
      !AVATAR_KEYS.includes(key),
      `AVATAR_KEYS must NOT contain ${key} — random pick and picker grid both iterate it`,
    );
  }
  // Sanity: non-reserved avatars still survive the filter.
  assert.ok(AVATAR_KEYS.includes("robot"), "AVATAR_KEYS must still contain robot");
});

test("the reserved avatar asset matches the exported runtime reservation list", () => {
  const avatarJson = JSON.parse(
    readFileSync(resolve(repoRoot, "assets/avatars/pixelAvatars.json"), "utf8"),
  );
  assert.deepEqual(avatarJson.reservedKeys, ["finch", "mug"]);
  assert.deepEqual(RESERVED_AVATAR_KEYS, avatarJson.reservedKeys);
});

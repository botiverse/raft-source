import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  AVATAR_KEYS,
  DEFAULT_AVATAR_KEY,
  RESERVED_AVATAR_KEYS,
  getAvatarData,
} from "../src/components/agent/PixelAvatar";

// Drift guard for assets/avatars/pixelAvatars.json — the canonical pixel-avatar
// data consumed by PixelAvatar.tsx (task #352). A hand-edited sprite that goes
// out of shape (wrong row length, unknown palette letter, reserved key typo)
// would otherwise only surface as visually broken pixels at runtime.

const repoRoot = resolve(import.meta.dirname, "..");

interface PixelAvatarJson {
  version: number;
  comment: string;
  palette: Record<string, string>;
  avatars: Record<string, { bg: string; grid: string[] }>;
  reservedKeys: string[];
  defaultKey: string;
}

const data: PixelAvatarJson = JSON.parse(
  readFileSync(resolve(repoRoot, "assets/avatars/pixelAvatars.json"), "utf8"),
);

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

test("palette maps single letters to hex colors (plus the transparent hole)", () => {
  for (const [letter, value] of Object.entries(data.palette)) {
    assert.equal(letter.length, 1, `palette key '${letter}' must be a single character`);
    if (letter === "_") {
      assert.equal(value, "transparent", "'_' must map to transparent");
    } else {
      assert.match(value, HEX_COLOR, `palette['${letter}'] must be a #RRGGBB hex, got '${value}'`);
    }
  }
});

test("every avatar grid is 8 rows x 8 cols of known palette letters", () => {
  const avatarKeys = Object.keys(data.avatars);
  assert.ok(avatarKeys.length > 0, "avatars must not be empty");
  for (const [key, avatar] of Object.entries(data.avatars)) {
    assert.equal(avatar.grid.length, 8, `${key}: grid must have 8 rows`);
    for (const [y, row] of avatar.grid.entries()) {
      assert.equal(row.length, 8, `${key}: row ${y} must be 8 chars, got '${row}'`);
      for (const letter of row) {
        assert.ok(
          letter in data.palette,
          `${key}: row ${y} uses unknown palette letter '${letter}'`,
        );
      }
    }
    // bg is either a palette letter or a literal one-off hex (finch/mug).
    assert.ok(
      avatar.bg in data.palette || HEX_COLOR.test(avatar.bg),
      `${key}: bg '${avatar.bg}' must be a palette letter or #RRGGBB literal`,
    );
    if (avatar.bg in data.palette) {
      assert.notEqual(avatar.bg, "_", `${key}: bg must not be transparent`);
    }
  }
});

test("reservedKeys are a subset of avatar keys and defaultKey exists", () => {
  for (const reserved of data.reservedKeys) {
    assert.ok(
      reserved in data.avatars,
      `reserved key '${reserved}' must exist in avatars`,
    );
  }
  assert.ok(
    data.defaultKey in data.avatars,
    `defaultKey '${data.defaultKey}' must exist in avatars`,
  );
  assert.ok(
    !data.reservedKeys.includes(data.defaultKey),
    "defaultKey must not be reserved — it is the universal fallback",
  );
});

test("PixelAvatar module exports mirror the JSON exactly (order included)", () => {
  // The module expands the JSON at load time; these assertions pin that the
  // expansion neither drops, reorders, nor reshapes entries. Order matters:
  // AVATAR_KEYS drives the manual picker grid.
  assert.deepEqual(
    [...AVATAR_KEYS],
    Object.keys(data.avatars).filter((k) => !data.reservedKeys.includes(k)),
    "AVATAR_KEYS must be the JSON avatar keys, in JSON order, minus reservedKeys",
  );
  assert.deepEqual([...RESERVED_AVATAR_KEYS], data.reservedKeys);
  assert.equal(DEFAULT_AVATAR_KEY, data.defaultKey);

  for (const [key, avatar] of Object.entries(data.avatars)) {
    const expanded = getAvatarData(key);
    assert.ok(expanded, `getAvatarData('${key}') must resolve`);
    // bg letter resolves through the palette; literal hex passes through.
    const expectedBg = avatar.bg.startsWith("#") ? avatar.bg : data.palette[avatar.bg];
    assert.equal(expanded?.bg, expectedBg, `${key}: expanded bg mismatch`);
    assert.deepEqual(
      expanded?.grid.map((row) => row.join("")),
      avatar.grid,
      `${key}: expanded grid mismatch`,
    );
  }
});

import assert from "node:assert/strict";

import pixelAvatars from "@botiverse/raft-shared/assets/pixelAvatars.json" with { type: "json" };
import { DEFAULT_PIXEL_AVATAR_KEY, isPublicPixelAvatarUrl, renderPixelAvatarSvg } from "./pixelAvatarService";

// The server draws /api/avatars/pixel/:key.svg from the same JSON the web's
// PixelAvatar reads, so every avatar the picker offers (and the reserved ones)
// renders here with no server-side copy to keep in step.

const palette: Record<string, string> = pixelAvatars.palette;

test("every avatar in pixelAvatars.json renders server-side, cell for cell", () => {
  for (const [key, { bg, grid }] of Object.entries(pixelAvatars.avatars)) {
    const svg = renderPixelAvatarSvg(key);
    assert.ok(svg, `${key} must render`);
    const fill = bg.startsWith("#") ? bg : palette[bg];
    assert.ok(svg.includes(`<rect width="8" height="8" fill="${fill}"/>`), `${key}: background ${fill}`);
    const expected = grid.flatMap((row, y) => row.split("").flatMap((letter, x) =>
      letter === "_" ? [] : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[letter]}"/>`]));
    const drawn = Array.from(svg.matchAll(/<rect x="\d" y="\d" width="1" height="1" fill="[^"]+"\/>/g), (match) => match[0]);
    assert.deepEqual(drawn, expected, `${key}: cells`);
  }
});

test("the default avatar is the JSON's defaultKey", () => {
  assert.equal(DEFAULT_PIXEL_AVATAR_KEY, pixelAvatars.defaultKey);
  assert.equal(DEFAULT_PIXEL_AVATAR_KEY, "robot");
});

test("isPublicPixelAvatarUrl admits only pixel keys this server can draw", () => {
  for (const key of Object.keys(pixelAvatars.avatars)) {
    assert.equal(isPublicPixelAvatarUrl(`pixel:${key}`), true, `pixel:${key}`);
  }
  assert.equal(isPublicPixelAvatarUrl("pixel:random:seed-42"), true);
  assert.equal(isPublicPixelAvatarUrl(`pixel:random:${"x".repeat(249)}`), true, "a 256-char key is the limit");
  for (const value of [
    null,
    undefined,
    "",
    "pixel:",
    "pixel:not-a-real-key",
    `pixel:random:${"x".repeat(250)}`,
    "pixel:random:seed\u0007bad",
    "pixel:random:seed\nbad",
    "robot",
    "/api/avatars/users/aaaa.webp",
    "https://example.test/pixel:robot.png",
  ]) {
    assert.equal(isPublicPixelAvatarUrl(value), false, JSON.stringify(value));
  }
});

test("a person's built avatar: the shared SVG, its own key, and shown wherever a stored upload is", async () => {
  const { encodePixelAvatarKey, decodePixelAvatarKey } = await import("./pixelAvatarService");
  const { isShownUserAvatarUrl, isStoredUserAvatarUrl } = await import("./avatarService");
  const { HUMAN_AVATAR_ART } = await import("@botiverse/raft-shared/src/humanAvatarArt");
  const { readHumanAvatarRecipe, renderHumanAvatarSvg } = await import("@botiverse/raft-shared/src/humanAvatar");
  const value = "pixel-human:v1:lilac.5.long.grey.oh.beanie.glasses";

  assert.equal(renderPixelAvatarSvg(value), renderHumanAvatarSvg(readHumanAvatarRecipe(value)!, HUMAN_AVATAR_ART));
  assert.equal(decodePixelAvatarKey(encodePixelAvatarKey(value)!), value);
  // Not an agent sprite: the agent rule for anonymous pages doesn't admit it.
  assert.equal(isPublicPixelAvatarUrl(value), false);
  // An agent's `pixel:` key never draws a person, on a page or as an image URL.
  assert.equal(isPublicPixelAvatarUrl(`pixel:${value}`), false);
  assert.equal(encodePixelAvatarKey(`pixel:${value}`), null);
  // Its image URL carries the art revision, so new art isn't hidden by the immutable cache.
  const { humanAvatarSvgPath } = await import("./pixelAvatarService");
  const { HUMAN_AVATAR_ART_REVISION } = await import("@botiverse/raft-shared/src/humanAvatarArt");
  const path = new URL(humanAvatarSvgPath(value)!, "https://raft.test");
  assert.equal(path.pathname, `/api/avatars/pixel/${encodePixelAvatarKey(value)}.svg`);
  assert.equal(path.searchParams.get("art"), HUMAN_AVATAR_ART_REVISION);
  assert.equal(humanAvatarSvgPath("pixel:robot"), null);

  assert.equal(isShownUserAvatarUrl(value), true);
  assert.equal(isStoredUserAvatarUrl(value), false, "nothing in storage to delete or replace");
  assert.equal(isShownUserAvatarUrl("/api/avatars/users/0123456789abcdef0123456789abcdef.webp"), true);
  for (const hidden of [null, "", "https://lh3.googleusercontent.com/a/x=s96-c", "pixel:robot", "pixel-human:v1:<script>", `pixel-human:v1:${"a".repeat(200)}`]) {
    assert.equal(isShownUserAvatarUrl(hidden), false, String(hidden));
  }
});

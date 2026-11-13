import { Buffer } from "node:buffer";

import pixelAvatars from "@botiverse/raft-shared/assets/pixelAvatars.json" with { type: "json" };
import { generatePixelAvatar } from "@botiverse/raft-shared/src/pixelAvatarGenerator";
import { isHumanAvatarUrl, readHumanAvatarRecipe, renderHumanAvatarSvg } from "@botiverse/raft-shared/src/humanAvatar";
import { HUMAN_AVATAR_ART, HUMAN_AVATAR_ART_REVISION } from "@botiverse/raft-shared/src/humanAvatarArt";

// Palette and sprites come from the same JSON the web's PixelAvatar.tsx reads
// (packages/shared/assets/pixelAvatars.json), so a new avatar needs no server
// edit. The seeded-random generator is the web's too
// (packages/shared/src/pixelAvatarGenerator.ts; oauth.api.test.ts pins it to
// the web PRNG fixture).
const C = pixelAvatars.palette;

type PaletteKey = keyof typeof C;

type PixelAvatarData = { grid: PaletteKey[][]; bg: string };

// A bg letter resolves through the palette; a literal `#hex` bg (the reserved
// finch/mug one-offs) passes through as-is.
const AVATARS: Record<string, PixelAvatarData> = Object.fromEntries(
  Object.entries(pixelAvatars.avatars).map(([key, { bg, grid }]) => [
    key,
    {
      bg: bg.startsWith("#") ? bg : C[bg as PaletteKey],
      grid: grid.map((row) => row.split("") as PaletteKey[]),
    },
  ]),
);

/** Drawn for a key this server doesn't know: pixelAvatars.json `defaultKey`. */
export const DEFAULT_PIXEL_AVATAR_KEY = pixelAvatars.defaultKey;

/**
 * The key of /api/avatars/pixel/<key>.svg for an avatarUrl drawn by clients
 * (an agent's `pixel:<key>`, a person's built `pixel-human:v1:...`), for
 * surfaces that need an image URL; null for anything else (an uploaded image).
 * A built avatar's key is its whole value, so the route tells the two apart.
 */
export function encodePixelAvatarKey(avatarUrl: string): string | null {
  if (isHumanAvatarUrl(avatarUrl)) return Buffer.from(avatarUrl, "utf8").toString("base64url");
  if (!avatarUrl.startsWith("pixel:")) return null;
  const key = avatarUrl.slice("pixel:".length);
  // An agent's `pixel:` key never draws as a person.
  if (!isValidPixelAvatarKey(key) || isHumanAvatarUrl(key)) return null;
  return Buffer.from(key, "utf8").toString("base64url");
}

/**
 * The image URL path of a person's built avatar: the pixel SVG route, with the
 * art revision in the query. The SVG is cached immutable, so a change to the
 * art reaches caches as a new URL; the route itself ignores the query. Null
 * for anything that isn't a built avatar.
 */
export function humanAvatarSvgPath(avatarUrl: string): string | null {
  if (!isHumanAvatarUrl(avatarUrl)) return null;
  return `/api/avatars/pixel/${encodePixelAvatarKey(avatarUrl)}.svg?art=${encodeURIComponent(HUMAN_AVATAR_ART_REVISION)}`;
}

export function decodePixelAvatarKey(encodedKey: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(encodedKey)) return null;
  try {
    const key = Buffer.from(encodedKey, "base64url").toString("utf8");
    return isValidPixelAvatarKey(key) ? key : null;
  } catch {
    return null;
  }
}

function isValidPixelAvatarKey(key: string): boolean {
  if (!key || key.length > 256) return false;
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  return true;
}

/** True when avatarUrl is a client-rendered pixel avatar identifier, not an
 *  image URL: `pixel:<key>` naming a sprite in pixelAvatars.json, or
 *  `pixel:random:<seed>` (seed passes isValidPixelAvatarKey: at most 256
 *  chars, no control characters). It references no URL and carries no
 *  personal data, so the anonymous public projection may show it. Anything
 *  renderPixelAvatarSvg cannot draw (an unknown key) is false. */
export function isPublicPixelAvatarUrl(avatarUrl: string | null | undefined): boolean {
  if (!avatarUrl?.startsWith("pixel:")) return false;
  const key = avatarUrl.slice("pixel:".length);
  return isValidPixelAvatarKey(key) && !isHumanAvatarUrl(key) && renderPixelAvatarSvg(key) !== null;
}

export function renderPixelAvatarSvg(key: string): string | null {
  // A person's built avatar (the whole `pixel-human:...` value): drawn by the
  // shared renderer the web uses. An option this build doesn't know draws
  // that field's default (readHumanAvatarRecipe), never nothing.
  const human = readHumanAvatarRecipe(key);
  if (human) return renderHumanAvatarSvg(human, HUMAN_AVATAR_ART);
  const data = key.startsWith("random:")
    ? generatePixelAvatar(key.slice("random:".length))
    : AVATARS[key] ?? null;
  if (!data) return null;

  const rects = data.grid.flatMap((row, y) => row.map((colorKey, x) => {
    if (colorKey === "_") return "";
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${C[colorKey]}"/>`;
  })).join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">`,
    `<rect width="8" height="8" fill="${data.bg}"/>`,
    rects,
    `</svg>`,
  ].join("");
}

import pixelAvatars from "../assets/pixelAvatars.json" with { type: "json" };

// The seeded-random pixel avatar ("pixel:random:<seed>"), drawn by the web's
// PixelAvatar.tsx and the Server's pixelAvatarService (the OAuth picture SVG).
// One copy, so the same seed draws the same avatar everywhere.
const C = pixelAvatars.palette;

export type PixelAvatarPaletteKey = keyof typeof C;

export interface GeneratedPixelAvatar {
  grid: PixelAvatarPaletteKey[][];
  bg: string;
}

/** Simple seeded PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a 32-bit integer */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Pre-defined harmonious color schemes: [background, foreground].
 * Each scheme pairs a light bg with a contrasting fg for clean identicon look.
 */
const COLOR_SCHEMES: [string, PixelAvatarPaletteKey][] = [
  [C.C, "K"],   // cyan bg, black fg
  [C.Y, "K"],   // yellow bg, black fg
  [C.L, "K"],   // lime bg, black fg
  [C.P, "W"],   // pink bg, white fg
  [C.V, "K"],   // lavender bg, black fg
  ["#1E1E1C", "C"],  // dark bg, cyan fg
  ["#1E1E1C", "G"],  // dark bg, green fg
  ["#1E1E1C", "P"],  // dark bg, pink fg
  ["#1E1E1C", "Y"],  // dark bg, yellow fg
  ["#1E1E1C", "V"],  // dark bg, lavender fg
  [C.O, "K"],   // orange bg, black fg
  [C.C, "W"],   // cyan bg, white fg
];

/**
 * Generate a deterministic 8×8 identicon-style pixel avatar from a seed string.
 * Uses a 5×8 grid (center column + left half mirrored to right) for vertical symmetry,
 * with a single foreground color on a harmonious background — similar to GitHub identicons.
 */
export function generatePixelAvatar(seed: string): GeneratedPixelAvatar {
  const rng = mulberry32(hashString(seed));
  const scheme = COLOR_SCHEMES[Math.floor(rng() * COLOR_SCHEMES.length)];
  const bg = scheme[0];
  const fg = scheme[1];

  // Generate a 4×8 half-grid (left side), then mirror horizontally.
  // ~45% fill rate gives recognizable shapes without being too dense or sparse.
  const grid: PixelAvatarPaletteKey[][] = [];
  for (let y = 0; y < 8; y++) {
    const left: PixelAvatarPaletteKey[] = [];
    for (let x = 0; x < 4; x++) {
      left.push(rng() < 0.45 ? fg : "_");
    }
    // Mirror: columns 0-3 then 3-0 (8 wide, center columns 3,4 share same value)
    grid.push([left[0], left[1], left[2], left[3], left[3], left[2], left[1], left[0]]);
  }

  return { grid, bg };
}

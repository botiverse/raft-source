import { Buffer } from "node:buffer";

const C = {
  _: "transparent",
  K: "#141111",
  W: "#FFFFFF",
  P: "#FE7DA8",
  O: "#F8A16F",
  Y: "#FFD440",
  L: "#A9D877",
  C: "#27CCF3",
  V: "#BBAFE6",
  B: "#576574",
  R: "#F97264",
  G: "#9DCAAA",
  D: "#B07A4E",    // latte-brown — avatar-specific (Cindy mug body only; not a design token)
};

type PaletteKey = keyof typeof C;

type PixelAvatarData = { grid: PaletteKey[][]; bg: string };

const AVATARS: Record<string, PixelAvatarData> = {
  robot: {
    bg: C.C,
    grid: [
      ["_","K","K","K","K","K","K","_"],
      ["K","C","K","W","W","K","C","K"],
      ["K","W","K","W","W","K","W","K"],
      ["K","K","K","K","K","K","K","K"],
      ["_","K","W","K","K","W","K","_"],
      ["_","K","K","K","K","K","K","_"],
      ["_","K","K","_","_","K","K","_"],
      ["_","K","K","_","_","K","K","_"],
    ],
  },
  cat: {
    bg: C.Y,
    grid: [
      ["K","_","_","_","_","_","_","K"],
      ["K","K","_","_","_","_","K","K"],
      ["K","Y","K","Y","Y","K","Y","K"],
      ["K","Y","Y","Y","Y","Y","Y","K"],
      ["K","Y","K","Y","Y","K","Y","K"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["_","_","K","Y","Y","K","_","_"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  ghost: {
    bg: C.V,
    grid: [
      ["_","_","K","K","K","K","_","_"],
      ["_","K","W","W","W","W","K","_"],
      ["K","W","K","W","W","K","W","K"],
      ["K","W","W","W","W","W","W","K"],
      ["K","W","W","W","W","W","W","K"],
      ["K","W","W","K","K","W","W","K"],
      ["K","W","K","W","W","K","W","K"],
      ["K","_","K","_","_","K","_","K"],
    ],
  },
  skull: {
    bg: C.O,
    grid: [
      ["_","K","K","K","K","K","K","_"],
      ["K","W","W","W","W","W","W","K"],
      ["K","W","K","W","W","K","W","K"],
      ["K","W","W","W","W","W","W","K"],
      ["_","K","W","W","W","W","K","_"],
      ["_","K","W","K","W","K","K","_"],
      ["_","_","K","K","K","K","_","_"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  alien: {
    bg: C.L,
    grid: [
      ["_","K","K","K","K","K","K","_"],
      ["K","G","G","G","G","G","G","K"],
      ["K","G","K","K","K","K","G","K"],
      ["K","G","G","G","G","G","G","K"],
      ["_","K","G","G","G","G","K","_"],
      ["_","_","K","G","G","K","_","_"],
      ["_","_","K","G","G","K","_","_"],
      ["_","K","K","_","_","K","K","_"],
    ],
  },
  heart: {
    bg: C.P,
    grid: [
      ["_","_","_","_","_","_","_","_"],
      ["_","K","K","_","_","K","K","_"],
      ["K","R","R","K","K","R","R","K"],
      ["K","R","R","R","R","R","R","K"],
      ["K","R","R","R","R","R","R","K"],
      ["_","K","R","R","R","R","K","_"],
      ["_","_","K","R","R","K","_","_"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  star: {
    bg: C.Y,
    grid: [
      ["_","_","_","K","K","_","_","_"],
      ["_","_","_","K","K","_","_","_"],
      ["K","K","K","K","K","K","K","K"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["_","_","K","Y","Y","K","_","_"],
      ["_","K","Y","K","K","Y","K","_"],
      ["K","Y","K","_","_","K","Y","K"],
      ["K","K","_","_","_","_","K","K"],
    ],
  },
  flame: {
    bg: C.O,
    grid: [
      ["_","_","_","K","_","_","_","_"],
      ["_","_","K","R","K","_","_","_"],
      ["_","_","K","R","K","K","_","_"],
      ["_","K","O","R","R","R","K","_"],
      ["_","K","O","O","R","R","K","_"],
      ["K","Y","O","O","O","R","K","_"],
      ["K","Y","Y","O","O","K","_","_"],
      ["_","K","K","K","K","_","_","_"],
    ],
  },
  diamond: {
    bg: C.C,
    grid: [
      ["_","_","_","K","K","_","_","_"],
      ["_","_","K","C","C","K","_","_"],
      ["_","K","C","W","C","C","K","_"],
      ["K","C","W","C","C","C","C","K"],
      ["K","C","C","C","C","C","C","K"],
      ["_","K","C","C","C","C","K","_"],
      ["_","_","K","C","C","K","_","_"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  mushroom: {
    bg: C.P,
    grid: [
      ["_","_","K","K","K","K","_","_"],
      ["_","K","R","W","W","R","K","_"],
      ["K","R","R","W","W","R","R","K"],
      ["K","R","R","R","R","R","R","K"],
      ["_","K","K","K","K","K","K","_"],
      ["_","_","K","W","W","K","_","_"],
      ["_","_","K","W","W","K","_","_"],
      ["_","K","K","K","K","K","K","_"],
    ],
  },
  eye: {
    bg: C.V,
    grid: [
      ["_","_","_","_","_","_","_","_"],
      ["_","_","K","K","K","K","_","_"],
      ["_","K","W","W","W","W","K","_"],
      ["K","W","W","K","K","W","W","K"],
      ["K","W","W","K","K","W","W","K"],
      ["_","K","W","W","W","W","K","_"],
      ["_","_","K","K","K","K","_","_"],
      ["_","_","_","_","_","_","_","_"],
    ],
  },
  crown: {
    bg: C.Y,
    grid: [
      ["_","_","_","_","_","_","_","_"],
      ["_","K","_","K","K","_","K","_"],
      ["_","K","K","K","K","K","K","_"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["K","K","K","K","K","K","K","K"],
      ["K","Y","Y","Y","Y","Y","Y","K"],
      ["K","K","K","K","K","K","K","K"],
    ],
  },
  // Sprites 13-16 — added 2026-04-28 (Duoyu v2 set, stdrc-picked).
  // Bg coverage adds R/B/L which the original 12 didn't use. See
  // slock-design/tokens/avatar-palette.json v1.2.0.
  cloud: {
    bg: C.C,
    grid: [
      ["_","_","_","_","_","_","_","_"],
      ["_","_","K","K","_","_","_","_"],
      ["_","K","W","W","K","K","_","_"],
      ["K","W","W","W","W","W","K","_"],
      ["K","W","W","W","W","W","W","K"],
      ["K","W","W","W","W","W","W","K"],
      ["_","K","K","K","K","K","K","_"],
      ["_","_","_","_","_","_","_","_"],
    ],
  },
  sun: {
    bg: C.R,
    grid: [
      ["_","K","_","K","K","_","K","_"],
      ["K","_","K","Y","Y","K","_","K"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["K","Y","Y","Y","Y","Y","Y","K"],
      ["K","Y","Y","Y","Y","Y","Y","K"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["K","_","K","Y","Y","K","_","K"],
      ["_","K","_","K","K","_","K","_"],
    ],
  },
  bell: {
    bg: C.B,
    grid: [
      ["_","_","_","K","K","_","_","_"],
      ["_","_","K","Y","Y","K","_","_"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["_","K","Y","Y","Y","Y","K","_"],
      ["K","Y","Y","Y","Y","Y","Y","K"],
      ["K","K","K","K","K","K","K","K"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  tree: {
    bg: C.L,
    grid: [
      ["_","_","_","K","K","_","_","_"],
      ["_","_","K","G","G","K","_","_"],
      ["_","K","G","G","G","G","K","_"],
      ["K","G","G","G","G","G","G","K"],
      ["K","G","G","G","G","G","G","K"],
      ["_","K","K","G","G","K","K","_"],
      ["_","_","K","O","O","K","_","_"],
      ["_","_","_","K","K","_","_","_"],
    ],
  },
  // Reserved avatar for the Cindy OA agent. One-off bg `#D7F3FB` (soft-sky
  // tint of cyan) intentionally NOT promoted into the `C` palette — this is
  // the only "soft-sky" surface in the avatar system, so token-izing it
  // would needlessly drag slock-landing/PixelAvatar.tsx + design-token JSON.
  // Promote later if a second surface needs the same hue. Excluded from
  // AVATAR_KEYS via RESERVED_AVATAR_KEYS so it cannot be picked randomly
  // (CreateAgentDialog) or selected in the manual picker grid
  // (AgentDetailPanel) — Duoyu 2026-06-02 DM, cindyz approved.
  finch: {
    bg: "#D7F3FB",
    grid: [
      ["_","_","K","K","K","K","_","_"],
      ["_","K","C","C","C","C","K","_"],
      ["K","C","W","C","C","W","C","K"],
      ["K","C","K","C","C","K","C","K"],
      ["K","C","C","O","O","C","C","K"],
      ["_","K","C","C","C","C","K","_"],
      ["_","K","C","K","K","C","K","_"],
      ["_","_","K","_","_","K","_","_"],
    ],
  },
  // Cindy OA mug — FINAL latte version (cindyz 2026-07-01), mirrors the client
  // AVATARS.mug in web/PixelAvatar.tsx. Supersedes the earlier orange mugWink
  // (#3616). Byte baseline: cindy-mug-FINAL/mug-spec.json.
  mug: {
    bg: "#F8EEDF",
    grid: [
      ["_","_","_","K","K","_","_","_"],
      ["_","_","K","_","_","K","_","_"],
      ["K","K","K","K","K","K","_","_"],
      ["K","D","D","D","D","K","K","K"],
      ["K","W","D","D","K","K","_","K"],
      ["K","D","D","D","D","K","K","K"],
      ["K","D","K","K","D","K","_","_"],
      ["_","K","K","K","K","K","_","_"],
    ],
  },
};

const COLOR_SCHEMES: [string, PaletteKey][] = [
  [C.C, "K"],
  [C.Y, "K"],
  [C.L, "K"],
  [C.P, "W"],
  [C.V, "K"],
  ["#1E1E1C", "C"],
  ["#1E1E1C", "G"],
  ["#1E1E1C", "P"],
  ["#1E1E1C", "Y"],
  ["#1E1E1C", "V"],
  [C.O, "K"],
  [C.C, "W"],
];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function generateAvatar(seed: string): PixelAvatarData {
  const rng = mulberry32(hashString(seed));
  const scheme = COLOR_SCHEMES[Math.floor(rng() * COLOR_SCHEMES.length)];
  const bg = scheme[0];
  const fg = scheme[1];

  const grid: PaletteKey[][] = [];
  for (let y = 0; y < 8; y++) {
    const left: PaletteKey[] = [];
    for (let x = 0; x < 4; x++) {
      left.push(rng() < 0.45 ? fg : "_");
    }
    grid.push([left[0], left[1], left[2], left[3], left[3], left[2], left[1], left[0]]);
  }

  return { grid, bg };
}

export function encodePixelAvatarKey(avatarUrl: string): string | null {
  if (!avatarUrl.startsWith("pixel:")) return null;
  const key = avatarUrl.slice("pixel:".length);
  if (!isValidPixelAvatarKey(key)) return null;
  return Buffer.from(key, "utf8").toString("base64url");
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

export function renderPixelAvatarSvg(key: string): string | null {
  const data = key.startsWith("random:")
    ? generateAvatar(key.slice("random:".length))
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

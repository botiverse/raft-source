import { memo, useContext, useMemo, useState } from "react";
import type { Context } from "react";
import { IntlContext } from "react-intl";

import pixelAvatars from "@botiverse/raft-shared/assets/pixelAvatars.json" with { type: "json" };
import { generatePixelAvatar } from "@botiverse/raft-shared/src/pixelAvatarGenerator";
import { enFallback } from "../../i18n/messages/enFallback";
import ottieUrl from "../../assistant/otter/wave.webp";

/**
 * Pixel art avatar system for agents.
 * Each avatar is an 8×8 sprite rendered as ONE <img> whose src is a cached
 * SVG data URL (task #137). It used to be a CSS grid of 64 <div>s per avatar:
 * a busy channel carried 134 avatars = 8,710 of its 14,827 DOM nodes (59%),
 * inflating every style/layout pass over the timeline and sidebar.
 * Stored as avatarUrl = "pixel:key" (predefined) or "pixel:random:seed" (generated).
 *
 * Canonical palette + sprite data live in packages/shared/assets/pixelAvatars.json
 * (grid rows as compact 8-char palette-letter strings), which the server's
 * pixelAvatarService reads too; this module expands them into render-time
 * shapes. The seeded-random generator stays in
 * code (packages/shared/src/pixelAvatarGenerator.ts, shared with the server's
 * pixelAvatarService) — only the hand-drawn sprites are data. Drift guard:
 * tests/pixelAvatarJson.test.ts.
 */

// Color palette — soft pastel. Letter → hex values live in pixelAvatars.json.
// Aligned with design-system tokens in `slock-design/tokens/colors.json`
// v1.2.0 (2026-05-03): O/C/L/R match the OKLCH-aligned named palette
// (soft-orange / soft-cyan / soft-lime / soft-coral). G + B stay
// avatar-specific because the role palette has no green / blue-gray; D is the
// mug-only latte brown (NOT a design token, do not promote / do not sync to
// token JSON). Keep in sync with `slock-landing/src/components/PixelAvatar.tsx`.
const C = pixelAvatars.palette;

type PaletteKey = keyof typeof C;
type OptionalAvatarIntl = {
  formatMessage: (descriptor: { id: "agent.avatar.alt" }) => string;
};

// 8×8 pixel art definitions, expanded from the JSON's compact row strings
// ("_KKKKKK_" → PaletteKey[]). A bg letter resolves through the palette; a
// literal `#hex` bg (the reserved finch/mug/ottie one-offs — soft-sky #D7F3FB,
// soft-cream #F8EEDF and pale-water #DDEFF2, intentionally NOT promoted into `C`) passes through
// as-is. Entry order follows the JSON (series order, reserved last).
const AVATARS: Record<string, { grid: PaletteKey[][]; bg: string }> = Object.fromEntries(
  Object.entries(pixelAvatars.avatars).map(([key, { bg, grid }]) => [
    key,
    {
      bg: bg.startsWith("#") ? bg : C[bg as PaletteKey],
      grid: grid.map((row) => row.split("") as PaletteKey[]),
    },
  ]),
);

// Avatar keys reserved for specific agents — must not be picked at random
// (CreateAgentDialog) or surfaced in the manual picker
// (AgentProfileEditDialog). `finch` and `mug` belong to the Cindy OA agent only
// (Duoyu 2026-06-02 DM, cindyz approved; mug FINAL locked by cindyz
// 2026-07-01, supersedes the earlier orange mugWink shipped in #3616).
// `ottie` is every personal assistant's avatar, set only by the server; the
// web draws the otter art for it (AgentAvatar), the sprite is the fallback.
export const RESERVED_AVATAR_KEYS: readonly string[] = pixelAvatars.reservedKeys;

export const AVATAR_KEYS = Object.keys(AVATARS).filter(
  (k) => !RESERVED_AVATAR_KEYS.includes(k),
);

/** The picker's themed sets of exactly 8 avatars, in picker order. Every
 *  key in AVATAR_KEYS is in exactly one series; reserved keys are in none. */
export const AVATAR_SERIES: readonly { key: string; avatars: readonly string[] }[] = pixelAvatars.series;

/** Default avatar key used when agent has no avatar set */
export const DEFAULT_AVATAR_KEY = pixelAvatars.defaultKey;

export function getAvatarData(key: string) {
  return AVATARS[key] || null;
}

// --- Seeded random pixel avatar generator (packages/shared/src/pixelAvatarGenerator.ts) ---

/** Cache for generated avatars to avoid recalculating */
const generatedCache = new Map<string, { grid: PaletteKey[][]; bg: string }>();

/** The shared seeded generator, memoized per seed. */
function generateAvatar(seed: string): { grid: PaletteKey[][]; bg: string } {
  const cached = generatedCache.get(seed);
  if (cached) return cached;

  const result = generatePixelAvatar(seed);
  generatedCache.set(seed, result);
  return result;
}

/** Sprite data for a key: a predefined sprite, or "random:<seed>" generated.
 *  A key this build doesn't know (e.g. an avatar added after it shipped)
 *  draws the default avatar rather than nothing. */
export function getPixelAvatarData(avatarKey: string): { grid: PaletteKey[][]; bg: string } {
  if (avatarKey.startsWith("random:")) return generateAvatar(avatarKey.slice(7));
  return AVATARS[avatarKey] ?? AVATARS[DEFAULT_AVATAR_KEY];
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const dataUrlCache = new Map<string, string | null>();

/**
 * The avatar as one SVG data URL (8×8 viewBox, crisp edges). Single source for
 * the live avatar and for share/screenshot capture. Cached per key: sprites are
 * immutable and palette colors are fixed (not theme tokens).
 */
export function pixelAvatarDataUrl(avatarKey: string): string | null {
  const cached = dataUrlCache.get(avatarKey);
  if (cached !== undefined) return cached;
  const data = getPixelAvatarData(avatarKey);
  let url: string | null = null;
  if (data) {
    const cells = data.grid.flatMap((row, y) => row.flatMap((colorKey, x) =>
      colorKey === "_" ? [] : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${C[colorKey]}"/>`]));
    url = svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${data.bg}"/>${cells.join("")}</svg>`);
  }
  dataUrlCache.set(avatarKey, url);
  return url;
}

/** Parse "pixel:key" or "pixel:random:seed" format from avatarUrl */
export function parsePixelAvatar(avatarUrl: string | null): string | null {
  if (!avatarUrl?.startsWith("pixel:")) return null;
  return avatarUrl.slice(6);
}

/** Get the effective pixel avatar key for an agent (falls back to default) */
function getEffectiveAvatarKey(avatarUrl: string | null): string {
  return parsePixelAvatar(avatarUrl) || DEFAULT_AVATAR_KEY;
}

/** Render a pixel art avatar. It fills its frame (the avatar sticker sizes
 *  it), so the pixels sit flush to the border at any DPR. */
const PixelAvatar = memo(function PixelAvatar({
  avatarKey,
  className = "",
}: {
  avatarKey: string;
  className?: string;
}) {
  const src = useMemo(() => pixelAvatarDataUrl(avatarKey), [avatarKey]);
  if (!src) return null;

  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={`size-full shrink-0 ${className}`.trim()}
      style={{ imageRendering: "pixelated" }}
      data-agent-pixel-avatar="true"
    />
  );
});

/** Check if avatarUrl is a custom image (not pixel:* format) */
export function isCustomAvatar(avatarUrl: string | null): boolean {
  if (!avatarUrl) return false;
  return !avatarUrl.startsWith("pixel:");
}

/** Every personal assistant's fixed avatar (set only by the server). */
export const ASSISTANT_AVATAR_URL = "pixel:ottie";

/** Render an agent avatar — custom image if uploaded, pixel art otherwise.
 *  Either one fills its frame: put it inside an AvatarSlot. A personal
 *  assistant (`pixel:ottie`) shows the otter art; the `ottie` sprite in
 *  pixelAvatars.json is only for surfaces without it (server SVG, mobile). */
export const AgentAvatar = memo(function AgentAvatar({
  avatarUrl,
}: {
  avatarUrl: string | null;
}) {
  // Some legacy test render trees mount this shared leaf without IntlProvider.
  const intl = useContext(IntlContext as unknown as Context<OptionalAvatarIntl | null>);
  const avatarAlt = intl?.formatMessage({ id: "agent.avatar.alt" }) ?? enFallback["agent.avatar.alt"];
  const [failedCustomUrl, setFailedCustomUrl] = useState<string | null>(null);
  if (avatarUrl === ASSISTANT_AVATAR_URL) {
    return (
      <img
        src={ottieUrl}
        alt={avatarAlt}
        draggable={false}
        className="size-full shrink-0 object-cover"
        data-agent-ottie-avatar="true"
      />
    );
  }
  if (isCustomAvatar(avatarUrl) && avatarUrl !== failedCustomUrl) {
    return (
      <img
        src={avatarUrl!}
        alt={avatarAlt}
        className="size-full shrink-0 object-cover"
        onError={() => setFailedCustomUrl(avatarUrl)}
      />
    );
  }
  return <PixelAvatar avatarKey={getEffectiveAvatarKey(avatarUrl)} />;
});

export default PixelAvatar;

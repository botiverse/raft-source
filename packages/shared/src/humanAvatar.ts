import { z } from "zod";
import { lazySchema } from "./lazySchema";

// A person's built pixel avatar, stored as the options they chose, never as an
// image: `users.avatarUrl = "pixel-human:v1:<background>.<skin>.<hair>.<hairColor>.<expression>.<head>.<face>"`.
// The web draws it (PersonAvatar), the Server draws the same SVG for surfaces
// that need an image URL (OAuth `picture`, /api/avatars/pixel/<key>.svg). The
// art is packages/shared/assets/humanAvatarLayers.json (humanAvatarArt.ts).
//
// Why not `pixel:`: clients released before this treat every `pixel:<key>` as
// an agent sprite and draw their default robot for a key they don't know (the
// mobile app's pixelAvatarSpecForWireValue). Under its own scheme an older
// web, desktop or mobile client shows its usual person placeholder instead.
//
// Compatibility of the stored value:
// - Fields are positional. A new field is APPENDED to v1, with a default
//   meaning "as before", so stored v1 values stay valid:
//   a reader fills a missing trailing field with its default, and ignores
//   trailing fields it doesn't know.
// - Option ids are stable and short; the art's option names are mapped below,
//   so renaming art never rewrites stored values. A new option is a new id.
// - Drawing is lenient (an unknown id in one field draws that field's
//   default); storing is strict (parseHumanAvatarRecipe, the PUT schema).
// - A change that can't be expressed by appending is `v2`; v1 readers draw
//   the default avatar for it.

export const HUMAN_AVATAR_SCHEME = "pixel-human:";
export const HUMAN_AVATAR_RECIPE_VERSION = "v1";
const PREFIX = `${HUMAN_AVATAR_SCHEME}${HUMAN_AVATAR_RECIPE_VERSION}:`;
/**
 * The marker of an avatar the Server picked (a new account's random one), not
 * one the person built: `pixel-human:v1:<fields>/auto`. Readers draw it like
 * any other; a provider's photo may still replace it (a social sign-in or
 * link), which it never does to a built one. Saving from the builder writes
 * the value without it. It follows every field, so fields appended later stay
 * in front of it.
 */
const AUTO_SUFFIX = "/auto";
/** Longest value a reader looks at; a real recipe is far shorter. */
const MAX_VALUE_LENGTH = 128;
const VALUE_PATTERN = /^pixel-human:v[0-9]{1,3}:[a-z0-9.]*(?:\/auto)?$/;

/** Each field's option ids, in display order. Stable: stored values hold them. */
const OPTION_IDS = {
  background: ["yellow", "pink", "sky", "mint", "lilac", "cream"],
  skin: ["1", "2", "3", "4", "5"],
  hair: ["short", "side", "long", "bun", "curly", "buzz"],
  hairColor: ["ink", "brown", "blonde", "ginger", "grey"],
  /** `wink` is the base's own face (an empty layer). */
  expression: ["wink", "grin", "oh", "smirk", "happy", "calm", "blush"],
  /** One thing on the head, or none. */
  head: ["none", "cap", "beanie", "headphones"],
  /** One thing on the face, or none. Combines with `head`. */
  face: ["none", "glasses"],
} as const;

/** A recipe: one known id per field. The PUT body's `recipe`; unknown keys (a
 *  newer client's field) are dropped, every known field is required. */
export const humanAvatarRecipeSchema = lazySchema("humanAvatarRecipeSchema", () => z.object({
  background: z.enum(OPTION_IDS.background),
  skin: z.enum(OPTION_IDS.skin),
  hair: z.enum(OPTION_IDS.hair),
  hairColor: z.enum(OPTION_IDS.hairColor),
  expression: z.enum(OPTION_IDS.expression),
  head: z.enum(OPTION_IDS.head),
  face: z.enum(OPTION_IDS.face),
}));

/** The body of PUT /api/auth/me/avatar-recipe. */
export const setHumanAvatarRecipeBodySchema = lazySchema("setHumanAvatarRecipeBodySchema", () => z.object({ recipe: humanAvatarRecipeSchema }));

export type HumanAvatarRecipe = z.infer<typeof humanAvatarRecipeSchema>;
export type HumanAvatarField = keyof HumanAvatarRecipe;
export type HumanAvatarOptionId<F extends HumanAvatarField> = HumanAvatarRecipe[F];

/** The art option each id draws (humanAvatarLayers.json); null draws nothing. */
export const HUMAN_AVATAR_OPTIONS = {
  background: { yellow: "yellow", pink: "pink", sky: "sky", mint: "mint", lilac: "lilac", cream: "cream" },
  skin: { "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" },
  hair: { short: "short", side: "side part", long: "long", bun: "bun", curly: "curly", buzz: "buzz" },
  hairColor: { ink: "ink", brown: "brown", blonde: "blonde", ginger: "ginger", grey: "grey" },
  expression: { wink: "wink", grin: "grin", oh: "oh", smirk: "smirk", happy: "happy", calm: "calm", blush: "blush" },
  head: { none: null, cap: "cap", beanie: "beanie", headphones: "headphones" },
  face: { none: null, glasses: "glasses" },
} as const satisfies { [F in HumanAvatarField]: Record<HumanAvatarOptionId<F>, string | null> };

/** Wire order of the fields. Append only (see the header). */
export const HUMAN_AVATAR_FIELDS = ["background", "skin", "hair", "hairColor", "expression", "head", "face"] as const satisfies readonly HumanAvatarField[];

/** The art's `default` (yellow, cap, short black hair, wink): what a field
 *  that can't be read draws, and where the builder starts over a photo. A new
 *  account gets a random look instead (randomHumanAvatarRecipe). */
export const DEFAULT_HUMAN_AVATAR_RECIPE: HumanAvatarRecipe = Object.freeze({
  background: "yellow",
  skin: "2",
  hair: "short",
  hairColor: "ink",
  expression: "wink",
  head: "cap",
  face: "none",
});

/** OPTION_IDS seen per field, so a generic field reads its own ids. */
const OPTION_ID_LISTS: { readonly [F in HumanAvatarField]: readonly HumanAvatarOptionId<F>[] } = OPTION_IDS;

export function humanAvatarOptionIds<F extends HumanAvatarField>(field: F): readonly HumanAvatarOptionId<F>[] {
  return OPTION_ID_LISTS[field];
}

/** True when `id` is one of `field`'s option ids. */
export function isHumanAvatarOptionId<F extends HumanAvatarField>(field: F, id: unknown): id is HumanAvatarOptionId<F> {
  const ids: readonly unknown[] = OPTION_IDS[field];
  return ids.includes(id);
}

/** The recipe with one field changed. */
export function withHumanAvatarOption<F extends HumanAvatarField>(recipe: HumanAvatarRecipe, field: F, id: HumanAvatarOptionId<F>): HumanAvatarRecipe {
  return { ...recipe, [field]: id };
}

/** The stored value. `auto` marks one the Server picked (see AUTO_SUFFIX). */
export function serializeHumanAvatarRecipe(recipe: HumanAvatarRecipe, options: { auto?: boolean } = {}): string {
  return PREFIX + HUMAN_AVATAR_FIELDS.map((field) => recipe[field]).join(".") + (options.auto ? AUTO_SUFFIX : "");
}

/** DEFAULT_HUMAN_AVATAR_RECIPE as an avatarUrl. */
export const DEFAULT_HUMAN_AVATAR_URL = serializeHumanAvatarRecipe(DEFAULT_HUMAN_AVATAR_RECIPE);

/** True when an avatarUrl is a built pixel avatar (any version, any fields):
 *  a short value of the `pixel-human:` scheme in its own alphabet. It names
 *  no URL and carries no personal data, so every projection that shows a
 *  person's stored upload may show it too. */
export function isHumanAvatarUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length <= MAX_VALUE_LENGTH && VALUE_PATTERN.test(value);
}

/** True when the avatar is one the Server picked, not one the person built. */
export function isAutoHumanAvatarUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && isHumanAvatarUrl(value) && value.endsWith(AUTO_SUFFIX);
}

/** The v1 fields of a value of this version, or null for another version. */
function v1Parts(value: string): string[] | null {
  if (!value.startsWith(PREFIX)) return null;
  const fields = value.endsWith(AUTO_SUFFIX) ? value.slice(PREFIX.length, -AUTO_SUFFIX.length) : value.slice(PREFIX.length);
  return fields.split(".");
}

/**
 * Strict: the recipe when `value` is exactly a v1 recipe this build knows
 * (every field present and known, nothing after them but the auto marker),
 * else null. For storing and validating; drawing uses readHumanAvatarRecipe.
 */
export function parseHumanAvatarRecipe(value: string): HumanAvatarRecipe | null {
  const parts = isHumanAvatarUrl(value) ? v1Parts(value) : null;
  if (!parts || parts.length !== HUMAN_AVATAR_FIELDS.length) return null;
  const parsed = humanAvatarRecipeSchema.safeParse(Object.fromEntries(HUMAN_AVATAR_FIELDS.map((field, index) => [field, parts[index]])));
  return parsed.success ? parsed.data : null;
}

/**
 * Lenient: what to draw for a stored avatarUrl. Null when it isn't a built
 * avatar at all. Otherwise a full recipe: a field that is missing or unknown
 * (a newer client's option) draws its default, extra trailing fields are
 * ignored, and another version draws the default avatar.
 */
export function readHumanAvatarRecipe(value: string | null | undefined): HumanAvatarRecipe | null {
  if (typeof value !== "string" || !isHumanAvatarUrl(value)) return null;
  const parts = v1Parts(value) ?? [];
  const read = <F extends HumanAvatarField>(field: F): HumanAvatarOptionId<F> => {
    const id = parts[HUMAN_AVATAR_FIELDS.indexOf(field)];
    return isHumanAvatarOptionId(field, id) ? id : DEFAULT_HUMAN_AVATAR_RECIPE[field];
  };
  return {
    background: read("background"),
    skin: read("skin"),
    hair: read("hair"),
    hairColor: read("hairColor"),
    expression: read("expression"),
    head: read("head"),
    face: read("face"),
  };
}

/**
 * A random look; `random` returns [0, 1). A new account's avatar (the Server
 * passes a crypto source) and Shuffle in the builder. Half wear something on
 * the head, about a third glasses (the design's shuffle), so most faces show.
 */
export function randomHumanAvatarRecipe(random: () => number = Math.random): HumanAvatarRecipe {
  const pickFrom = <T>(ids: readonly T[]): T => ids[Math.min(ids.length - 1, Math.floor(random() * ids.length))]!;
  return {
    background: pickFrom(OPTION_IDS.background),
    skin: pickFrom(OPTION_IDS.skin),
    hair: pickFrom(OPTION_IDS.hair),
    hairColor: pickFrom(OPTION_IDS.hairColor),
    expression: pickFrom(OPTION_IDS.expression),
    head: random() < 0.5 ? pickFrom(OPTION_IDS.head.filter((id) => id !== "none")) : "none",
    face: random() < 0.3 ? pickFrom(OPTION_IDS.face.filter((id) => id !== "none")) : "none",
  };
}

// ── Drawing ──

export interface HumanAvatarArtLayer {
  layer: string;
  option: string;
  group?: string;
  z?: number;
  /** `size` strings of `size` role characters. */
  rows: string[];
}

export interface HumanAvatarArt {
  size: number;
  /** Role character (0-9, then a-z for 10+) → `fixed:<key>` or
   *  `palette:<skin|hair>`. A new role (v3.2's headphone reds) is one more
   *  entry here and in `fixed`; 0 is always transparent. */
  roleColors: Record<string, string>;
  fixed: Record<string, string>;
  palettes: { background: Record<string, string>; skin: Record<string, string>; hair: Record<string, string> };
  layers: HumanAvatarArtLayer[];
}

export interface ComposedHumanAvatar {
  size: number;
  background: string;
  /** Row-major `size * size` colours; null shows the background. */
  pixels: (string | null)[];
}

const layerIndexCache = new WeakMap<HumanAvatarArt, Map<string, HumanAvatarArtLayer>>();

function layerIndex(art: HumanAvatarArt): Map<string, HumanAvatarArtLayer> {
  let index = layerIndexCache.get(art);
  if (!index) {
    index = new Map(art.layers.map((layer) => [`${layer.layer}:${layer.option}`, layer]));
    layerIndexCache.set(art, index);
  }
  return index;
}

function roleColorLookup(art: HumanAvatarArt, recipe: HumanAvatarRecipe): Map<string, string> {
  const paletteChoice: Record<string, string> = {
    skin: HUMAN_AVATAR_OPTIONS.skin[recipe.skin],
    hair: HUMAN_AVATAR_OPTIONS.hairColor[recipe.hairColor],
  };
  const colors = new Map<string, string>();
  for (const [role, source] of Object.entries(art.roleColors)) {
    const [kind, key] = source.split(":") as [string, string];
    const color = kind === "palette"
      ? art.palettes[key as "skin" | "hair"]?.[paletteChoice[key] ?? ""]
      : art.fixed[key];
    if (color) colors.set(role, color);
  }
  return colors;
}

/** The layers a recipe draws, in draw order: base, expression, hair,
 *  accessories by ascending z. */
function recipeLayers(art: HumanAvatarArt, recipe: HumanAvatarRecipe): HumanAvatarArtLayer[] {
  const index = layerIndex(art);
  const accessories = [HUMAN_AVATAR_OPTIONS.head[recipe.head], HUMAN_AVATAR_OPTIONS.face[recipe.face]]
    .flatMap((option) => (option ? [index.get(`accessory:${option}`)] : []))
    .filter((layer): layer is HumanAvatarArtLayer => Boolean(layer))
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  return [
    index.get("base:default"),
    index.get(`expression:${HUMAN_AVATAR_OPTIONS.expression[recipe.expression]}`),
    index.get(`hair:${HUMAN_AVATAR_OPTIONS.hair[recipe.hair]}`),
    ...accessories,
  ].filter((layer): layer is HumanAvatarArtLayer => Boolean(layer));
}

export function composeHumanAvatar(recipe: HumanAvatarRecipe, art: HumanAvatarArt): ComposedHumanAvatar {
  const { size } = art;
  const colors = roleColorLookup(art, recipe);
  const pixels: (string | null)[] = new Array(size * size).fill(null);
  for (const layer of recipeLayers(art, recipe)) {
    for (let y = 0; y < size; y++) {
      const row = layer.rows[y] ?? "";
      for (let x = 0; x < size; x++) {
        const role = row[x];
        if (!role || role === "0") continue;
        const color = colors.get(role);
        if (color) pixels[y * size + x] = color;
      }
    }
  }
  const background = art.palettes.background[HUMAN_AVATAR_OPTIONS.background[recipe.background]] ?? "#ffd440";
  return { size, background, pixels };
}

/**
 * The avatar as one SVG: the square background, then each row's runs of one
 * colour as a rect. `shape-rendering="crispEdges"` keeps every cell a hard
 * square at any size (the web also sets `image-rendering: pixelated`). The
 * whole image at every size: no crop for small avatars.
 */
export function renderHumanAvatarSvg(recipe: HumanAvatarRecipe, art: HumanAvatarArt): string {
  const { size, background, pixels } = composeHumanAvatar(recipe, art);
  const rects: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      const color = pixels[y * size + x];
      let end = x + 1;
      while (end < size && pixels[y * size + end] === color) end++;
      if (color) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`);
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${background}"/>${rects.join("")}</svg>`;
}

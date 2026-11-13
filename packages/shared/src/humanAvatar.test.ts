import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import {
  composeHumanAvatar,
  DEFAULT_HUMAN_AVATAR_RECIPE,
  DEFAULT_HUMAN_AVATAR_URL,
  HUMAN_AVATAR_FIELDS,
  HUMAN_AVATAR_OPTIONS,
  humanAvatarOptionIds,
  isAutoHumanAvatarUrl,
  isHumanAvatarUrl,
  parseHumanAvatarRecipe,
  randomHumanAvatarRecipe,
  readHumanAvatarRecipe,
  renderHumanAvatarSvg,
  serializeHumanAvatarRecipe,
  setHumanAvatarRecipeBodySchema,
} from "./humanAvatar";
import type { HumanAvatarArt, HumanAvatarRecipe } from "./humanAvatar";
import { HUMAN_AVATAR_ART } from "./humanAvatarArt";
import artJson from "../assets/humanAvatarLayers.json" with { type: "json" };

/** RGB pixels of an 8-bit truecolour, non-interlaced PNG (Oscar's default.png). */
function decodeRgbPng(file: Buffer): { width: number; height: number; rgb: Buffer } {
  assert.equal(file.subarray(1, 4).toString("latin1"), "PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("latin1");
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 2, 0], "8-bit RGB, not interlaced");
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      const up = y > 0 ? rgb[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      rgb[y * stride + i] = (value + predictor) & 0xff;
    }
  }
  return { width, height, rgb };
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

test("the default recipe draws Oscar's default.png pixel for pixel", () => {
  const png = decodeRgbPng(readFileSync(new URL("./fixtures/humanAvatarDefault.png", import.meta.url)));
  const drawn = composeHumanAvatar(DEFAULT_HUMAN_AVATAR_RECIPE, HUMAN_AVATAR_ART);
  assert.equal(drawn.size, png.width);
  assert.equal(drawn.size, png.height);
  const mismatches: string[] = [];
  for (let i = 0; i < drawn.size * drawn.size; i++) {
    const want = hex(png.rgb[i * 3]!, png.rgb[i * 3 + 1]!, png.rgb[i * 3 + 2]!);
    const got = (drawn.pixels[i] ?? drawn.background).toLowerCase();
    if (got !== want) mismatches.push(`(${i % drawn.size},${Math.floor(i / drawn.size)}) ${got} != ${want}`);
  }
  assert.deepEqual(mismatches.slice(0, 5), []);
});

test("the default recipe is the art's own default", () => {
  const art = artJson.default;
  const accessories = new Set(art.accessories);
  assert.equal(HUMAN_AVATAR_OPTIONS.background[DEFAULT_HUMAN_AVATAR_RECIPE.background], art.background);
  assert.equal(HUMAN_AVATAR_OPTIONS.skin[DEFAULT_HUMAN_AVATAR_RECIPE.skin], art.skin);
  assert.equal(HUMAN_AVATAR_OPTIONS.hair[DEFAULT_HUMAN_AVATAR_RECIPE.hair], art.hair);
  assert.equal(HUMAN_AVATAR_OPTIONS.hairColor[DEFAULT_HUMAN_AVATAR_RECIPE.hairColor], art.hair_color);
  assert.equal(HUMAN_AVATAR_OPTIONS.expression[DEFAULT_HUMAN_AVATAR_RECIPE.expression], art.expression);
  assert.deepEqual(
    new Set([HUMAN_AVATAR_OPTIONS.head[DEFAULT_HUMAN_AVATAR_RECIPE.head], HUMAN_AVATAR_OPTIONS.face[DEFAULT_HUMAN_AVATAR_RECIPE.face]].filter(Boolean)),
    accessories,
  );
  assert.equal(DEFAULT_HUMAN_AVATAR_URL, "pixel-human:v1:yellow.2.short.ink.wink.cap.none");
});

test("every option id draws art that exists", () => {
  const art: HumanAvatarArt = HUMAN_AVATAR_ART;
  const layers = new Set(art.layers.map((layer) => `${layer.layer}:${layer.option}`));
  for (const id of humanAvatarOptionIds("background")) assert.ok(art.palettes.background[HUMAN_AVATAR_OPTIONS.background[id]], id);
  for (const id of humanAvatarOptionIds("skin")) assert.ok(art.palettes.skin[HUMAN_AVATAR_OPTIONS.skin[id]], id);
  for (const id of humanAvatarOptionIds("hairColor")) assert.ok(art.palettes.hair[HUMAN_AVATAR_OPTIONS.hairColor[id]], id);
  for (const id of humanAvatarOptionIds("hair")) assert.ok(layers.has(`hair:${HUMAN_AVATAR_OPTIONS.hair[id]}`), id);
  for (const id of humanAvatarOptionIds("expression")) assert.ok(layers.has(`expression:${HUMAN_AVATAR_OPTIONS.expression[id]}`), id);
  for (const id of humanAvatarOptionIds("head")) {
    const option = HUMAN_AVATAR_OPTIONS.head[id];
    if (option) assert.ok(layers.has(`accessory:${option}`), id);
  }
  for (const id of humanAvatarOptionIds("face")) {
    const option = HUMAN_AVATAR_OPTIONS.face[id];
    if (option) assert.ok(layers.has(`accessory:${option}`), id);
  }
  // Every art layer's group matches the recipe field it is offered in.
  for (const layer of art.layers.filter((l) => l.layer === "accessory")) {
    const field = layer.group as "head" | "face";
    assert.ok(Object.values(HUMAN_AVATAR_OPTIONS[field]).includes(layer.option as never), layer.option);
  }
});

test("every recipe round-trips through its stored value", () => {
  const all: HumanAvatarRecipe[] = [];
  for (const background of humanAvatarOptionIds("background"))
    for (const hair of humanAvatarOptionIds("hair"))
      for (const head of humanAvatarOptionIds("head"))
        for (const face of humanAvatarOptionIds("face"))
          for (const expression of humanAvatarOptionIds("expression"))
            all.push({ ...DEFAULT_HUMAN_AVATAR_RECIPE, background, hair, head, face, expression, skin: "4", hairColor: "ginger" });
  for (const recipe of all) {
    const value = serializeHumanAvatarRecipe(recipe);
    assert.ok(isHumanAvatarUrl(value), value);
    assert.deepEqual(parseHumanAvatarRecipe(value), recipe, value);
    assert.deepEqual(readHumanAvatarRecipe(value), recipe, value);
  }
});

test("parse is strict: an unknown id, a missing or extra field, another version", () => {
  for (const value of [
    "pixel-human:v1:yellow.2.short.ink.wink.cap",
    "pixel-human:v1:yellow.2.short.ink.wink.cap.none.later",
    "pixel-human:v1:purple.2.short.ink.wink.cap.none",
    "pixel-human:v1:yellow.9.short.ink.wink.cap.none",
    "pixel-human:v1:yellow.2.short.ink.frown.cap.none",
    "pixel-human:v1:yellow.2.short.ink.wink.crown.none",
    "pixel-human:v2:yellow.2.short.ink.wink.cap.none",
    "pixel-human:v1:Yellow.2.short.ink.wink.cap.none",
    "pixel-human:v1:yellow.2.short.ink.wink.cap.none ",
    "pixel:human:v1:yellow.2.short.ink.wink.cap.none",
    "pixel:robot",
    "/api/avatars/users/0123456789abcdef0123456789abcdef.webp",
    "",
  ]) {
    assert.equal(parseHumanAvatarRecipe(value), null, value);
  }
  assert.equal(parseHumanAvatarRecipe("pixel-human:v1:constructor.2.short.ink.wink.cap.none"), null, "prototype keys are not ids");
});

test("a Server-picked avatar carries the auto marker; it draws and parses like a built one", () => {
  const recipe = { ...DEFAULT_HUMAN_AVATAR_RECIPE, background: "pink" as const };
  const auto = serializeHumanAvatarRecipe(recipe, { auto: true });
  assert.equal(auto, "pixel-human:v1:pink.2.short.ink.wink.cap.none/auto");
  assert.equal(isAutoHumanAvatarUrl(auto), true);
  assert.equal(isAutoHumanAvatarUrl(serializeHumanAvatarRecipe(recipe)), false, "a built one has no marker");
  assert.equal(isAutoHumanAvatarUrl(null), false);
  assert.deepEqual(parseHumanAvatarRecipe(auto), recipe);
  assert.deepEqual(readHumanAvatarRecipe(auto), recipe);
  assert.equal(parseHumanAvatarRecipe("pixel-human:v1:pink.2.short.ink.wink.cap.none/other"), null);
});

test("reading for drawing: unknown → that field's default; a later field is ignored; missing → default", () => {
  assert.deepEqual(
    readHumanAvatarRecipe("pixel-human:v1:pink.4.curly.ink.sneeze.crown.glasses"),
    { ...DEFAULT_HUMAN_AVATAR_RECIPE, background: "pink", skin: "4", hair: "curly", face: "glasses" },
  );
  // A later build appends a field: this one draws the rest as stored.
  assert.deepEqual(
    readHumanAvatarRecipe("pixel-human:v1:mint.1.side.ginger.grin.headphones.none.scarf"),
    { background: "mint", skin: "1", hair: "side", hairColor: "ginger", expression: "grin", head: "headphones", face: "none" },
  );
  // A value missing trailing fields reads each as its default.
  assert.deepEqual(
    readHumanAvatarRecipe("pixel-human:v1:sky.3.bun.brown"),
    { ...DEFAULT_HUMAN_AVATAR_RECIPE, background: "sky", skin: "3", hair: "bun", hairColor: "brown" },
  );
  assert.deepEqual(readHumanAvatarRecipe("pixel-human:v9:anything"), DEFAULT_HUMAN_AVATAR_RECIPE);
  assert.equal(readHumanAvatarRecipe(null), null);
  assert.equal(readHumanAvatarRecipe("pixel:robot"), null);
  assert.equal(readHumanAvatarRecipe("https://example.com/a.png"), null);
  assert.equal(readHumanAvatarRecipe(`pixel-human:v1:${"a".repeat(200)}`), null, "too long to be one");
});

test("the PUT body schema takes known ids only and drops unknown keys", () => {
  const ok = setHumanAvatarRecipeBodySchema.safeParse({ recipe: { ...DEFAULT_HUMAN_AVATAR_RECIPE, scarf: "red" } });
  assert.ok(ok.success);
  assert.deepEqual(ok.data.recipe, DEFAULT_HUMAN_AVATAR_RECIPE);
  for (const recipe of [
    { ...DEFAULT_HUMAN_AVATAR_RECIPE, head: "crown" },
    { ...DEFAULT_HUMAN_AVATAR_RECIPE, expression: undefined },
    { ...DEFAULT_HUMAN_AVATAR_RECIPE, skin: 2 },
    { background: "yellow" },
    "pixel-human:v1:yellow.2.short.ink.wink.cap.none",
  ]) {
    assert.equal(setHumanAvatarRecipeBodySchema.safeParse({ recipe }).success, false, JSON.stringify(recipe));
  }
});

test("shuffle picks only known ids across every field", () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seen = new Map(HUMAN_AVATAR_FIELDS.map((field) => [field, new Set<string>()]));
  for (let i = 0; i < 400; i++) {
    const recipe = randomHumanAvatarRecipe(random);
    assert.deepEqual(parseHumanAvatarRecipe(serializeHumanAvatarRecipe(recipe)), recipe);
    for (const field of HUMAN_AVATAR_FIELDS) seen.get(field)!.add(recipe[field]);
  }
  for (const field of HUMAN_AVATAR_FIELDS) assert.equal(seen.get(field)!.size, humanAvatarOptionIds(field).length, field);
});

test("an expression draws over the base and under the hair", () => {
  // Long hair falls over the face where an expression has cells: the hair wins.
  const longHair = { ...DEFAULT_HUMAN_AVATAR_RECIPE, hair: "long" as const };
  const plain = composeHumanAvatar(longHair, HUMAN_AVATAR_ART);
  const grin = composeHumanAvatar({ ...longHair, expression: "grin" }, HUMAN_AVATAR_ART);
  const hair = HUMAN_AVATAR_ART.layers.find((l) => l.layer === "hair" && l.option === "long")!;
  const grinLayer = HUMAN_AVATAR_ART.layers.find((l) => l.layer === "expression" && l.option === "grin")!;
  let overlapping = 0;
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) if (hair.rows[y]![x] !== "0" && grinLayer.rows[y]![x] !== "0") overlapping++;
  assert.ok(overlapping > 0, "the case must overlap to test the order");
  const cap = HUMAN_AVATAR_ART.layers.find((l) => l.option === "cap")!;
  let changed = 0;
  for (let i = 0; i < plain.pixels.length; i++) {
    const [x, y] = [i % plain.size, Math.floor(i / plain.size)];
    const covered = hair.rows[y]![x] !== "0" || cap.rows[y]![x] !== "0";
    if (covered) assert.equal(grin.pixels[i], plain.pixels[i], `hair/cap cell (${x},${y}) stays on top`);
    else if (grin.pixels[i] !== plain.pixels[i]) changed++;
  }
  assert.ok(changed > 0, "the grin changes the face");
  // The blush uses role 8, the pink only the expression layers have.
  const blush = composeHumanAvatar({ ...DEFAULT_HUMAN_AVATAR_RECIPE, expression: "blush" }, HUMAN_AVATAR_ART);
  assert.ok(blush.pixels.includes(HUMAN_AVATAR_ART.fixed.pink!), "role 8 draws the art's pink");
});

test("accessories draw by ascending z, and the SVG is the composed grid", () => {
  // Glasses (z 0) draw first, headphones (z 1) over them: where the headphones
  // have a cell, it is the headphones' colour whether or not glasses are on.
  const both = composeHumanAvatar({ ...DEFAULT_HUMAN_AVATAR_RECIPE, head: "headphones", face: "glasses" }, HUMAN_AVATAR_ART);
  const headphonesOnly = composeHumanAvatar({ ...DEFAULT_HUMAN_AVATAR_RECIPE, head: "headphones" }, HUMAN_AVATAR_ART);
  const headphones = HUMAN_AVATAR_ART.layers.find((l) => l.option === "headphones")!;
  for (let y = 0; y < both.size; y++) {
    for (let x = 0; x < both.size; x++) {
      if (headphones.rows[y]![x] !== "0") assert.equal(both.pixels[y * both.size + x], headphonesOnly.pixels[y * both.size + x]);
    }
  }
  const svg = renderHumanAvatarSvg(DEFAULT_HUMAN_AVATAR_RECIPE, HUMAN_AVATAR_ART);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 112 112" shape-rendering="crispEdges"><rect width="112" height="112" fill="#ffd440"\/>/);
  // Every rect is one row's run: expanding them gives back the composed pixels.
  const composed = composeHumanAvatar(DEFAULT_HUMAN_AVATAR_RECIPE, HUMAN_AVATAR_ART);
  const expanded: (string | null)[] = new Array(112 * 112).fill(null);
  for (const [, x, y, w, fill] of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g)) {
    for (let i = 0; i < Number(w); i++) expanded[Number(y) * 112 + Number(x) + i] = fill!;
  }
  assert.deepEqual(expanded, composed.pixels);
});

test("every role a layer uses has a colour, and v3.2's headphones draw in their own reds", () => {
  const used = new Set(HUMAN_AVATAR_ART.layers.flatMap((layer) => layer.rows.flatMap((row) => [...row])));
  used.delete("0");
  for (const role of used) assert.ok(HUMAN_AVATAR_ART.roleColors[role], `role ${role} has a colour`);
  const phones = composeHumanAvatar({ ...DEFAULT_HUMAN_AVATAR_RECIPE, head: "headphones" }, HUMAN_AVATAR_ART);
  for (const key of ["phone_red", "phone_shade", "phone_band", "phone_hi"]) {
    assert.ok(phones.pixels.includes(HUMAN_AVATAR_ART.fixed[key]!), `${key} drawn`);
  }
});

test("long hair (v3.3) falls past the shoulders, clearly below the medium cut", () => {
  const lowestRow = (option: string) => {
    const layer = HUMAN_AVATAR_ART.layers.find((l) => l.layer === "hair" && l.option === option)!;
    let lowest = -1;
    layer.rows.forEach((row, y) => { if (/[^0]/.test(row)) lowest = y; });
    return lowest;
  };
  const base = HUMAN_AVATAR_ART.layers.find((l) => l.layer === "base")!;
  // The shoulders start where the bust is at its widest below the head.
  const width = (row: string) => row.replace(/^0+|0+$/g, "").length;
  const shoulders = base.rows.findIndex((row, y) => y > 70 && width(row) === Math.max(...base.rows.map(width)));
  assert.ok(shoulders > 0, "the bust has shoulders");
  assert.ok(lowestRow("long") > shoulders, `long hair ends at row ${lowestRow("long")}, below the shoulders at ${shoulders}`);
  assert.ok(lowestRow("long") >= lowestRow("side part") + 24, "long is clearly longer than side part");
});

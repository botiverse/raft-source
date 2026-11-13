import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// The web serves Raft's fonts itself (src/fonts.css) instead of importing
// raft-ui's fonts.css, which loads them from Google Fonts. Its font variables
// must stay raft-ui's, or the app drifts silently from the design system
// (raft-ui 0.10.1 added the Japanese / Korean fallbacks, without which kanji
// render with Chinese glyph shapes).
const fontsCssUrl = new URL("../src/fonts.css", import.meta.url);
const fontsCss = readFileSync(fontsCssUrl, "utf8");
const raftUiFontsCss = readFileSync(createRequire(import.meta.url).resolve("@botiverse/raft-ui/fonts.css"), "utf8");

function variableRules(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\s+url\([^)]*\)\s*;/g, "")
    .replace(/@font-face\s*\{[^}]*\}/g, "")
    .split("}")
    .map((rule) => rule.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function fontFaces(css: string) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
    weight: /font-weight:\s*([^;]+);/.exec(body)?.[1].trim(),
    src: /src:\s*url\(([^)]+)\)/.exec(body)?.[1],
    unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1].trim(),
  }));
}

test("the web's fonts.css carries raft-ui's font variables verbatim", () => {
  assert.ok(variableRules(raftUiFontsCss).length >= 3, "raft-ui fonts.css has the default, ja and ko rules");
  assert.deepEqual(variableRules(fontsCss), variableRules(raftUiFontsCss));
});

test("every face loads a bundled woff2 from this origin, with Google's subsets", () => {
  assert.doesNotMatch(fontsCss, /https?:/, "no network font requests");
  const faces = fontFaces(fontsCss);
  for (const face of faces) {
    assert.ok(face.family && face.src && face.unicodeRange, JSON.stringify(face));
    const bytes = readFileSync(new URL(face.src, fontsCssUrl));
    assert.equal(bytes.subarray(0, 4).toString(), "wOF2", face.src);
  }
  // The families, weights and subsets raft-ui's Google Fonts request
  // (Space Grotesk 300..700, Space Mono 400 / 700) resolves to.
  const subsets = (family: string, weight: string) =>
    faces.filter((face) => face.family === family && face.weight === weight).map((face) => face.src?.replace(/^.*\//, ""));
  assert.deepEqual(subsets("Space Grotesk", "300 700"), [
    "space-grotesk-vietnamese.woff2",
    "space-grotesk-latin-ext.woff2",
    "space-grotesk-latin.woff2",
  ]);
  for (const weight of ["400", "700"]) {
    assert.deepEqual(subsets("Space Mono", weight), [
      `space-mono-vietnamese-${weight}.woff2`,
      `space-mono-latin-ext-${weight}.woff2`,
      `space-mono-latin-${weight}.woff2`,
    ]);
  }
  assert.deepEqual(
    faces.filter((face) => face.family === "Raft Quote Glyphs").map((face) => face.unicodeRange),
    ["U+0022"],
  );
});

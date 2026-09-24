import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Parse actual CSS asset references, not a copied filename inventory. Guards
// offline typography when a font face is added or a local asset is forgotten.
test("shared typography has local font assets and no Google Fonts requests", async () => {
  const entry = new URL("../../../../packages/web/src/index.css", import.meta.url);
  const css = await readFile(entry, "utf8");
  assert.doesNotMatch(css, /https:\/\/fonts\.(googleapis|gstatic)\.com/);
  const fonts = new URL("./assets/fonts/fonts.css", entry);
  const faces = await readFile(fonts, "utf8");
  assert.doesNotMatch(faces, /https?:/);
  const sources = [...faces.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)].map((m) => new URL(m[1], fonts));
  sources.push(new URL("./assets/fonts/hanken-grotesk-quotes.woff2", entry));
  assert.ok(sources.length >= 3);
  for (const source of sources) {
    const data = await readFile(source);
    assert.ok(data.length > 0, source.pathname);
    assert.ok(data.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || data.subarray(0, 4).toString() === "wOF2", source.pathname);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ARTIFACT_PAGE_COLORS, ARTIFACT_PAGE_THEME_TOKENS, ARTIFACT_PAGE_THEME_VARIABLES } from "@botiverse/raft-shared/src/artifactPageTheme";
import type { ArtifactPageToken } from "@botiverse/raft-shared/src/artifactPageTheme";

// What a Markdown page may be sent: colours, from tokens raft-ui really has. A page sits outside
// Raft's boundary, so a font, a url() of a theme's decor or any other token is not to reach it.
const raftUi = dirname(createRequire(import.meta.url).resolve("@botiverse/raft-ui/package.json"));
const foundation = readFileSync(join(raftUi, "dist/foundation.css"), "utf8");
const themes = readFileSync(join(raftUi, "dist/themes.css"), "utf8");

/** Each `token: value` in a rule of `css` whose selector is exactly `selector`, as written. */
function declared(css: string, selector: string, token: string): string | null {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, selector);
  const body = css.slice(start, css.indexOf("\n}", start));
  return new RegExp(`\\n\\s*${token}:\\s*([^;]+);`).exec(body)?.[1] ?? null;
}

const LIGHT = ".light";
const COLOR = /^(?:oklch\(|#[0-9a-f]{3,8}$|rgba?\(|color-mix\(|var\(--)/iu;

test("every token a page takes is one of raft-ui's, holding a colour, in light and in dark", () => {
  for (const token of Object.keys(ARTIFACT_PAGE_COLORS) as ArtifactPageToken[]) {
    const light = declared(foundation, LIGHT, token);
    assert.ok(light, `${token} in light`);
    assert.match(light, COLOR, token);
    const dark = declared(foundation, ".dark", token);
    if (dark) assert.match(dark, COLOR, `${token} in dark`);
  }
});

test("a theme overrides those tokens with colours too, and the theme's decor is no token of a page's", () => {
  const taken = new Set<string>(Object.keys(ARTIFACT_PAGE_COLORS));
  for (const [, token, value] of themes.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gmu)) {
    if (taken.has(token!)) assert.match(value!, COLOR, token);
  }
  assert.equal(taken.has("--theme-decor-top") || taken.has("--theme-decor-rail") || taken.has("--frame-decor-top"), false);
});

test("the fallbacks are Raft Yellow's light values, but for those the page's look kept apart", () => {
  // Older values the page has always shown: a theme's own replace them, a page with none keeps them.
  // The sidebar's is white so that a page with no theme has no ground to draw a card on.
  const kept = new Set<ArtifactPageToken>(["--foreground-link", "--layer-backdrop", "--brand-400", "--layer-sidebar"]);
  const white = new Set<ArtifactPageToken>(["--layer-canvas", "--layer-card", "--layer-code"]);
  for (const token of Object.keys(ARTIFACT_PAGE_COLORS) as ArtifactPageToken[]) {
    if (kept.has(token)) continue;
    if (white.has(token)) {
      assert.equal(declared(foundation, LIGHT, token), "oklch(1 0 0)", token);
      assert.equal(ARTIFACT_PAGE_COLORS[token], "#fff", token);
    } else {
      assert.equal(ARTIFACT_PAGE_COLORS[token], declared(foundation, LIGHT, token), token);
    }
  }
});

test("every theme keeps its ground and card apart, in light and in dark: the page draws a card only where they differ", () => {
  assert.notEqual(declared(foundation, LIGHT, "--layer-sidebar"), declared(foundation, LIGHT, "--layer-card"));
  assert.notEqual(declared(foundation, ".dark", "--layer-sidebar"), declared(foundation, ".dark", "--layer-card"));
  let seen = 0;
  for (const [, mode, body] of themes.matchAll(/^\.(light|dark)\[data-theme="[a-z]+"\][^{]*\{([^}]*)\}/gmu)) {
    const inTheme = (token: string) => new RegExp(`\\n\\s*${token}:\\s*([^;]+);`).exec(body!)?.[1];
    const ground = inTheme("--layer-sidebar") ?? declared(foundation, `.${mode}`, "--layer-sidebar");
    const card = inTheme("--layer-card") ?? declared(foundation, `.${mode}`, "--layer-card");
    assert.notEqual(ground, card, `${mode}: ${body}`);
    seen += 1;
  }
  assert.ok(seen > 0, "the themes were read");
});

test("each page name is read from its own token, and a default the shell can be given", () => {
  for (const [name, token] of Object.entries(ARTIFACT_PAGE_THEME_TOKENS)) {
    assert.equal(name, `--raft-${token.slice(2)}`);
    assert.equal(ARTIFACT_PAGE_THEME_VARIABLES[name], ARTIFACT_PAGE_COLORS[token as ArtifactPageToken]);
    // Porthole refuses these in a theme value (`resolveTheme`), and a config with them (`validateConfig`).
    assert.doesNotMatch(ARTIFACT_PAGE_THEME_VARIABLES[name]!, /[;{}<>]/u);
  }
});

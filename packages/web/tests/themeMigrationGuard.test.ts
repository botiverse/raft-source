import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isTestPath } from "../scripts/testLocations";

const root = resolve(import.meta.dirname, "..");

function walkSourceFiles(dir: string, fileList: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) walkSourceFiles(fullPath, fileList);
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) fileList.push(fullPath);
  }
  return fileList;
}

/**
 * Raw palette classes: the brand ramps (`*-palette-*`, and their deprecated
 * raft-ui aliases `*-brutal-*` and `soft-signal`), plain white / black, the
 * old `btn-brutal*` classes. App surfaces paint with the
 * Raft Design System's semantic tokens (`bg-layer-*`, `text-foreground*`,
 * `border-line-*`, `bg-brand`, ...), which follow light and dark; a raw
 * palette class is right in one mode and wrong in the other. raft-ui owns the
 * few places a ramp colour is the meaning (a person without a photo is
 * lavender), so the app reaches them through raft-ui parts.
 */
const RAW_PALETTE =
  /\b(?:bg|text|border|shadow|outline|ring|divide|decoration)-(?:palette-[a-z0-9-]+|brutal-[a-z0-9-]+|soft-signal)(?:\/\d+)?\b|\b(?:bg-white|text-black|border-black)(?:\/\d+)?\b|\bbtn-brutal[a-z0-9-]*/g;

/** Hand-drawn previews that stand in for a raft-ui part. Ratchet down only. */
const ALLOWED: Record<string, number> = {
  // The identity-setup preview draws a message avatar by hand.
  "src/components/auth/AccountIdentitySetupPage.tsx": 1,
  // The appearance picker's miniature of the app.
  "src/components/settings/AppearanceThemePicker.tsx": 1,
};

function rawPaletteClasses(path: string): string[] {
  const code = readFileSync(resolve(root, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(RAW_PALETTE)].map((match) => match[0]);
}

test("app surfaces paint with semantic tokens, not raw palette classes", () => {
  for (const fullPath of walkSourceFiles(resolve(root, "src"))) {
    const path = relative(root, fullPath);
    // Feature tests (src/features/<feature>/tests/) are not app surfaces.
    if (isTestPath(path)) continue;
    const found = rawPaletteClasses(path);
    const allowed = ALLOWED[path] ?? 0;
    assert.ok(
      found.length <= allowed,
      `${path} has ${found.length} raw palette classes (allowed ${allowed}); use the DS semantic tokens or a raft-ui part:\n${found.join("\n")}`,
    );
  }
});

test("the allowlist only names files that still need it", () => {
  for (const [path, allowed] of Object.entries(ALLOWED)) {
    assert.equal(rawPaletteClasses(path).length, allowed, `${path}: lower its allowance to what it uses`);
  }
});

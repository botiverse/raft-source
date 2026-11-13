/**
 * Chrome's web-vitals library as a page init script, shared by measure.ts and
 * load.ts. The package exports only its module builds; the IIFE build sits
 * next to the CommonJS one in dist/ (web-vitals is pinned exactly in
 * package.json, so a layout change fails here, loudly).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Throws when the browser build cannot be read. */
export function webVitalsSource(): string {
  return readFileSync(join(dirname(createRequire(import.meta.url).resolve("web-vitals")), "web-vitals.iife.js"), "utf8");
}

/**
 * One init script: the library, then `hook`. Playwright wraps an init script in
 * a function, so the IIFE's `var webVitals` is scoped to it, not global: the
 * hook must be in the same script, after a newline (the IIFE ends with a
 * sourceMappingURL line comment).
 */
export function vitalsInitScript(hook: string): string {
  return `${webVitalsSource()}\n${hook}`;
}

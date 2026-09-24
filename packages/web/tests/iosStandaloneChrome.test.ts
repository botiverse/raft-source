import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("iOS standalone chrome uses theme yellow by default and white detail routes", () => {
  const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
  const css = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");
  const manifest = readFileSync(resolve(repoRoot, "public/site.webmanifest"), "utf8");
  const layout = readFileSync(
    resolve(repoRoot, "src/components/layout/MainLayout.tsx"),
    "utf8",
  );

  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" \/>/);
  assert.match(html, /<meta name="theme-color" content="#FFD440" \/>/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
  assert.match(manifest, /"theme_color": "#FFD440"/);
  assert.match(manifest, /"background_color": "#FFD440"/);
  assert.match(css, /html \{[\s\S]*background-color: #FFFFFF;/);
  assert.match(css, /body \{[\s\S]*background-color: #FFFFFF;/);
  assert.match(layout, /const THEME_CHROME_YELLOW = "#FFD440";/);
  assert.match(layout, /const THEME_CHROME_WHITE = "#FFFFFF";/);
  assert.match(
    layout,
    /const isMobileTabRoot = mobileShowSidebarInline \|\| \(!isDesktop && isTasksRoute\)/,
  );
  assert.match(
    layout,
    /const browserChromeColor = !isDesktop && !isMobileTabRoot \? THEME_CHROME_WHITE : THEME_CHROME_YELLOW/,
  );
  assert.match(layout, /themeColor\.content = browserChromeColor/);
  assert.match(
    layout,
    /isMobileTabRoot \? "bg-soft-signal" : "bg-white md:bg-brutal-cream"/,
  );
});

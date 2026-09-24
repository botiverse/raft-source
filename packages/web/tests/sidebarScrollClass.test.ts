/**
 * Contract test for the sidebar scrollbar strategy.
 *
 * Sidebar matches MessageTimeline: `overflow-y-auto` with the shared desktop
 * scrollbar treatment and platform-native touch overlays.
 * stdrc 2026-05-20 #proj-uiux:d7e5c75b (task #282) restored desktop scrollbar
 * visibility — the prior global `@media (hover: hover) and (pointer: fine)` rule
 * that hid native rails on desktop is removed. Desktop pointer devices use a
 * narrow thumb on a transparent track; touch devices retain native overlays.
 * The `.scrollbar-none` utility remains for opt-in suppression on specific
 * surfaces (e.g. horizontal tab strips), with no sidebar-only pseudo styling.
 *
 * The previous WebKit scrollbar pseudo-elements on the sidebar itself could
 * push WebKit into legacy scrollbar-gutter mode, leaving a cream strip to the
 * right of selected rows; the sidebar still must not declare any per-surface
 * scrollbar styling.
 *
 * The inner div must not manufacture a 1px phantom overflow. That old iOS
 * bounce trick makes native scrollbars visible even when content does not
 * actually overflow.
 *
 * This test pins these invariants so a refactor that:
 *   - reintroduces per-sidebar WebKit scrollbar pseudo classes
 *   - reintroduces per-sidebar scrollbar-width / scrollbar-gutter styling
 *   - re-introduces the 1px phantom overflow hack
 *   - re-adds a global `@media (hover/pointer)` rule that hides native rails
 *     on desktop
 *   - reintroduces the old bottom fade affordance
 * fails CI immediately.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function sidebarInnerMinHeight(_mobileInline: boolean): string {
  // Both inline mobile rails and desktop rails use real full-height content.
  return "100%";
}

// ── Outer container ──────────────────────────────────────────────────────────

const sidebarOuterClass =
  "scrollbar-quiet flex-1 overflow-x-hidden overflow-y-auto px-2 py-3";

test("Sidebar uses native auto overflow with no explicit scrollbar styling", () => {
  assert.ok(sidebarOuterClass.includes("overflow-y-auto"));
  assert.ok(!sidebarOuterClass.includes("overflow-y-scroll"));
  assert.ok(!sidebarOuterClass.includes("scrollbar-width"));
  assert.ok(!sidebarOuterClass.includes("::-webkit-scrollbar"));
  assert.ok(!sidebarOuterClass.includes("scrollbar-gutter"));
});

// ── Inner min-height contract ────────────────────────────────────────────────

test("Mobile rails do not manufacture phantom overflow", () => {
  assert.equal(sidebarInnerMinHeight(true), "100%");
});

test("Desktop rails use the same min-h-full contract", () => {
  assert.equal(sidebarInnerMinHeight(false), "100%");
});

test("Sidebar source keeps native auto scroll without phantom overflow", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/components/layout/Sidebar.tsx"), "utf8");

  assert.match(source, /const sidebarScrollClassName = "scrollbar-quiet flex-1 overflow-x-hidden overflow-y-auto px-2 py-3"/);
  assert.match(source, /overflow-y-auto px-2 py-3/);
  assert.doesNotMatch(source, /overflow-y-scroll/);
  assert.doesNotMatch(source, /scrollbar-width/);
  assert.doesNotMatch(source, /::-webkit-scrollbar/);
  assert.doesNotMatch(source, /md:\[&::-webkit-scrollbar\]:block/);
  assert.doesNotMatch(source, /scrollbar-gutter/);
  assert.doesNotMatch(source, /calc\(100% \+ 1px\)/);
  assert.doesNotMatch(source, /style=\{mobileInline \?/);
  assert.doesNotMatch(source, /sidebarCanScrollDown/);
  assert.doesNotMatch(source, /data-testid="sidebar-scroll-fade"/);
  assert.doesNotMatch(source, /bg-gradient-to-t from-brutal-cream/);
  assert.match(source, /<div className="min-h-full">/);
});

test("Desktop uses the shared thin scrollbar without hiding it", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/index.css"), "utf8");

  assert.match(source, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(source, /\.scrollbar-quiet\s*\{[\s\S]*?scrollbar-color:\s*rgba\(0, 0, 0, 0\.24\) transparent/);
  assert.match(source, /scrollbar-width:\s*thin/);
  assert.match(source, /\.scrollbar-quiet:hover\s*\{[\s\S]*?scrollbar-color:\s*rgba\(0, 0, 0, 0\.36\) transparent/);
  assert.match(source, /\.scrollbar-quiet::-webkit-scrollbar\s*\{[\s\S]*?width:\s*10px/);
  assert.match(source, /\.scrollbar-quiet::-webkit-scrollbar-track,\s*\.scrollbar-quiet::-webkit-scrollbar-corner\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(source, /\.scrollbar-quiet::-webkit-scrollbar-thumb\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?background:\s*rgba\(0, 0, 0, 0\.24\)[\s\S]*?border:\s*2px solid transparent;[\s\S]*?border-radius:\s*5px/);
  assert.match(source, /\.scrollbar-quiet:hover::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*rgba\(0, 0, 0, 0\.36\)[\s\S]*?border:\s*2px solid transparent/);
  assert.match(source, /\.scrollbar-quiet::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*?background:\s*rgba\(0, 0, 0, 0\.52\)[\s\S]*?border:\s*2px solid transparent/);
  assert.doesNotMatch(source, /(?:^|\n)\s*\*\s*\{[^}]*scrollbar-(?:color|width)/);
  assert.doesNotMatch(source, /(?:^|\n)\s*\*::-webkit-scrollbar/);
  // The wildcard `* { scrollbar-width: none }` form (in any scope) is the
  // hammer that nukes scrollbars globally — guard against re-introduction.
  assert.doesNotMatch(source, /\*\s*\{[^}]*scrollbar-width:\s*none/);
  assert.doesNotMatch(source, /(?:^|\n)\s*\*::-webkit-scrollbar\s*\{[^}]*display:\s*none/);

  // Positive: opt-in `.scrollbar-none` utility remains for specific surfaces
  // (horizontal tab strips, etc.) that legitimately need to hide rails.
  assert.match(source, /\.scrollbar-none\s*\{[\s\S]*scrollbar-width:\s*none/);
  assert.match(source, /\.scrollbar-none::-webkit-scrollbar\s*\{[\s\S]*display:\s*none/);
});

test("Only vertical app scrollers opt into the quiet scrollbar", () => {
  const timeline = readFileSync(resolve(import.meta.dirname, "../src/components/message/MessageTimeline.tsx"), "utf8");
  const source = readFileSync(resolve(import.meta.dirname, "../src/components/layout/Sidebar.tsx"), "utf8");

  assert.match(timeline, /className="scrollbar-quiet h-full overflow-y-auto"/);
  assert.match(source, /scrollbar-quiet flex-1 overflow-x-hidden overflow-y-auto/);
  assert.doesNotMatch(timeline, /overflow-x-auto[^\n"]*scrollbar-quiet/);
  assert.doesNotMatch(source, /overflow-x-auto[^\n"]*scrollbar-quiet/);
});

test("Wiki panel scrollers opt into the shared quiet scrollbar", () => {
  // The Wiki panel shipped with no per-surface scrollbar treatment at all, so
  // every one of its scrollers fell back to the fat browser default while the
  // rest of the app used the 10px quiet rail. `.scrollbar-quiet` is opt-in —
  // there is no global rule — so a new scroller silently regresses this.
  // Counting rather than listing means adding a scroller without the class
  // fails here instead of shipping another mismatched rail.
  const wiki = readFileSync(resolve(import.meta.dirname, "../src/components/wiki/WikiPanel.tsx"), "utf8");

  const scrollers = wiki.match(/overflow-(?:y-)?auto/g) ?? [];
  const quiet = wiki.match(/scrollbar-quiet/g) ?? [];
  assert.ok(scrollers.length > 0, "expected the Wiki panel to have scroll containers");
  assert.equal(
    quiet.length,
    scrollers.length,
    `every Wiki scroll container must opt into scrollbar-quiet (${quiet.length} of ${scrollers.length} do)`,
  );
  assert.doesNotMatch(wiki, /scrollbar-width/);
  assert.doesNotMatch(wiki, /::-webkit-scrollbar/);
});

test("Scrollable list sources do not render bottom fade affordances", () => {
  const sources = [
    readFileSync(resolve(import.meta.dirname, "../src/components/layout/Sidebar.tsx"), "utf8"),
    readFileSync(resolve(import.meta.dirname, "../src/components/message/MessageTimeline.tsx"), "utf8"),
  ].join("\n");

  assert.doesNotMatch(sources, /data-testid="[^"]*scroll-fade"/);
  assert.doesNotMatch(sources, /bg-gradient-to-t from-(?:white|brutal-cream)/);
});

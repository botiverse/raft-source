/**
 * Contract test for the right-side sheet surface (task #1050).
 *
 * stdrc 2026-08-27 #proj-uiux:c50cb6c6: the chat side sheet (channel
 * settings) should read as the same surface as the sidebar. Investigation
 * showed both already share the `bg-brutal-cream` token — the perceived
 * color difference comes from two other sources:
 *
 *   1. raft-ui's Drawer renders a modal overlay (`bg-layer-backdrop`,
 *      ~60% black) over the page, dimming the sidebar while the sheet
 *      stays above it. That is intended modal drawer behavior and stays.
 *   2. The sheet carried Tailwind's `shadow-xl`, a soft blurred shadow.
 *      The design language is hard-shadow only (`--shadow-brutal*`,
 *      `--shadow-soft-popover` reserved for tiny auto-dismiss overlays),
 *      and a wide blurred band along the sheet's left edge exaggerated
 *      the boundary contrast. The full-height sheet already has a 2px
 *      black left border as its delineator, so the blur shadow is
 *      removed with no replacement.
 *
 * All three right-side sheet surfaces (the shared OverflowSheet shell and
 * both channel-settings dialogs) must stay on the same contract: cream
 * surface, hard 2px left border, no blurred shadow.
 *
 * This test fails CI if a refactor:
 *   - reintroduces a Tailwind blur shadow (shadow-sm/md/lg/xl/2xl or
 *     arbitrary shadow-[...]) on any side sheet,
 *   - changes the sheet surface off `bg-brutal-cream` (sidebar token),
 *   - drops the 2px left border that delineates the sheet edge.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const sideSheetSources = [
  "../src/components/ui/OverflowSheet.tsx",
  "../src/components/channel/EditChannelDialog.tsx",
  "../src/components/channel/LegacyEditChannelDialog.tsx",
];

const BLUR_SHADOW = /shadow-(?:sm|md|lg|xl|2xl)\b|shadow-\[/;

for (const rel of sideSheetSources) {
  test(`${rel}: side sheet stays cream, hard-bordered, blur-shadow free`, () => {
    const source = readFileSync(resolve(import.meta.dirname, rel), "utf8");

    assert.match(
      source,
      /DrawerContent[\s\S]*?bg-brutal-cream/,
      "side sheet must keep the sidebar surface token bg-brutal-cream",
    );
    assert.match(
      source,
      /DrawerContent[\s\S]*?border-l-2/,
      "side sheet must keep the 2px left border delineator",
    );
    assert.doesNotMatch(
      source,
      BLUR_SHADOW,
      "side sheet must not carry a blurred shadow — hard shadows only in this design language",
    );
  });
}

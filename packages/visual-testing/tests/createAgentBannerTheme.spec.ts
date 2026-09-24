import { expect, test } from "@playwright/test";

/**
 * The Create Agent capacity banner must follow the theme.
 *
 * Before the raft-ui swap this banner was hand-rolled from raw utilities
 * (`border-2 border-black bg-brutal-orange/20`). The `[data-theme="elegant"]`
 * patch layer in index.css targets legacy CLASSES, which those utilities are
 * not — so the banner measured IDENTICALLY in both themes while the
 * `.card-brutal` shell around it themed correctly. An elegant soft-grey rounded
 * card containing a hard black brutal banner.
 *
 * Read under BOTH themes and required to disagree, because that is the only
 * shape of assertion a hardcoded colour cannot satisfy. A single-theme
 * measurement cannot tell a literal from a token — which is exactly how the
 * `text-black/60` override on KeyValueAddButton survived a fully green suite
 * (@Dozy, PR #7010).
 *
 * Uses the real Create Agent dialog via the `dialog-capacity-banner` case.
 * Neither of this dialog's banners rendered in ANY case before that was added:
 * a surface no case renders cannot regress visibly.
 */
type Theme = "brutal" | "elegant";

const CASE = (theme: Theme) =>
  "/visual-testing.html?case=components.members.create-agent.dialog-capacity-banner" +
  (theme === "elegant" ? "&theme=elegant" : "");

async function readBanner(page: import("@playwright/test").Page, theme: Theme) {
  await page.goto(CASE(theme));
  // Wait for the DIALOG, not the banner slot. Waiting on `[data-slot="banner"]`
  // means a revert to the hand-rolled banner (a bare div with no slot) fails as
  // a bare 10s timeout, which reads as "the harness is broken" rather than "this
  // is not a raft-ui Banner". Let the assertion below say that instead.
  await page.waitForSelector('[data-testid], form', { timeout: 10_000 });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const root = document.querySelector('[data-slot="banner"]');
    const description = document.querySelector('[data-slot="banner-description"]');
    if (!root || !description) {
      // Distinguish "nothing rendered" from "rendered, but not a raft-ui Banner".
      const legacy = [...document.querySelectorAll("div")].some(
        (d) => typeof d.className === "string" && /bg-brutal-orange/.test(d.className),
      );
      return { missing: true as const, legacyBannerPresent: legacy };
    }
    const s = getComputedStyle(root);
    return {
      background: s.backgroundColor,
      borderColor: s.borderTopColor,
      borderWidth: s.borderTopWidth,
      radius: s.borderRadius,
      text: (description.textContent ?? "").trim(),
    };
  });
}

test("the capacity banner is a raft-ui Banner that follows the theme", async ({ page }) => {
  const brutal = await readBanner(page, "brutal");
  const elegant = await readBanner(page, "elegant");

  // Preconditions. Without these the inequalities below pass vacuously on a
  // banner that failed to render at all.
  for (const [theme, read] of [["brutal", brutal], ["elegant", elegant]] as const) {
    expect(read, `${theme}: the capacity banner must render`).not.toBeNull();
    expect(
      "missing" in read! ? read.legacyBannerPresent : false,
      `${theme}: found the hand-rolled banner (bg-brutal-orange) instead of a raft-ui Banner — the callsite was reverted off <Banner status=...>`,
    ).toBe(false);
    expect("missing" in read!, `${theme}: no [data-slot="banner"] rendered`).toBe(false);
  }
  expect(brutal!.text).toMatch(/agent limit reached/i);

  // `[data-slot="banner"]` only exists on raft-ui's Banner — the hand-rolled one
  // was a bare div, so reaching this point already proves the swap held.
  expect(
    elegant!.background,
    `the banner's surface must change with the theme — got ${brutal!.background} under both, which is what the hand-rolled bg-brutal-orange/20 did`,
  ).not.toBe(brutal!.background);

  // The register change, not just a tint: brutal keeps its hard 2px rule,
  // elegant drops to a soft rounded surface. The old banner kept 2px/0px in both.
  expect(brutal!.borderWidth, "brutal keeps the hard rule").toBe("2px");
  expect(
    elegant!.borderWidth === brutal!.borderWidth && elegant!.radius === brutal!.radius,
    `elegant must not inherit brutal's register — border ${elegant!.borderWidth} radius ${elegant!.radius} vs brutal ${brutal!.borderWidth}/${brutal!.radius}`,
  ).toBe(false);
});

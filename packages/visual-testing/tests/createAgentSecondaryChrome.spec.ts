import { expect, test } from "@playwright/test";

/**
 * The dialog's secondary controls must use the `outline` variant, not `default`.
 *
 * `default` resolves to `bg-layer-panel`, which is white under brutal but
 * NEAR-BLACK under elegant — so the same variant inverts register across themes
 * and renders Cancel as a solid dark button heavier than the pink primary beside
 * it. @cindyz ruled `outline` on 2026-08-29.
 *
 * This lives in the browser suite because it CANNOT be asserted in jsdom: with
 * or without a ThemeProvider, `variant="outline"` and `variant="default"`
 * produce byte-identical class strings and attributes there. The difference only
 * materialises once real CSS resolves — measured here as the computed
 * background. @Dozy's CHANGES on #7056 flagged this rule as unprotected; this is
 * the strongest form available, and its limitation is stated below.
 *
 * Hosted: NOT COVERED — the browser suite is local-only. A CI-covered version
 * would need rui to expose the variant as a data attribute rather than only
 * through resolved classes.
 */
/**
 * BOTH shells that render a secondary control.
 *
 * `dialog-no-computer` covers the no-computer shell's ✕ and Cancel. `dialog`
 * covers the regular Create Agent form, whose Cancel sits at the bottom of the
 * form and is a THIRD `outline` site. An earlier version of this spec opened
 * only the first case, so reverting just the form's Cancel to `default` left it
 * 2/2 green while the PR body claimed all three were protected (@Dozy, review of
 * H=10df1285e). Same subset-claimed-as-whole mistake as #7052's four Banner
 * sites — every site that carries the rule gets driven.
 */
const CASE = (caseId: string, theme: string) =>
  `/visual-testing.html?case=components.members.create-agent.${caseId}` +
  (theme === "elegant" ? "&theme=elegant" : "");

async function readSecondary(page: import("@playwright/test").Page, theme: string, caseId = "dialog-no-computer") {
  await page.goto(CASE(caseId, theme));
  await page.waitForSelector("button", { timeout: 10_000 });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const pick = (m: (b: HTMLButtonElement) => boolean) => {
      const el = buttons.find(m) as HTMLButtonElement | undefined;
      return el ? getComputedStyle(el).backgroundColor : null;
    };
    return {
      cancel: pick((b) => /^cancel$/i.test((b.textContent ?? "").trim())),
      close: pick((b) => /close/i.test(b.getAttribute("aria-label") ?? "")),
      primary: pick((b) => /connect a computer/i.test((b.textContent ?? "").trim())),
    };
  });
}

test("secondary controls stay light under elegant, unlike the default variant", async ({ page }) => {
  const elegant = await readSecondary(page, "elegant");

  for (const [name, value] of Object.entries(elegant)) {
    expect(value, `${name} must render`).not.toBeNull();
  }

  // The regression: `default` gives oklch(0.21 0.006 106.42) here — a solid dark
  // button. `outline` is transparent over the panel, so it reads near-white.
  for (const name of ["cancel", "close"] as const) {
    expect(
      elegant[name],
      `${name}: got ${elegant[name]}. The dark surface is the \`default\` variant, which inverts register under elegant and outweighs the primary.`,
    ).not.toBe("oklch(0.21 0.006 106.42)");
  }

  // And they must not match the primary either — a secondary that looks primary
  // is the same failure wearing a different colour.
  expect(elegant.cancel).not.toBe(elegant.primary);
  expect(elegant.close).not.toBe(elegant.primary);
});

test("brutal keeps the secondary controls light too", async ({ page }) => {
  const brutal = await readSecondary(page, "brutal");
  expect(brutal.cancel, "brutal cancel must render").not.toBeNull();
  expect(brutal.cancel).not.toBe(brutal.primary);
});

test("the regular form's Cancel is outline too, not just the no-computer shell's", async ({ page }) => {
  // The third `outline` site: the Cancel at the foot of the real Create Agent
  // form. Reverting only this one is what slipped past the previous spec.
  const elegant = await readSecondary(page, "elegant", "dialog");

  expect(elegant.cancel, "the form's Cancel must render").not.toBeNull();
  expect(
    elegant.cancel,
    `form Cancel: got ${elegant.cancel}. The dark surface is the \`default\` variant, which inverts register under elegant.`,
  ).not.toBe("oklch(0.21 0.006 106.42)");

  const brutal = await readSecondary(page, "brutal", "dialog");
  expect(brutal.cancel, "brutal form Cancel must render").not.toBeNull();
});

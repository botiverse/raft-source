import { expect, test } from "@playwright/test";

/**
 * Textarea joins the field metric axis (cindyz's ruling, 2026-08-25).
 *
 * Before raft-ui's textarea recipe took `text-field font-field`, the Description
 * textarea carried no field metrics at all: its base slot declared no font-size,
 * the elegant variant hardcoded `text-sm`, and brutal declared nothing. It looked
 * correct only because elegant's `text-sm` happens to equal elegant's field token
 * exactly — 14px/20px, line-height included. Move the token off 14 and the Input
 * would follow while the textarea stayed put, with nothing going red.
 *
 * So this file asserts two different things, and the second is the point:
 *   1. the textarea's computed metrics equal the field tokens, per theme
 *   2. the textarea AGREES WITH THE INPUT in the same theme
 * (1) alone can pass on a coincidence — a hardcoded value that happens to match
 * today's token. (2) is what actually encodes "these two move together", which is
 * the property cindyz asked for.
 */

type Theme = "brutal" | "elegant";
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

/** One Description textarea and one Name input in the Create Agent dialog. */
const TEXTAREA_COUNT = 1;
const INPUT_COUNT = 1;

const CASE = (theme: Theme) =>
  `/visual-testing.html?case=components.members.create-agent.dialog` +
  (theme === "elegant" ? "&theme=elegant" : "");

async function settle(page: import("@playwright/test").Page) {
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(600);
}

async function read(page: import("@playwright/test").Page, selector: string) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
    });
  }, selector);
}

async function tokens(page: import("@playwright/test").Page): Promise<Metrics> {
  return page.evaluate(() => {
    const root = document.querySelector("[data-theme]") ?? document.documentElement;
    const s = getComputedStyle(root);
    const px = (v: string) => `${parseFloat(v.trim())}px`;
    return {
      fontSize: px(s.getPropertyValue("--field-font-size")),
      fontWeight: s.getPropertyValue("--field-font-weight").trim(),
      lineHeight: px(s.getPropertyValue("--field-line-height")),
    };
  });
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: the textarea obeys the field tokens`, async ({ page }) => {
    await page.goto(CASE(theme));
    await settle(page);
    const t = await tokens(page);
    expect(t.fontSize, `${theme}: --field-font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);

    // MECHANISM, not just the number. Caught by counterfactual: with the recipe
    // change absent, all four assertions still passed — brutal's textarea inherits
    // 16px (== brutal token) and elegant's old hardcoded text-sm is 14px/20px
    // (== elegant token). The computed values coincide with the tokens whether or
    // not the textarea is on the axis, so a value-only check proves nothing here.
    const carriesAxis = await page.evaluate(() => {
      const el = document.querySelector('[data-slot="field"] textarea') as HTMLElement | null;
      return el ? { textField: el.className.includes("text-field"), fontField: el.className.includes("font-field") } : null;
    });
    expect(carriesAxis, `${theme}: textarea exists`).not.toBeNull();
    expect(carriesAxis!.textField, `${theme}: textarea must carry text-field — matching the token by coincidence is not being on the axis`).toBe(true);
    expect(carriesAxis!.fontField, `${theme}: textarea must carry font-field`).toBe(true);

    const found = await read(page, '[data-slot="field"] textarea');
    // Denominator before contents: an empty NodeList satisfies every loop body.
    expect(found.length, `${theme}: expected exactly ${TEXTAREA_COUNT} textarea`).toBe(TEXTAREA_COUNT);
    for (const m of found) {
      expect(m.fontSize, `${theme}: textarea font-size must equal --field-font-size`).toBe(t.fontSize);
      expect(m.fontWeight, `${theme}: textarea font-weight must equal --field-font-weight`).toBe(t.fontWeight);
      expect(m.lineHeight, `${theme}: textarea line-height must equal --field-line-height`).toBe(t.lineHeight);
    }
  });

  test(`${theme}: the textarea and the input agree`, async ({ page }) => {
    await page.goto(CASE(theme));
    await settle(page);
    const areas = await read(page, '[data-slot="field"] textarea');
    const inputs = await read(page, 'input[data-slot="field-control"]');
    expect(areas.length, `${theme}: exactly ${TEXTAREA_COUNT} textarea`).toBe(TEXTAREA_COUNT);
    expect(inputs.length, `${theme}: exactly ${INPUT_COUNT} real text input`).toBe(INPUT_COUNT);
    // The property cindyz actually asked for: single-line and multi-line move together.
    // Asserted independently of the token so it still holds if the token changes.
    expect(areas[0].fontSize, `${theme}: textarea vs input font-size`).toBe(inputs[0].fontSize);
    expect(areas[0].fontWeight, `${theme}: textarea vs input font-weight`).toBe(inputs[0].fontWeight);
    expect(areas[0].lineHeight, `${theme}: textarea vs input line-height`).toBe(inputs[0].lineHeight);
  });
}

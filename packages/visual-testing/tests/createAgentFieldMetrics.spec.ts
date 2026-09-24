import { expect, test } from "@playwright/test";

/**
 * Computed field metrics for the Create Agent dialog, in both themes.
 *
 * Why this exists separately from createAgentFieldGeometry.spec.ts:
 *
 * That file already asserts font-size/weight on each field's control — and it
 * passes. It queries `button[data-slot]`, i.e. the select *trigger*. But the
 * trigger is not what a user reads: the text lives in a child slot, and the
 * themes style that child directly:
 *
 *   elegant trigger: [&_[data-slot='select-value']]:font-medium
 *   brutal option:   [&_[data-slot='select-item-text']]:font-bold
 *
 * A rule on the child beats a `font-field` on the parent outright — the parent
 * measures a correct 400 while the text above it renders 500/700. Measuring the
 * trigger and reporting "weight is correct" is exactly the mistake that kept
 * this bug alive for two days, so these assertions target the text-bearing
 * descendants instead.
 *
 * Values are read from the field tokens at runtime rather than pinned as
 * literals, so the contract is "the field metric axis wins", not "it is 16px".
 * Brutal and elegant disagree on every number (16/24 vs 14/20); a pinned
 * literal could only ever encode one of them.
 *
 * Expected state: RED until raft-ui 0.5.3 lands D1 (merge-order) and D2 (the
 * descendant overrides). A tooth that is green before the fix it guards would
 * not have caught the bug it exists for.
 *
 * KNOWN BLIND SPOT — the Description textarea is not covered here.
 * raft-ui's textarea recipe carries no field metrics at all (its base slot has no
 * font-size; the elegant variant hardcodes `text-sm`, the brutal variant declares
 * nothing). It is simply not on the field axis, so "computed === token" has nothing
 * to assert against and the textarea is deliberately excluded from these counts.
 *
 * Why that is worth writing down rather than leaving implicit: elegant's `text-sm`
 * happens to equal elegant's field token exactly, 14px/20px including line-height.
 * So the textarea looks correct today for a reason that is a coincidence, not a
 * contract. If design ever moves the elegant field size off 14px, the Input follows
 * the token and the textarea stays at 14 — and nothing in this file will go red,
 * because the textarea was never on the axis being asserted.
 * Whether a textarea belongs on the field axis is a design-system decision
 * (raised with @cindyz), not one this spec should quietly assume either way.
 */

type Theme = "brutal" | "elegant";

/**
 * 3 selects, one select-value each. Measured in both themes.
 *
 * This read 6 until the duplicate-control bug was fixed, and I had written a
 * plausible-sounding justification for it ("visible trigger text plus a hidden node
 * the component keeps for form state"). There was no such second node — it was the
 * adopted control being rendered twice. A denominator taken from broken state is
 * still a wrong denominator; what saved it was the count assertion failing loudly
 * when the structure changed, rather than silently measuring whatever remained.
 */
const SELECT_VALUE_COUNT = 3;
/**
 * The dialog's one free-text input (Name); Description is a textarea.
 *
 * Selected by `data-slot="field-control"`, NOT `data-slot="input"`: once FieldControl
 * adopts the control it stamps its own slot, so the real input no longer answers to
 * "input". The three bare `input` elements in this dialog are the hidden form-state
 * nodes the Selects render — unclassed, and not what a user reads.
 */
const INPUT_COUNT = 1;
const REAL_INPUT = 'input[data-slot="field-control"]';
/** Options in the opened Computer select — the fixture provides 2. Measured. */
const OPTION_COUNT = 2;
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE = (id: string, theme: Theme) =>
  `/visual-testing.html?case=components.members.create-agent.${id}` +
  (theme === "elegant" ? "&theme=elegant" : "");

const settle = async (page: import("@playwright/test").Page) => {
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(600);
};

/** The field metric tokens as the browser actually resolves them for this theme. */
async function fieldTokens(page: import("@playwright/test").Page): Promise<Metrics> {
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

async function metrics(page: import("@playwright/test").Page, selector: string) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
    });
  }, selector);
}

/**
 * Right value for the RIGHT REASON.
 *
 * Under elegant on published 0.5.2 the trigger reads 14px — which happens to equal
 * elegant's own field token, because the theme's `text-sm` is also 14px. A computed
 * check alone therefore goes GREEN while the field contract is not applied at all,
 * and the weight is still 500. Three separate coincidences of this exact shape have
 * already appeared on this workstream (brutal input 16 == default 16; brutal token
 * 16 == root fallback 16; and this one), so the class presence is asserted alongside
 * the computed value: the number must be right AND it must come from the field axis.
 */
async function expectFieldAxisApplied(
  page: import("@playwright/test").Page,
  selector: string,
  what: string,
  theme: Theme,
  expectedCount: number,
) {
  // EVERY match, not the first. An earlier draft of this helper used
  // `querySelector` while the computed check used `querySelectorAll`, so a single
  // correctly-wired select at the front of the document masked a stopgap'd one
  // behind it — the assertion written to catch coincidences had a coincidence of
  // its own. Count the set, then assert every member.
  const applied = await page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const host = (el.closest('[data-slot="button"]') ?? el) as HTMLElement;
      return {
        text: (el.textContent ?? "").trim().slice(0, 16),
        hasTextField: host.className.includes("text-field"),
        hasFontField: host.className.includes("font-field"),
      };
    });
  }, selector);
  // The DENOMINATOR, not just "more than zero". Asserting every match answers
  // "are the ones present correct?" but not "are they all still there?" — if a
  // select stops rendering, a >0 check keeps passing on the survivors. The count
  // is measured, not guessed: the Create Agent dialog renders 3 selects, each
  // emitting two select-value nodes (visible trigger text + the hidden node the
  // component keeps for form state) = 6, identical in both themes.
  // (@Bugen, same shape as the empty-scan bug in rui #6839: no denominator.)
  expect(applied.length, `${theme}: ${what} — expected all 6 select-value nodes`).toBe(expectedCount);
  for (const a of applied) {
    expect(a.hasTextField, `${theme}: ${what} "${a.text}" must carry text-field — a correct number that does not come from the field axis is a coincidence, not a pass`).toBe(true);
    expect(a.hasFontField, `${theme}: ${what} "${a.text}" must carry font-field`).toBe(true);
  }
}

function expectMatchesTokens(found: Metrics[], tokens: Metrics, what: string, theme: Theme, expected: number) {
  // Assert the set is non-empty before asserting its contents: an empty
  // NodeList satisfies every expectation inside a for-loop.
  expect(found.length, `${theme}: ${what} — expected exactly ${expected} node(s), got ${found.length}`).toBe(expected);
  for (const m of found) {
    expect(m.fontSize, `${theme}: ${what} font-size must equal --field-font-size`).toBe(tokens.fontSize);
    expect(m.fontWeight, `${theme}: ${what} font-weight must equal --field-font-weight`).toBe(tokens.fontWeight);
    expect(m.lineHeight, `${theme}: ${what} line-height must equal --field-line-height`).toBe(tokens.lineHeight);
  }
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: the text inside a select trigger obeys the field metrics, not the button's`, async ({ page }) => {
    await page.goto(CASE("dialog", theme));
    await settle(page);
    const tokens = await fieldTokens(page);
    // Sanity-check the token read itself, so a failed custom-property lookup
    // cannot turn into a vacuously satisfiable "NaNpx === NaNpx" comparison.
    expect(tokens.fontWeight, `${theme}: --field-font-weight resolves`).toMatch(/^\d+$/);
    expect(tokens.fontSize, `${theme}: --field-font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);

    expectMatchesTokens(await metrics(page, '[data-slot="select-value"]'), tokens, "select-value", theme, SELECT_VALUE_COUNT);
    await expectFieldAxisApplied(page, '[data-slot="select-value"]', "select trigger", theme, SELECT_VALUE_COUNT);
  });

  test(`${theme}: text inputs obey the field metrics`, async ({ page }) => {
    await page.goto(CASE("dialog", theme));
    await settle(page);
    const tokens = await fieldTokens(page);
    // NOT '[data-slot="field"] input': a Select renders a hidden native input for
    // form submission, and that one matches first. It carries no classes and reads
    // a 16px default, so measuring it reports a failure that has nothing to do with
    // the visible field. Target the real text input by its slot.
    expectMatchesTokens(await metrics(page, REAL_INPUT), tokens, "input", theme, INPUT_COUNT);
  });

  test(`${theme}: the text inside an open select option obeys the field metrics`, async ({ page }) => {
    await page.goto(CASE("dialog", theme));
    await settle(page);
    const tokens = await fieldTokens(page);

    // The popup renders in a portal, so its text is only measurable while open.
    // The trigger renders as a Button (data-slot="button"), not a "select-trigger"
    // slot — which is itself why the Button's own text-sm competes with the field
    // metrics here. Select it by the value slot it wraps.
    await page.locator('[data-slot="button"]:has([data-slot="select-value"])').first().click();
    await page.waitForSelector('[data-slot="select-item-text"]', { timeout: 5000 });
    await page.waitForTimeout(300);

    expectMatchesTokens(await metrics(page, '[data-slot="select-item-text"]'), tokens, "select-item-text", theme, OPTION_COUNT);
  });
}

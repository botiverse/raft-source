import { expect, test } from "@playwright/test";
import { CODEX_LIVE, mockRuntimeFormsV2 } from "./runtimeFormV2Mock";

/**
 * Computed field metrics for the Create Agent dialog.
 *
 * Why this exists separately from createAgentFieldGeometry.spec.ts:
 *
 * That file already asserts font-size/weight on each field's control — and it
 * passes. It queries `button[data-slot]`, i.e. the select *trigger*. But the
 * trigger is not what a user reads: the text lives in a child slot, and a rule
 * that targets that child (`[&_[data-slot='select-value']]:font-medium`,
 * `[&_[data-slot='select-item-text']]:font-bold` — both shipped once) beats a
 * `font-field` on the parent outright: the parent measures a correct 400 while
 * the text above it renders 500/700. Measuring the trigger and reporting
 * "weight is correct" is exactly the mistake that kept this bug alive for two
 * days, so these assertions target the text-bearing descendants instead.
 *
 * Two contracts, both checked:
 *  - the field metric tokens resolve to the DS input type (TextField: 16/24 at
 *    the body weight, 400), and
 *  - every text-bearing node reads those tokens AND carries the field-axis
 *    classes, so a correct number that does not come from the axis fails.
 * Field labels read the DS label type (TextField: 13/18 600).
 *
 * Known divergence, not settled here: the DS's own Select types its trigger
 * 15/20 600 (`rf-select`) and its options 14/20 500 (`rf-menu__item`), while
 * this dialog keeps both on the field axis with its inputs. The selects below
 * are held to the field axis because that is the product's contract today;
 * which of the two moves is a design-system decision.
 *
 * The Description textarea is covered by createAgentTextareaFieldAxis.spec.ts.
 *
 * The runtime fields are the protocol v2 form (task #8), served from the real
 * Codex fixtures: Model (searchable combobox), Reasoning (select) and Fast mode
 * (a boolean option card with no field label of its own, so not counted below).
 */

type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

/** DS TextField: input text is 16/24, at the body weight. */
const RAFT_FIELD: Metrics = { fontSize: "16px", fontWeight: "400", lineHeight: "24px" };
/** DS TextField: the label is 13/18 600 (`text-footnote`). */
const RAFT_LABEL: Metrics = { fontSize: "13px", fontWeight: "600", lineHeight: "18px" };
/** DS Select / Menu: the checked option is bold (`rf-menu__item.is-checked`). */
const CHECKED_OPTION_WEIGHT = "700";

// Computer, Runtime and the v2 form's Reasoning are selects; Model is a
// searchable combobox. Pin both counts so dropping either kind cannot silently
// shrink coverage.
const SELECT_VALUE_COUNT = 3;
const MODEL_INPUT = '[data-slot="combobox-input"]';
const MODEL_INPUT_COUNT = 1;
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
/** Options in the opened Computer select — the fixture provides 2, one of them current. Measured. */
const OPTION_COUNT = 2;
/** Computer, Name, Description, Runtime, Model, Reasoning. The Fast mode option
 *  card's field renders an EMPTY label element (its title is the card's), which
 *  carries no text to measure and is excluded. */
const LABEL_COUNT = 6;

const CASE = "/visual-testing.html?case=components.members.create-agent.dialog";

const settle = async (page: import("@playwright/test").Page) => {
  await page.waitForSelector('[data-slot="field"]');
  // The v2 form renders once its admission row, form and option source loaded.
  await page.waitForSelector('[data-testid="runtime-form-v2-model"]');
  await page.waitForTimeout(600);
};

test.beforeEach(async ({ page }) => {
  await mockRuntimeFormsV2(page, [CODEX_LIVE]);
});

/** The field metric tokens as the browser actually resolves them. */
async function fieldTokens(page: import("@playwright/test").Page): Promise<Metrics> {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
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
 * A computed value can equal the token without the field contract being applied
 * at all — inherited 16px equals the 16px token, and the root fallback is 16px
 * too. Three coincidences of this exact shape appeared on this workstream, so the
 * class presence is asserted alongside the computed value: the number must be
 * right AND it must come from the field axis.
 */
async function expectFieldAxisApplied(
  page: import("@playwright/test").Page,
  selector: string,
  what: string,
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
  // Pin each expected control, not merely a non-empty set.
  expect(applied.length, `${what} — expected exactly ${expectedCount} text node(s)`).toBe(expectedCount);
  for (const a of applied) {
    expect(a.hasTextField, `${what} "${a.text}" must carry text-field — a correct number that does not come from the field axis is a coincidence, not a pass`).toBe(true);
    expect(a.hasFontField, `${what} "${a.text}" must carry font-field`).toBe(true);
  }
}

function expectMatchesTokens(found: Metrics[], tokens: Metrics, what: string, expected: number) {
  // Assert the set is non-empty before asserting its contents: an empty
  // NodeList satisfies every expectation inside a for-loop.
  expect(found.length, `${what} — expected exactly ${expected} node(s), got ${found.length}`).toBe(expected);
  for (const m of found) {
    expect(m.fontSize, `${what} font-size must equal --field-font-size`).toBe(tokens.fontSize);
    expect(m.fontWeight, `${what} font-weight must equal --field-font-weight`).toBe(tokens.fontWeight);
    expect(m.lineHeight, `${what} line-height must equal --field-line-height`).toBe(tokens.lineHeight);
  }
}

/** Read the tokens and hold them to the DS before anything is compared with them. */
async function raftFieldTokens(page: import("@playwright/test").Page): Promise<Metrics> {
  const tokens = await fieldTokens(page);
  // Also guards the read itself: a failed custom-property lookup cannot turn
  // into a vacuously satisfiable "NaNpx === NaNpx" comparison.
  expect(tokens, "the field axis resolves to the DS input type, 16/24 400").toEqual(RAFT_FIELD);
  return tokens;
}

test("select and model-combobox text obey the field metrics", async ({ page }) => {
  await page.goto(CASE);
  await settle(page);
  const tokens = await raftFieldTokens(page);

  expectMatchesTokens(await metrics(page, '[data-slot="select-value"]'), tokens, "select-value", SELECT_VALUE_COUNT);
  await expectFieldAxisApplied(page, '[data-slot="select-value"]', "select trigger", SELECT_VALUE_COUNT);
  expectMatchesTokens(await metrics(page, MODEL_INPUT), tokens, "model combobox input", MODEL_INPUT_COUNT);
  await expectFieldAxisApplied(page, MODEL_INPUT, "model combobox input", MODEL_INPUT_COUNT);
});

test("text inputs obey the field metrics", async ({ page }) => {
  await page.goto(CASE);
  await settle(page);
  const tokens = await raftFieldTokens(page);
  // NOT '[data-slot="field"] input': a Select renders a hidden native input for
  // form submission, and that one matches first. It carries no classes and reads
  // a 16px default, so measuring it reports a failure that has nothing to do with
  // the visible field. Target the real text input by its slot.
  expectMatchesTokens(await metrics(page, REAL_INPUT), tokens, "input", INPUT_COUNT);
});

test("field labels read the DS label type", async ({ page }) => {
  await page.goto(CASE);
  await settle(page);
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="field-label"]')]
      .filter((el) => (el.textContent ?? "").trim() !== "")
      .map((el) => {
        const s = getComputedStyle(el);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
      }));
  expect(labels.length, `expected exactly ${LABEL_COUNT} field labels`).toBe(LABEL_COUNT);
  for (const m of labels) expect(m, "label 13/18 600").toEqual(RAFT_LABEL);
});

test("the text inside an open select option obeys the field metrics", async ({ page }) => {
  await page.goto(CASE);
  await settle(page);
  const tokens = await raftFieldTokens(page);

  // The popup renders in a portal, so its text is only measurable while open.
  // The trigger renders as a Button (data-slot="button"), not a "select-trigger"
  // slot — which is itself why the Button's own type competes with the field
  // metrics here. Select it by the value slot it wraps.
  await page.locator('[data-slot="button"]:has([data-slot="select-value"])').first().click();
  await page.waitForSelector('[data-slot="select-item-text"]', { timeout: 5000 });
  await page.waitForTimeout(300);

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="select-item-text"]')].map((el) => {
      const s = getComputedStyle(el);
      const item = el.closest('[role="option"]');
      return {
        text: (el.textContent ?? "").trim().slice(0, 24),
        checked: item?.getAttribute("aria-selected") === "true" || item?.hasAttribute("data-selected") === true,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
      };
    }));

  // Denominator first, then exactly one current value: the bold below is the
  // DS's mark for it, and it must not spread to every option.
  expect(options.length, `expected exactly ${OPTION_COUNT} options`).toBe(OPTION_COUNT);
  expect(options.filter((o) => o.checked).length, "exactly one option is the current value").toBe(1);
  for (const o of options) {
    expect(o.fontSize, `"${o.text}" font-size must equal --field-font-size`).toBe(tokens.fontSize);
    expect(o.lineHeight, `"${o.text}" line-height must equal --field-line-height`).toBe(tokens.lineHeight);
    expect(
      o.fontWeight,
      o.checked
        ? `"${o.text}" is the current value — the DS marks it bold`
        : `"${o.text}" font-weight must equal --field-font-weight — a rule that bolds every option is the regression`,
    ).toBe(o.checked ? CHECKED_OPTION_WEIGHT : tokens.fontWeight);
  }
});

import { expect, test } from "@playwright/test";
import { CODEX_LIVE, mockRuntimeFormsV2 } from "./runtimeFormV2Mock";

/**
 * Browser-level field contract for the Create Agent dialog.
 *
 * These assertions live here rather than beside the jsdom contract tests
 * because jsdom performs no layout: every height and gap reads 0 there, so the
 * same assertions would pass without ever exercising anything. Geometry has to
 * be measured in a real engine or not claimed at all.
 *
 * What is pinned:
 *  - field-to-field spacing is uniform, whatever each field's internal shape
 *  - the dialog's height does not change when a message appears, which is the
 *    property the reserved message row exists to provide
 *  - selects and inputs share one field contract, so a select does not render
 *    with button type (15/20 700) next to an input (44px, DS input text 16/24
 *    400). The DS's own Select is 44px too but types its value 15/20 600
 *    (`rf-select`); this dialog keeps selects on the input's type — a known
 *    divergence for the DS to settle, see createAgentFieldMetrics.spec.ts.
 *
 * The runtime fields are the protocol v2 form (task #8: the only runtime form),
 * served from the real Codex fixtures. On this case that form renders, after
 * Computer / Name / Description / Runtime: Model (searchable combobox),
 * Reasoning (select) and Fast mode — a boolean OPTION CARD in a field with no
 * label of its own. The card is neither a single-line control nor labelled by
 * the field, so the label-anchored measurements below cover the six labelled
 * fields and pin the card separately rather than letting it shrink or skew the
 * set.
 */

const CASE = (id: string) => `/visual-testing.html?case=components.members.create-agent.${id}`;
const settle = async (page: import("@playwright/test").Page) => {
  await page.waitForSelector('[data-slot="field"]');
  // The v2 form renders only once its admission row, form and option source have
  // loaded; the Model field is its first field.
  await page.waitForSelector('[data-testid="runtime-form-v2-model"]');
  await page.waitForTimeout(600);
};

/** Computer, Name, Description, Runtime, Model, Reasoning. */
const LABELLED_FIELD_COUNT = 6;
/** Fast mode: the codex form's one boolean, an option card without a field label. */
const OPTION_CARD_FIELD_COUNT = 1;

test.beforeEach(async ({ page }) => {
  await mockRuntimeFormsV2(page, [CODEX_LIVE]);
});

/**
 * The gap a user actually perceives: from the bottom of one field's control to
 * the top of the next field's label.
 *
 * Deliberately NOT field-box to field-box. That reads 16px even when a field's
 * own content pushes the next one down, so it stays green for exactly the
 * failure being guarded against — verified by mutation: putting the counter
 * back as a loose row inside the field left a box-to-box assertion passing.
 */
async function fieldGaps(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    // Labelled fields only: the boolean option card has an empty label element
    // and is pinned by its own test below.
    const fields = [...document.querySelectorAll('[data-slot="field"]')]
      .filter((f) => (f.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim() !== "");
    const gaps: number[] = [];
    for (let i = 1; i < fields.length; i++) {
      // A searchable model field has a padded outer control around its input.
      // Spacing follows that visible border, not the inner text line.
      const prevControl = fields[i - 1].querySelector('[data-slot="combobox-control"]')
        ?? [...fields[i - 1].querySelectorAll("input,textarea,button[data-slot]")]
          .find((el) => !el.closest('[data-slot="field-label-accessory"]'));
      const nextLabel = fields[i].querySelector('[data-slot="field-label"]');
      if (!prevControl || !nextLabel) continue;
      const a = prevControl.getBoundingClientRect();
      const z = nextLabel.getBoundingClientRect();
      // The reserved message row is one line; a field's own hint may wrap (the
      // v2 Model hint is two lines at 390px). Those extra lines are that field's
      // content, not spacing, so they are taken out — only them: a loose row
      // outside the message row (the old counter bug) still shows as a gap.
      const row = fields[i - 1].querySelector('[data-slot="field-description"]');
      const wrapped = row
        ? Math.max(0, row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).lineHeight))
        : 0;
      if (z.top >= a.bottom - 1) gaps.push(Math.round(z.top - a.bottom - wrapped));
    }
    return gaps;
  });
}

const dialogHeight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Math.round(document.querySelector('[data-testid="create-agent-dialog"]')?.getBoundingClientRect().height ?? 0));

test("field spacing is uniform regardless of a field's internal shape", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const gaps = await fieldGaps(page);
  // Exact, not a lower bound: `toBeGreaterThan` cannot tell "a field disappeared"
  // from "all fields present". 6 labelled fields => 5 gaps, all measured on this case.
  expect(gaps.length, "every field pair is measured; a missing field must fail here").toBe(LABELLED_FIELD_COUNT - 1);
  // The Description field carries a character counter and the others do not;
  // before the reserved row, that alone made its gap 36 where the rest were 16.
  expect(new Set(gaps).size, `gaps should all be equal, got ${gaps.join("/")}`).toBe(1);
  // The field gap plus the reserved message row each field carries; the exact
  // number is createAgentFieldSpacing.spec.ts's.
  expect(gaps[0]).toBeGreaterThan(0);
});

test("the dialog does not change height when a message appears", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const normal = await dialogHeight(page);

  await page.goto(CASE("dialog-error"));
  await settle(page);
  const errored = await dialogHeight(page);

  expect(normal).toBeGreaterThan(0);
  expect(errored, "an inline error must not move the dialog").toBe(normal);
  const erroredGaps = await fieldGaps(page);
  expect(new Set(erroredGaps).size, `spacing stays uniform in error, got ${erroredGaps.join("/")}`).toBe(1);
});

test("selects and inputs share one field contract, not button metrics", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const metrics = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="field"]')]
      .filter((f) => (f.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim() !== "")
      .map((f) => {
      // The field's control, not an action in the label row (refresh, edit, random name).
      const c = ([...f.querySelectorAll("input,textarea,button[data-slot]")]
        .find((el) => !el.closest('[data-slot="field-label-accessory"]')) ?? null) as HTMLElement | null;
      if (!c) return null;
      const frame = c.closest('[data-slot="combobox-control"]') ?? c;
      const s = getComputedStyle(c);
      return { tag: c.tagName.toLowerCase(), h: Math.round(frame.getBoundingClientRect().height), fs: s.fontSize, fw: s.fontWeight };
    }).filter(Boolean),
  );
  // Measure the combobox border for height, but its actual input for text.
  // Reading both from the wrapper could mask incorrectly styled inner text.
  // The textarea is intentionally taller; every single-line control matches.
  const singleLine = metrics.filter((m) => m!.tag !== "textarea");
  // Guard the loop itself: iterating an empty array passes every expect inside
  // it, so the count is asserted before the contents are (@Bugen).
  // Computer, Name, Runtime, Model (combobox), Reasoning.
  expect(singleLine.length, "single-line controls were actually found and measured").toBe(5);
  for (const m of singleLine) {
    expect(m!.h, `${m!.tag} height`).toBe(44);
    expect(m!.fs, `${m!.tag} font-size`).toBe("16px");
    expect(m!.fw, `${m!.tag} font-weight — a filled select must not render bold`).toBe("400");
  }
});

test("every field's control is wired for assistive technology", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const wiring = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="field"]')]
      .filter((f) => (f.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim() !== "")
      .map((f) => {
      const label = f.querySelector('[data-slot="field-label"]');
      // The field's control, not an action in the label row (refresh, edit, random name).
      const c = ([...f.querySelectorAll("input,textarea,button[data-slot]")]
        .find((el) => !el.closest('[data-slot="field-label-accessory"]')) ?? null) as HTMLElement | null;
      return {
        field: (label?.textContent ?? "").trim().slice(0, 16),
        id: Boolean(c?.id),
        describedBy: Boolean(c?.getAttribute("aria-describedby")),
      };
    }),
  );
  // Same reason: pin the field count so a field vanishing fails loudly rather
  // than shrinking the set this loop iterates over.
  expect(wiring.length, `all ${LABELLED_FIELD_COUNT} labelled fields are present and checked`).toBe(LABELLED_FIELD_COUNT);
  for (const w of wiring) {
    expect(w.id, `${w.field}: control has an id`).toBe(true);
    expect(w.describedBy, `${w.field}: control points at its message row`).toBe(true);
  }

  // The option card has no field label: its checkbox is named by the card's
  // title instead. Pinned, so the card cannot vanish from the count above
  // unnoticed, and so it is not an unnamed control.
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="field"]')]
      .filter((f) => (f.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim() === "")
      .map((f) => {
        const box = f.querySelector('[data-slot="checkbox"]');
        const named = box?.getAttribute("aria-labelledby");
        return { id: Boolean(box?.id), name: named ? (document.getElementById(named)?.textContent ?? "").trim() : "" };
      }));
  expect(cards.length, "the Fast mode option card is present").toBe(OPTION_CARD_FIELD_COUNT);
  for (const c of cards) {
    expect(c.id, "the option card's checkbox has an id").toBe(true);
    expect(c.name, "the option card's checkbox is named by its title").toBe("Fast mode");
  }
});

test("a long value does not break spacing or the dialog's height", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const before = await dialogHeight(page);

  // Type a description long enough to wrap several times.
  const textarea = page.locator("textarea").first();
  await textarea.fill("这是一段很长的中文描述，用来验证换行之后字段间距与对话框高度是否仍然稳定。".repeat(4));
  await page.waitForTimeout(400);

  const gaps = await fieldGaps(page);
  expect(new Set(gaps).size, `gaps stay uniform, got ${gaps.join("/")}`).toBe(1);
  // The dialog may grow with the textarea's own content; what must NOT happen is
  // the gaps drifting apart, which is what a non-reserved helper row caused.
  expect(await dialogHeight(page)).toBeGreaterThanOrEqual(before);
});

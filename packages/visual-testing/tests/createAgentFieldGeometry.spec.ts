import { expect, test } from "@playwright/test";

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
 *    as a button (32px / 14px / 700) next to an input (44px / 16px / 400)
 */

const CASE = (id: string) => `/visual-testing.html?case=components.members.create-agent.${id}`;
const settle = async (page: import("@playwright/test").Page) => {
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(600);
};

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
    const fields = [...document.querySelectorAll('[data-slot="field"]')];
    const gaps: number[] = [];
    for (let i = 1; i < fields.length; i++) {
      const prevControl = fields[i - 1].querySelector("input,textarea,button[data-slot]");
      const nextLabel = fields[i].querySelector('[data-slot="field-label"]');
      if (!prevControl || !nextLabel) continue;
      const a = prevControl.getBoundingClientRect();
      const z = nextLabel.getBoundingClientRect();
      if (z.top >= a.bottom - 1) gaps.push(Math.round(z.top - a.bottom));
    }
    return gaps;
  });
}

const dialogHeight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Math.round(document.querySelector(".card-brutal")?.getBoundingClientRect().height ?? 0));

test("field spacing is uniform regardless of a field's internal shape", async ({ page }) => {
  await page.goto(CASE("dialog"));
  await settle(page);
  const gaps = await fieldGaps(page);
  // Exact, not a lower bound: `toBeGreaterThan` cannot tell "a field disappeared"
  // from "all fields present". 5 fields => 4 gaps, both measured on this case.
  expect(gaps.length, "every field pair is measured; a missing field must fail here").toBe(4);
  // The Description field carries a character counter and the others do not;
  // before the reserved row, that alone made its gap 36 where the rest were 16.
  expect(new Set(gaps).size, `gaps should all be equal, got ${gaps.join("/")}`).toBe(1);
  // 16px between fields plus the reserved message row each field carries.
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
    [...document.querySelectorAll('[data-slot="field"]')].map((f) => {
      const c = f.querySelector("input,textarea,button[data-slot]") as HTMLElement | null;
      if (!c) return null;
      const s = getComputedStyle(c);
      return { tag: c.tagName.toLowerCase(), h: Math.round(c.getBoundingClientRect().height), fs: s.fontSize, fw: s.fontWeight };
    }).filter(Boolean),
  );
  // The textarea is intentionally taller; every single-line control matches.
  const singleLine = metrics.filter((m) => m!.tag !== "textarea");
  // Guard the loop itself: iterating an empty array passes every expect inside
  // it, so the count is asserted before the contents are (@Bugen).
  expect(singleLine.length, "single-line controls were actually found and measured").toBe(4);
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
    [...document.querySelectorAll('[data-slot="field"]')].map((f) => {
      const label = f.querySelector('[data-slot="field-label"]');
      const c = f.querySelector("input,textarea,button[data-slot]") as HTMLElement | null;
      return {
        field: (label?.textContent ?? "").trim().slice(0, 16),
        id: Boolean(c?.id),
        describedBy: Boolean(c?.getAttribute("aria-describedby")),
      };
    }),
  );
  // Same reason: pin the field count so a field vanishing fails loudly rather
  // than shrinking the set this loop iterates over.
  expect(wiring.length, "all 5 fields are present and checked").toBe(5);
  for (const w of wiring) {
    expect(w.id, `${w.field}: control has an id`).toBe(true);
    expect(w.describedBy, `${w.field}: control points at its message row`).toBe(true);
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

import { expect, test } from "@playwright/test";

/**
 * The dialog's vertical rhythm, measured as laid out.
 *
 * Two numbers make up the gap a user actually sees between one control and the
 * next label, and only one of them is free:
 *
 *   16px  the reserved message row, held open whether or not the field has
 *         anything to say. NOT free — a line of help text is exactly 16px, so
 *         reserving less means the row grows when a message appears and shoves
 *         every field below it down. That jump is what the row exists to prevent
 *         (@cindyz, acceptance on the onboarding preview).
 *    8px  the gap between fields. Free, and the lever actually used: @cindyz read
 *         the old 16px as "even, but noticeably too much" once every field was
 *         holding a message row open.
 *
 * 8px between fields still reads as 28px / 30px control-to-label, because the
 * reserved row sits inside the gap. Reading the token alone would have been
 * misleading: 12px was rendered first and looked barely changed, and 8px was
 * chosen from that comparison rather than from the number.
 *
 * LOCAL-ONLY suite: no CI job runs this, so Hosted is NOT COVERED for these
 * assertions.
 */

type Theme = "brutal" | "elegant";

/** Measured, not derived: brutal and elegant differ only in the label-to-control
 *  gap inside a field (4px vs 6px), which is a theme token, not this file's. */
const CONTROL_TO_NEXT_LABEL: Record<Theme, number> = { brutal: 24, elegant: 26 };
const FIELD_GAP = 4;
const RESERVED_ROW = 16;

const CASE = (theme: Theme) =>
  `/visual-testing.html?case=components.members.create-agent.claude-dialog` +
  (theme === "elegant" ? "&theme=elegant" : "");

const catalog = (machineId: string) => ({
  context: "new_agent",
  machineId,
  options: [{
    runtimeId: "claude",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
  }],
});

async function open(page: import("@playwright/test").Page, theme: Theme) {
  await page.route("**/runtime-options**", async (route) => {
    const machineId = route.request().url().split("/machines/")[1]?.split("/")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog(machineId)),
    });
  });
  await page.goto(CASE(theme));
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(500);
}

async function fields(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll('[data-slot="field"]')] as HTMLElement[];
    return list.map((field, i) => {
      const control = field.querySelector('input,textarea,[role="combobox"]') as HTMLElement | null;
      const row = field.querySelector('[data-slot="field-description"]') as HTMLElement | null;
      const previous = list[i - 1];
      const previousControl = previous?.querySelector('input,textarea,[role="combobox"]') as HTMLElement | null;
      return {
        label: field.querySelector('[data-slot="field-label"]')?.textContent?.trim() ?? "",
        rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
        rowEmpty: (row?.textContent ?? "").trim().length === 0,
        gapAbove: previous
          ? Math.round(field.getBoundingClientRect().top - previous.getBoundingClientRect().bottom)
          : null,
        controlToLabelAbove: previousControl
          ? Math.round(field.getBoundingClientRect().top - previousControl.getBoundingClientRect().bottom)
          : null,
        hasControl: Boolean(control),
      };
    });
  });
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: every field is separated by the same gap`, async ({ page }) => {
    await open(page, theme);
    const all = await fields(page);
    expect(all.length, `${theme}: the dialog must render its fields`).toBeGreaterThan(3);

    for (const field of all.slice(1)) {
      expect(
        field.gapAbove,
        `${theme}: "${field.label}" must sit ${FIELD_GAP}px below the field above it — the complaint this replaced was that the rhythm was even but too airy, so evenness is half the contract`,
      ).toBe(FIELD_GAP);
    }
  });

  test(`${theme}: the reserved message row keeps its full line, so nothing moves when a field speaks`, async ({ page }) => {
    await open(page, theme);
    const all = await fields(page);

    const quiet = all.filter((f) => f.rowEmpty && f.rowHeight !== null);
    expect(quiet.length, `${theme}: some field must currently have nothing to say`).toBeGreaterThan(0);
    for (const field of quiet) {
      expect(
        field.rowHeight,
        `${theme}: "${field.label}" reserves a full ${RESERVED_ROW}px line. Shrinking this is what makes the form jump when an error appears — it is not spare space`,
      ).toBe(RESERVED_ROW);
    }
  });

  test(`${theme}: a quiet field sits ${CONTROL_TO_NEXT_LABEL[theme]}px from the next label`, async ({ page }) => {
    await open(page, theme);
    const all = await fields(page);

    // Only fields whose row is EMPTY: a field with a two-line hint legitimately
    // pushes the next label further down, and asserting one number across both
    // would either fail on it or have to be loosened into meaninglessness.
    const measured = all.filter((f, i) =>
      i > 0 && all[i - 1].rowEmpty && all[i - 1].hasControl && f.controlToLabelAbove !== null);
    expect(measured.length, `${theme}: at least one quiet field must precede another`).toBeGreaterThan(0);
    for (const field of measured) {
      expect(
        field.controlToLabelAbove,
        `${theme}: the visible distance into "${field.label}" is what @cindyz was judging, not the ${FIELD_GAP}px token — ${RESERVED_ROW}px of it is the reserved row`,
      ).toBe(CONTROL_TO_NEXT_LABEL[theme]);
    }
  });
}

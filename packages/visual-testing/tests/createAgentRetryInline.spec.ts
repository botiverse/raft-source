import { expect, test } from "@playwright/test";

/**
 * The model-source status and its retry action, measured as LAID OUT.
 *
 * Two rounds of this were fixed by inspection and still shipped wrong. First the
 * action carried a control size (`h-7`, `px-2.5`) and sat under the sentence as a
 * button-shaped block. That was corrected — `size="inline"`, no padding, rendered
 * inside the paragraph — and every assertion we had went green, because they all
 * measured CLASSES and DOM POSITION. None measured geometry, so nobody noticed
 * that the English sentence filled the line exactly and pushed `Retry` onto a row
 * of its own anyway: structurally inline, visually a second line
 * (@cindyz on the real preview; @Dozy measured it, task #25).
 *
 * Class and structure assertions cannot see this. Only line boxes can, which is
 * why this file exists and why it lives in the browser suite.
 *
 * KNOWN BOUNDARY, and it is a real one: this suite is LOCAL-ONLY. No CI job runs
 * it, so Hosted is NOT COVERED for these assertions. That is precisely how the
 * defect above survived — do not read a green run here as a Hosted guarantee.
 */

type Theme = "brutal" | "elegant";

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

/** A retryable failure is the only state that renders the action at all. */
async function primeRetryState(page: import("@playwright/test").Page) {
  await page.route("**/runtime-options**", async (route) => {
    const machineId = route.request().url().split("/machines/")[1]?.split("/")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog(machineId)),
    });
  });
  await page.route("**/runtime-models/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ kind: "error", retryable: true }),
    });
  });
}

/**
 * Line boxes, not bounding boxes.
 *
 * A wrapped paragraph's bounding box spans every line, so "is the button inside
 * the paragraph" is true even when the button sits alone on the last row — which
 * is the exact bug. `Range.getClientRects()` returns one rect per rendered LINE,
 * so the last of them is the line the sentence actually ends on.
 */
async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const status = document.querySelector('[data-testid="runtime-model-source-status"]') as HTMLElement;
    const paragraph = status.querySelector("p") as HTMLElement;
    const action = status.querySelector("button") as HTMLElement;
    const range = document.createRange();
    const sentence = [...paragraph.childNodes]
      .find((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim());
    range.selectNodeContents(sentence as Node);
    const lines = [...range.getClientRects()];
    const lastLine = lines[lines.length - 1];
    const box = action.getBoundingClientRect();
    return {
      lineCount: lines.length,
      // Vertical overlap with the sentence's FINAL line: the action shares that
      // row rather than starting a new one.
      sharesLastLine: box.top < lastLine.bottom && box.bottom > lastLine.top,
      overflow: Math.round(status.scrollWidth - status.clientWidth),
      text: (paragraph.textContent ?? "").trim(),
    };
  });
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: the status sentence and its retry action occupy ONE line`, async ({ page }) => {
    await primeRetryState(page);
    await page.goto(CASE(theme));
    await page.waitForSelector('[data-testid="runtime-model-source-status"]', { timeout: 10_000 });
    await page.waitForTimeout(400);

    const m = await measure(page);
    expect(m.text, `${theme}: the action must render beside the message`).toContain("Retry");
    expect(
      m.lineCount,
      `${theme}: at the dialog's own width the message must fit one line, leaving room for the action — it read "${m.text}"`,
    ).toBe(1);
    expect(
      m.sharesLastLine,
      `${theme}: the action must sit ON that line, not below it`,
    ).toBe(true);
  });

  test(`${theme}: narrower than the dialog, the message wraps rather than overflowing — and the action is still not orphaned`, async ({ page }) => {
    // Mahua's condition on the fix: shortening the copy must not be paid for with
    // `nowrap`, which would trade a wrapped line for a clipped one. So the
    // narrow case asserts the opposite property — text is ALLOWED to wrap here —
    // and that the action still shares a row with words rather than standing
    // alone, which is the thing that looked broken in the first place.
    await page.setViewportSize({ width: 300, height: 844 });
    await primeRetryState(page);
    await page.goto(CASE(theme));
    await page.waitForSelector('[data-testid="runtime-model-source-status"]', { timeout: 10_000 });
    await page.waitForTimeout(400);

    const m = await measure(page);
    expect(m.lineCount, `${theme}: the message must be free to wrap when it no longer fits`).toBeGreaterThan(1);
    expect(m.overflow, `${theme}: wrapping, not horizontal overflow — a clipped message is worse than a wrapped one`).toBe(0);
    expect(m.sharesLastLine, `${theme}: even wrapped, the action shares a line with text`).toBe(true);
  });
}

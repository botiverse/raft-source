import { expect, test } from "@playwright/test";
import { CLAUDE_LIVE, CODEX_LIVE, mockRuntimeFormsV2, runtimeFormFixture } from "./runtimeFormV2Mock";

/**
 * The model-source status and its retry action, measured as LAID OUT.
 *
 * Two rounds of this were fixed by inspection and still shipped wrong. First the
 * action carried a control size (`h-7`, `px-2.5`) and sat under the sentence as a
 * button-shaped block. That was corrected — an inline link, no padding, rendered
 * inside the paragraph — and every assertion we had went green, because they all
 * measured CLASSES and DOM POSITION. None measured geometry, so nobody noticed
 * that the English sentence filled the line exactly and pushed `Retry` onto a row
 * of its own anyway: structurally inline, visually a second line
 * (@cindyz on the real preview; @Dozy measured it, task #25).
 *
 * Class and structure assertions cannot see this. Only line boxes can, which is
 * why this file exists and why it lives in the browser suite.
 *
 * Visual browser CI now covers these assertions on selected staging pushes
 * and daily runs. Ordinary PR checks still do not exercise this browser suite.
 */

/**
 * The protocol v2 form (task #8) reports a non-live option source on its field:
 * `runtime-form-v2-<key>-status`, with an inline Retry when the server says
 * retrying may help. The v1 model-source error (`kind: "error", retryable`) maps
 * to a v2 source that is `unavailable` and `retryable` — the real Codex fixture
 * for exactly that state (the Computer is offline) is served on the default
 * dialog case.
 */
const CASE = "/visual-testing.html?case=components.members.create-agent.dialog";
const STATUS = '[data-testid="runtime-form-v2-model-status"]';

/** A retryable failure is the only state that renders the action at all. */
async function primeRetryState(page: import("@playwright/test").Page) {
  await mockRuntimeFormsV2(page, [{
    ...CODEX_LIVE,
    sources: { model: runtimeFormFixture("codex.option-source.unavailable.json") },
  }]);
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
    const status = document.querySelector('[data-testid="runtime-form-v2-model-status"]') as HTMLElement;
    const paragraph = status.querySelector("p") as HTMLElement;
    const action = status.querySelector('[data-testid="runtime-form-v2-model-retry"]') as HTMLElement;
    // The sentence runs from the paragraph's start up to the action. Its last
    // word shares a no-break span with the action, so the sentence is several
    // nodes; one rect per line per node comes back, grouped here by line top.
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEndBefore(action);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
    const lines = [...new Map(rects.map((rect) => [Math.round(rect.top), rect])).values()]
      .sort((a, b) => a.top - b.top);
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

test(`the status sentence and its retry action occupy ONE line`, async ({ page }) => {
  await primeRetryState(page);
  await page.goto(CASE);
  await page.waitForSelector(STATUS, { timeout: 10_000 });
  await page.waitForTimeout(400);

  const m = await measure(page);
  expect(m.text, `the action must render beside the message`).toContain("Retry");
  expect(
    m.lineCount,
    `at the dialog's own width the message must fit one line, leaving room for the action — it read "${m.text}"`,
  ).toBe(1);
  expect(
    m.sharesLastLine,
    `the action must sit ON that line, not below it`,
  ).toBe(true);
});

test(`narrower than the dialog, the message wraps rather than overflowing — and the action is still not orphaned`, async ({ page }) => {
  // Mahua's condition on the fix: shortening the copy must not be paid for with
  // `nowrap`, which would trade a wrapped line for a clipped one. So the
  // narrow case asserts the opposite property — text is ALLOWED to wrap here —
  // and that the action still shares a row with words rather than standing
  // alone, which is the thing that looked broken in the first place.
  await page.setViewportSize({ width: 300, height: 844 });
  await primeRetryState(page);
  await page.goto(CASE);
  await page.waitForSelector(STATUS, { timeout: 10_000 });
  await page.waitForTimeout(400);

  // Below 768px the dialog is full screen (#10685), so at any phone width the
  // English sentence and its action fit one line again and the viewport alone
  // can no longer make the status narrower than its content. Squeeze the status
  // itself to ~60% of what the sentence plus action need on one line, so the
  // wrap path is still exercised (other locales and large text sizes hit it).
  await page.evaluate(() => document.fonts.ready);
  const oneLine = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="runtime-form-v2-model-status"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(status.querySelector("p") as HTMLElement);
    // The laid-out width of the words and the action, not of the block box.
    return Math.ceil(range.getBoundingClientRect().width);
  });
  await page.addStyleTag({
    content: `[data-testid="runtime-form-v2-model-status"] { max-width: ${Math.floor(oneLine * 0.6)}px; }`,
  });
  await page.waitForTimeout(100);

  const m = await measure(page);
  expect(m.lineCount, `the message must be free to wrap when it no longer fits`).toBeGreaterThan(1);
  expect(m.overflow, `wrapping, not horizontal overflow — a clipped message is worse than a wrapped one`).toBe(0);
  expect(m.sharesLastLine, `even wrapped, the action shares a line with text`).toBe(true);
});

test(`a fallback list's longer status may wrap at the dialog's width, but the action is never orphaned`, async ({ page }) => {
  // The other retryable v2 state: the Computer did not answer, so the form shows
  // the standard list and says so (real Claude fixture: machine_offline,
  // fallback, retryable). Its sentence is two clauses and does not fit one line
  // at 390px, so only the property that matters is held: wrapping, not
  // overflow, and Retry shares its line with words.
  await mockRuntimeFormsV2(page, [{
    ...CLAUDE_LIVE,
    sources: { ...CLAUDE_LIVE.sources, model: runtimeFormFixture("claude.option-source.fallback.json") },
  }]);
  await page.goto("/visual-testing.html?case=components.members.create-agent.claude-dialog");
  await page.waitForSelector(STATUS, { timeout: 10_000 });
  await page.waitForTimeout(400);

  const m = await measure(page);
  expect(m.text, `the fallback sentence and its action render`).toContain("standard list");
  expect(m.text).toContain("Retry");
  expect(m.overflow, `wrapping, not horizontal overflow`).toBe(0);
  expect(m.sharesLastLine, `the action shares a line with text`).toBe(true);
});

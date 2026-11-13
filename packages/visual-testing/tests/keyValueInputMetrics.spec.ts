import { expect, test } from "@playwright/test";
import { builtinSources, mockRuntimeFormsV2, runtimeFormFixture } from "./runtimeFormV2Mock";

/**
 * Key/value rows are shared by RuntimeConfigFields (env vars) and AgentMcpTab
 * (credential headers).  The real Agent Details runtime editor gives us the
 * former consumer with persisted rows; measure the actual text-bearing inputs
 * so a button/input stopgap cannot hide a typography regression. They are
 * inputs, so they read the DS input type (TextField: 16/24, weight 400).
 */
type Mode = "light" | "dark";
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

/** DS TextField: input text is 16/24, at the body weight. */
const RAFT_FIELD: Metrics = { fontSize: "16px", fontWeight: "400", lineHeight: "24px" };

// The visual host reads its mode from `?theme=dark` and renders light
// otherwise (requestedMode in packages/web/visual-testing/VisualTestingCases.tsx).
const CASE = (mode: Mode) =>
  `/visual-testing.html?case=screens.members.agent-detail.runtime-connection` +
  (mode === "dark" ? "&theme=dark" : "");

/**
 * The runtime editor renders only the server-described v2 form (runtime form v1
 * went in #11812), so the case's Built-in agent needs its edit form served: the
 * real builtin.edit.json fixture, with one saved variable so the env-var rows
 * (the key/value consumer measured here) exist. Its envVars field sits in the
 * collapsed Advanced section, opened below.
 */
async function primeForm(page: import("@playwright/test").Page) {
  const edit = runtimeFormFixture("builtin.edit.json") as { values: Record<string, unknown> };
  edit.values = { ...edit.values, envVars: { OPENAI_LOG: "debug" } };
  await mockRuntimeFormsV2(page, [{ runtimeId: "builtin", current: true, edit, sources: builtinSources() }]);
}

async function openRows(page: import("@playwright/test").Page, mode: Mode) {
  await primeForm(page);
  await page.goto(CASE(mode));
  await page.getByRole("button", { name: "Edit runtime config" }).click({ timeout: 10_000 });
  // Agent Details uses an inline editor surface (not an ARIA dialog).  Readiness
  // is the editor's real combobox, matching the existing provider-connection
  // metrics spec; waiting for role=dialog makes the tooth fail before measuring.
  await page.waitForSelector('[role="combobox"]', { timeout: 10_000 });
  const more = page.getByRole("button", { name: /^More$/i }).last();
  if (await more.count()) await more.click();
  const advanced = page.getByRole("button", { name: /^Advanced$/i }).last();
  if (await advanced.count()) await advanced.click();
  await page.waitForSelector('input[aria-label*="environment variable" i], input[aria-label*="env" i]', { timeout: 10_000 });
  await page.waitForTimeout(300);
}

test("shared key/value inputs obey the field metrics", async ({ page }) => {
  await openRows(page, "light");
  const result = await page.evaluate(() => {
    const token = getComputedStyle(document.documentElement);
    const px = (v: string) => `${parseFloat(v.trim())}px`;
    const tokens = {
      fontSize: px(token.getPropertyValue("--field-font-size")),
      fontWeight: token.getPropertyValue("--field-font-weight").trim(),
      lineHeight: px(token.getPropertyValue("--field-line-height")),
    };
    const rows = [...document.querySelectorAll('[data-slot="field"]')]
      .flatMap((field) => [...field.querySelectorAll("input")])
      .filter((input) => input.getAttribute("aria-label")?.toLowerCase().includes("environment"));
    return { tokens, metrics: rows.map((el) => { const s = getComputedStyle(el); return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight } as Metrics; }) };
  });
  expect(result.metrics.length, "env-var key/value consumer must render rows").toBeGreaterThan(0);
  expect(result.tokens, "the field axis resolves to the DS input type").toEqual(RAFT_FIELD);
  for (const metric of result.metrics) expect(metric).toEqual(result.tokens);
});

/**
 * The typography test above stays GREEN when the colour override comes back —
 * it only measures the inputs, and the override was never on an input. That is
 * the gap @Dozy found on PR #7010: the fix had no tooth of its own.
 *
 * A literal is invisible to a single-mode measurement, so this reads the SAME
 * two elements in light and dark and requires them to disagree. `text-black/60`
 * on the add button, or `text-black/40` on the `=` separator, renders one colour
 * in both modes — which is precisely what "cannot follow the mode" means, and
 * precisely what this then catches.
 */
test("add button and separator follow the mode rather than a literal", async ({ page }) => {
  const read = async (mode: Mode) => {
    await openRows(page, mode);
    return page.evaluate(() => {
      const addButton = [...document.querySelectorAll("button")]
        .find((el) => /add variable/i.test(el.textContent ?? ""));
      const separator = [...document.querySelectorAll("span")]
        .find((el) => el.textContent?.trim() === "=" && el.children.length === 0);
      return {
        addButton: addButton ? getComputedStyle(addButton).color : null,
        separator: separator ? getComputedStyle(separator).color : null,
      };
    });
  };

  const light = await read("light");
  const dark = await read("dark");

  // Preconditions: a missing element would make the inequality below vacuous.
  expect(light.addButton, "the add-variable button must render in light").not.toBeNull();
  expect(light.separator, "the `=` separator must render in light").not.toBeNull();
  expect(dark.addButton, "the add-variable button must render in dark").not.toBeNull();
  expect(dark.separator, "the `=` separator must render in dark").not.toBeNull();

  expect(
    dark.addButton,
    `the add-variable button must change with the mode — got ${light.addButton} in both, which is what a hardcoded text-black/60 looks like`,
  ).not.toBe(light.addButton);
  expect(
    dark.separator,
    `the "=" separator must change with the mode — got ${light.separator} in both, which is what a hardcoded text-black/40 looks like`,
  ).not.toBe(light.separator);
});

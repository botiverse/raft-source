import { expect, test } from "@playwright/test";

/**
 * Key/value rows are shared by RuntimeConfigFields (env vars) and AgentMcpTab
 * (credential headers).  The real Agent Details runtime editor gives us the
 * former consumer with persisted rows; measure the actual text-bearing inputs
 * in both themes so a button/input stopgap cannot hide a typography regression.
 */
type Theme = "brutal" | "elegant";
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE = (theme: Theme) =>
  `/visual-testing.html?case=screens.members.agent-detail.runtime-connection` +
  (theme === "elegant" ? "&theme=elegant" : "");

async function primeConnections(page: import("@playwright/test").Page) {
  await page.route("**/provider-connections", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connections: [{ id: "11111111-1111-4111-8111-111111111111", name: "ds official api", providerId: "deepseek", authMethod: "api_key", endpointUrl: null, supportsImageInput: false, enabled: true, status: "ready", configVersion: 1, credentialVersion: 1 }],
        providerOptions: [{ providerId: "deepseek", label: "DeepSeek", authMethods: ["api_key"] }],
      }),
    });
  });
}

async function openRows(page: import("@playwright/test").Page, theme: Theme) {
  await primeConnections(page);
  await page.goto(CASE(theme));
  await page.waitForSelector('[title="Edit runtime config"]', { timeout: 10_000 });
  await page.click('[title="Edit runtime config"]');
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

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: shared key/value inputs obey field metrics`, async ({ page }) => {
    await openRows(page, theme);
    const result = await page.evaluate(() => {
      const root = document.querySelector("[data-theme]") ?? document.documentElement;
      const token = getComputedStyle(root);
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
    expect(result.metrics.length, `${theme}: env-var key/value consumer must render rows`).toBeGreaterThan(0);
    expect(result.tokens.fontSize).toMatch(/^\d+(\.\d+)?px$/);
    for (const metric of result.metrics) expect(metric).toEqual(result.tokens);
  });
}

/**
 * The typography test above stays GREEN when the colour override comes back —
 * it only measures the inputs, and the override was never on an input. That is
 * the gap @Dozy found on PR #7010: the fix had no tooth of its own.
 *
 * A literal is invisible to a single-theme measurement, so this reads the SAME
 * two elements under both themes and requires them to disagree. `text-black/60`
 * on the add button, or `text-black/40` on the `=` separator, renders one colour
 * everywhere — which is precisely what "cannot follow the theme" means, and
 * precisely what this then catches.
 */
test("add button and separator follow the theme rather than a literal", async ({ page }) => {
  const read = async (theme: Theme) => {
    await openRows(page, theme);
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

  const brutal = await read("brutal");
  const elegant = await read("elegant");

  // Preconditions: a missing element would make the inequality below vacuous.
  expect(brutal.addButton, "the add-variable button must render under brutal").not.toBeNull();
  expect(brutal.separator, "the `=` separator must render under brutal").not.toBeNull();
  expect(elegant.addButton, "the add-variable button must render under elegant").not.toBeNull();
  expect(elegant.separator, "the `=` separator must render under elegant").not.toBeNull();

  expect(
    elegant.addButton,
    `the add-variable button must change with the theme — got ${brutal.addButton} under both, which is what a hardcoded text-black/60 looks like`,
  ).not.toBe(brutal.addButton);
  expect(
    elegant.separator,
    `the "=" separator must change with the theme — got ${brutal.separator} under both, which is what a hardcoded text-black/40 looks like`,
  ).not.toBe(brutal.separator);
});

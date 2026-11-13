import { expect, test } from "@playwright/test";
import { CLAUDE_LIVE, mockRuntimeFormsV2 } from "./runtimeFormV2Mock";

/**
 * task #9: the ten conditional runtime-config fields, measured for real.
 *
 * These render only after a runtime that supports them is selected, so until now
 * they appeared in NO visual case and had no evidence at all. The cause was not
 * "nobody clicked": the Runtime select opens, is enabled, and is EMPTY, because
 * its option catalog comes from a server fetch
 * (`useNewAgentRuntimeOptions` -> `useRuntimeSelectionCatalog` -> `api.get`)
 * that the harness never primes. So the fix is to supply that response, then
 * drive the UI the way a user would.
 *
 * The runtime form is the protocol v2 one (task #8): the admission row must
 * carry the `runtimeFormV2` marker, and the form and its option sources must
 * load. They are served from the real Claude fixtures in
 * packages/runtime-form/fixtures, so the fields, their order, visibility rules
 * and copy are the server's, not invented here.
 */

type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE = "/visual-testing.html?case=components.members.create-agent.claude-dialog";

async function primeCatalog(page: import("@playwright/test").Page) {
  await mockRuntimeFormsV2(page, [CLAUDE_LIVE]);
}

/** DS TextField: input text is 16/24, at the body weight. */
const RAFT_FIELD: Metrics = { fontSize: "16px", fontWeight: "400", lineHeight: "24px" };

/**
 * The field metric tokens as the browser resolves them, held to the DS before
 * anything is compared with them. That also rules out a failed custom-property
 * read turning into a vacuous "NaNpx === NaNpx" pass.
 */
async function tokens(page: import("@playwright/test").Page): Promise<Metrics> {
  const resolved = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const px = (v: string) => `${parseFloat(v.trim())}px`;
    return {
      fontSize: px(s.getPropertyValue("--field-font-size")),
      fontWeight: s.getPropertyValue("--field-font-weight").trim(),
      lineHeight: px(s.getPropertyValue("--field-line-height")),
    };
  });
  expect(resolved, "the field axis resolves to the DS input type, 16/24 400").toEqual(RAFT_FIELD);
  return resolved;
}

test(`conditional runtime-config fields render and obey the field axis`, async ({ page }) => {
  await primeCatalog(page);
  await page.goto(CASE);
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(600);

  // The catalog auto-selects the only offered runtime, so there is no "Select…"
  // left to click. Assert the precondition by its EFFECT instead: the runtime is
  // chosen and the Provider field (the first conditional one) has appeared.
  const afterCatalog = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('[data-slot="field-label"]')].map((l) => (l.textContent || "").trim()),
    runtime: [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null,
  }));
  expect(afterCatalog.runtime, `runtime catalog primed and a runtime is selected`).toBe("Claude Code");
  // Provider is required in the v2 Claude form, hence the asterisk.
  expect(afterCatalog.labels, `the Provider field is revealed by that selection`).toContain("Provider*");

  // Before Provider -> Custom, the pair is hidden by the form's visibility rule.
  const before = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
  expect(before, `API URL hidden under the default provider`).not.toContain("API URL");

  // Provider -> Custom reveals the API URL + API key pair. Provider is a v2
  // option-source field, so it is a searchable combobox, not a Select.
  await page.getByTestId("runtime-form-v2-provider").click();
  await page.getByRole("option", { name: "Custom", exact: true }).click();
  await page.waitForTimeout(700);

  const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
  // The whole point: fields exist now that did not before the provider was chosen.
  // The v2 Claude form marks neither as required (no asterisk).
  expect(labels, `API URL revealed`).toContain("API URL");
  expect(labels, `API Key revealed`).toContain("API Key");

  // Now the acceptance itself: those newly-revealed controls must sit on the
  // field metric axis like every other field.
  const t = await tokens(page);
  const measured = await page.evaluate(() => {
    const wanted = ["API URL", "API Key"];
    return [...document.querySelectorAll('[data-slot="field"]')]
      .map((f) => {
        const label = (f.querySelector('[data-slot="field-label"]')?.textContent || "").trim();
        const ctrl = f.querySelector("input") as HTMLElement | null;
        if (!ctrl || !wanted.some((w) => label.startsWith(w))) return null;
        const s = getComputedStyle(ctrl);
        return {
          label,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          lineHeight: s.lineHeight,
          onAxis: ctrl.className.includes("text-field") && ctrl.className.includes("font-field"),
        };
      })
      .filter(Boolean) as Array<{ label: string; fontSize: string; fontWeight: string; lineHeight: string; onAxis: boolean }>;
  });

  // Denominator first: two conditional inputs, or the loop below proves nothing.
  expect(measured.length, `both conditional inputs were found and measured`).toBe(2);
  for (const m of measured) {
    // Mechanism, not just the number — a value can match a token by coincidence.
    expect(m.onAxis, `"${m.label}" must carry text-field/font-field`).toBe(true);
    expect(m.fontSize, `"${m.label}" font-size`).toBe(t.fontSize);
    expect(m.fontWeight, `"${m.label}" font-weight`).toBe(t.fontWeight);
    expect(m.lineHeight, `"${m.label}" line-height`).toBe(t.lineHeight);
  }
});
test(`the Advanced disclosure fields obey the field axis`, async ({ page }) => {
  await primeCatalog(page);
  await page.goto(CASE);
  await page.waitForSelector('[data-slot="field"]');
  await page.waitForTimeout(600);

  // Precondition by effect: the catalog hydrated and a runtime is selected.
  const runtime = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null);
  expect(runtime, `runtime selected before opening Advanced`).toBe("Claude Code");

  // A second disclosure path, revealing a different set of conditional fields
  // than Provider->Custom: the Claude command hint lives behind the disclosure.
  //
  // ONE level, not two (@cindyz, 2026-09-03): nesting cost a click without
  // carrying a message. The v2 form has a single "Advanced" disclosure (its
  // `layout.advanced` fields: command and env vars); there is no outer "More".
  await expect(page.getByRole("button", { name: "More", exact: true }), `no outer "More" disclosure`).toHaveCount(0);
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  await expect(advanced, `exactly one "Advanced" disclosure exists`).toHaveCount(1);
  await advanced.click();
  await page.waitForTimeout(500);
  await expect(
    page.locator('button[aria-expanded]').filter({ hasText: /^(More|Advanced)$/ }),
    `opening it reveals fields, not a nested disclosure — one level only`,
  ).toHaveCount(1);

  const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
  expect(labels.some((l) => l.startsWith("Claude Command")), `command hint revealed`).toBe(true);

  const t = await tokens(page);
  const measured = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-slot="field"]')]
      .map((f) => {
        const label = (f.querySelector('[data-slot="field-label"]')?.textContent || "").trim();
        const ctrl = f.querySelector("input") as HTMLElement | null;
        if (!ctrl || !label.startsWith("Claude Command")) return null;
        const s = getComputedStyle(ctrl);
        return { label, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight,
                 onAxis: ctrl.className.includes("text-field") && ctrl.className.includes("font-field") };
      })
      .filter(Boolean) as Array<{ label: string; fontSize: string; fontWeight: string; lineHeight: string; onAxis: boolean }>;
  });

  expect(measured.length, `the command-hint input was found and measured`).toBe(1);
  for (const m of measured) {
    expect(m.onAxis, `"${m.label}" must carry text-field/font-field`).toBe(true);
    expect(m.fontSize, `"${m.label}" font-size`).toBe(t.fontSize);
    expect(m.fontWeight, `"${m.label}" font-weight`).toBe(t.fontWeight);
    expect(m.lineHeight, `"${m.label}" line-height`).toBe(t.lineHeight);
  }
});
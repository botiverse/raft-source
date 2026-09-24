import { expect, test } from "@playwright/test";

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
 * The mocked payload mirrors the shape used by
 * packages/web/tests/schemaCreateAgentDialog.behavior.test.tsx rather than being
 * invented here, so it stays honest to the real contract.
 */

type Theme = "brutal" | "elegant";
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE = (theme: Theme) =>
  `/visual-testing.html?case=components.members.create-agent.claude-dialog` +
  (theme === "elegant" ? "&theme=elegant" : "");

const catalog = (machineId: string) => ({
  context: "new_agent",
  machineId,
  options: [
    {
      runtimeId: "claude",
      capabilityStatus: "available",
      admissionStatus: "available_for_new",
      admissionReason: null,
      current: false,
      availableForNew: true,
      manageableForCurrentAgent: false,
      canSelectInThisContext: true,
    },
  ],
});

async function primeCatalog(page: import("@playwright/test").Page) {
  await page.route("**/runtime-options**", async (route) => {
    const url = route.request().url();
    const machineId = url.split("/machines/")[1]?.split("/")[0] ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(catalog(machineId)),
    });
  });
}

async function tokens(page: import("@playwright/test").Page): Promise<Metrics> {
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

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: conditional runtime-config fields render and obey the field axis`, async ({ page }) => {
    await primeCatalog(page);
    await page.goto(CASE(theme));
    await page.waitForSelector('[data-slot="field"]');
    await page.waitForTimeout(600);

    // The catalog auto-selects the only offered runtime, so there is no "Select…"
    // left to click. Assert the precondition by its EFFECT instead: the runtime is
    // chosen and the Provider field (the first conditional one) has appeared.
    const afterCatalog = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('[data-slot="field-label"]')].map((l) => (l.textContent || "").trim()),
      runtime: [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null,
    }));
    expect(afterCatalog.runtime, `${theme}: runtime catalog primed and a runtime is selected`).toBe("Claude Code");
    expect(afterCatalog.labels, `${theme}: the Provider field is revealed by that selection`).toContain("Provider");

    // Provider -> Custom reveals the API URL + API key pair.
    const providerTrigger = page.locator('[data-slot="field"]').filter({ hasText: "Provider" })
      .locator('[data-slot="button"]').first();
    await providerTrigger.click();
    await page.waitForTimeout(400);
    const custom = page.locator('[data-slot="select-item"]').filter({ hasText: /custom/i }).first();
    if (await custom.count()) {
      await custom.click();
      await page.waitForTimeout(700);
    }

    const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
    // The whole point: fields exist now that did not before the runtime was chosen.
    expect(labels, `${theme}: API URL revealed`).toContain("API URL*");
    expect(labels, `${theme}: API Key revealed`).toContain("API Key*");

    // Now the acceptance itself: those newly-revealed controls must sit on the
    // field metric axis like every other field, in BOTH themes.
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
    expect(measured.length, `${theme}: both conditional inputs were found and measured`).toBe(2);
    for (const m of measured) {
      // Mechanism, not just the number — a value can match a token by coincidence.
      expect(m.onAxis, `${theme}: "${m.label}" must carry text-field/font-field`).toBe(true);
      expect(m.fontSize, `${theme}: "${m.label}" font-size`).toBe(t.fontSize);
      expect(m.fontWeight, `${theme}: "${m.label}" font-weight`).toBe(t.fontWeight);
      expect(m.lineHeight, `${theme}: "${m.label}" line-height`).toBe(t.lineHeight);
    }
  });
  test(`${theme}: the Advanced disclosure fields obey the field axis`, async ({ page }) => {
    await primeCatalog(page);
    await page.goto(CASE(theme));
    await page.waitForSelector('[data-slot="field"]');
    await page.waitForTimeout(600);

    // Precondition by effect: the catalog hydrated and a runtime is selected.
    const runtime = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null);
    expect(runtime, `${theme}: runtime selected before opening Advanced`).toBe("Claude Code");

    // A second disclosure path, revealing a different set of conditional fields
    // than Provider->Custom: the Claude command hint lives behind More.
    //
    // ONE level, not two (@cindyz, 2026-09-03). The inner "Advanced" was removed
    // — it existed to fence off what can break the agent, but "More" and
    // "Advanced" both only mean "more stuff", so the nesting cost a click
    // without carrying the message. Command and env vars now sit directly
    // inside More.
    const more = page.getByRole("button", { name: "More", exact: true }).first();
    await expect(more, `${theme}: "More" disclosure exists`).toHaveCount(1);
    await more.click();
    await page.waitForTimeout(500);
    await expect(
      page.getByRole("button", { name: "Advanced", exact: true }),
      `${theme}: the nested "Advanced" disclosure must be gone — one level only`,
    ).toHaveCount(0);

    const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
    expect(labels.some((l) => l.startsWith("Claude Command")), `${theme}: command hint revealed`).toBe(true);

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

    expect(measured.length, `${theme}: the command-hint input was found and measured`).toBe(1);
    for (const m of measured) {
      expect(m.onAxis, `${theme}: "${m.label}" must carry text-field/font-field`).toBe(true);
      expect(m.fontSize, `${theme}: "${m.label}" font-size`).toBe(t.fontSize);
      expect(m.fontWeight, `${theme}: "${m.label}" font-weight`).toBe(t.fontWeight);
      expect(m.lineHeight, `${theme}: "${m.label}" line-height`).toBe(t.lineHeight);
    }
  });
}

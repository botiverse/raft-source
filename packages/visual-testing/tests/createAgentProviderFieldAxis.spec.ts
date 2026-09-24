import { expect, test } from "@playwright/test";

/**
 * task #9, remaining non-schema migrated inputs.
 *
 * These render only for runtimes the pre-existing cases never offered: the
 * built-in provider's key and gateway Base URL need `builtin`, and the Pi
 * provider key needs `pi`. Every earlier case seeds ["claude","codex"], so the
 * runtime select rendered, opened, and was simply empty of those options — the
 * inputs were unreachable, not merely undriven. Hence the two new cases.
 *
 * Reviewer note (@Dozy's counterfactual): a tooth that only measures whichever
 * inputs happen to be on screen cannot show a migration point is covered. So the
 * expected labels are named explicitly per state and the count is pinned, and
 * each measured control must carry the field-axis classes — matching a token by
 * coincidence is not the same as being on the axis.
 */

type Theme = "brutal" | "elegant";

const STATES = [
  { caseId: "builtin-provider-dialog", runtimeId: "builtin", provider: "DeepSeek",
    expect: ["DeepSeek API Key*"] },
  { caseId: "builtin-provider-dialog", runtimeId: "builtin", provider: "OpenAI Compatible",
    expect: ["OpenAI Compatible API Key*", "Base URL*", "Model*"] },
  { caseId: "pi-provider-dialog", runtimeId: "pi", provider: "DeepSeek",
    expect: ["DeepSeek API Key*"] },
] as const;

async function primeCatalog(page: import("@playwright/test").Page, runtimeId: string) {
  await page.route("**/runtime-options**", async (route) => {
    const url = route.request().url();
    const machineId = url.split("/machines/")[1]?.split("/")[0] ?? "";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      context: "new_agent", machineId,
      options: [{ runtimeId, capabilityStatus: "available", admissionStatus: "available_for_new",
        admissionReason: null, current: false, availableForNew: true,
        manageableForCurrentAgent: false, canSelectInThisContext: true }],
    })});
  });
}

async function tokens(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const root = document.querySelector("[data-theme]") ?? document.documentElement;
    const s = getComputedStyle(root);
    const px = (v: string) => `${parseFloat(v.trim())}px`;
    return { fontSize: px(s.getPropertyValue("--field-font-size")),
             fontWeight: s.getPropertyValue("--field-font-weight").trim(),
             lineHeight: px(s.getPropertyValue("--field-line-height")) };
  });
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  for (const state of STATES) {
    test(`${theme}: ${state.runtimeId}/${state.provider} conditional inputs obey the field axis`, async ({ page }) => {
      await primeCatalog(page, state.runtimeId);
      await page.goto(`/visual-testing.html?case=components.members.create-agent.${state.caseId}`
        + (theme === "elegant" ? "&theme=elegant" : ""));
      await page.waitForSelector('[data-slot="field"]');
      await page.waitForTimeout(900);

      // Precondition by effect: the catalog hydrated and this runtime is selected.
      const runtimeLabel = await page.evaluate(() =>
        [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null);
      expect(runtimeLabel, `${theme}: a runtime is actually selected`).toBeTruthy();

      const trigger = page.locator('[data-slot="field"]').filter({ hasText: "Provider" })
        .locator('[data-slot="button"]').first();
      await trigger.click();
      await page.waitForTimeout(400);
      await page.locator('[data-slot="select-item"]').filter({ hasText: state.provider }).first().click();
      await page.waitForTimeout(900);

      const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
      for (const want of state.expect) {
        expect(labels, `${theme}: "${want}" revealed by ${state.runtimeId}/${state.provider}`).toContain(want);
      }

      const t = await tokens(page);
      const measured = await page.evaluate((wanted) => {
        return [...document.querySelectorAll('[data-slot="field"]')].map((f) => {
          const label = (f.querySelector('[data-slot="field-label"]')?.textContent || "").trim();
          const ctrl = f.querySelector("input") as HTMLElement | null;
          if (!ctrl || !wanted.includes(label)) return null;
          const s = getComputedStyle(ctrl);
          return { label, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight,
                   onAxis: ctrl.className.includes("text-field") && ctrl.className.includes("font-field") };
        }).filter(Boolean) as Array<{ label: string; fontSize: string; fontWeight: string; lineHeight: string; onAxis: boolean }>;
      }, state.expect as unknown as string[]);

      // Denominator pinned: every named field must have been found and measured.
      expect(measured.map((m) => m.label).sort(),
        `${theme}: measured exactly the named conditional inputs`).toEqual([...state.expect].sort());
      for (const m of measured) {
        expect(m.onAxis, `${theme}: "${m.label}" must carry text-field/font-field`).toBe(true);
        expect(m.fontSize, `${theme}: "${m.label}" font-size`).toBe(t.fontSize);
        expect(m.fontWeight, `${theme}: "${m.label}" font-weight`).toBe(t.fontWeight);
        expect(m.lineHeight, `${theme}: "${m.label}" line-height`).toBe(t.lineHeight);
      }
    });
  }
}

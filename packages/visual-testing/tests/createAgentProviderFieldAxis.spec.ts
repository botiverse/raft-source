import { expect, test } from "@playwright/test";
import { builtinSources, mockRuntimeFormsV2, runtimeFormFixture } from "./runtimeFormV2Mock";
import type { RuntimeFormV2Mock } from "./runtimeFormV2Mock";

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

type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

/*
 * The runtime form is the protocol v2 one (task #8), served from the real
 * fixtures in packages/runtime-form/fixtures (Built-in's provider/model lists
 * are not in the fixtures; see `builtinSources`). In v2 the key's label is the
 * form's own "API Key" for every provider (v1 prefixed the provider name), its
 * required mark is the form's (Built-in requires it, Pi does not), and Model is
 * a provider-dependent searchable combobox whose INPUT is measured here too —
 * it is the provider-dependent control that replaced v1's gateway model input.
 * Built-in's "Supports image input" is a boolean option card, not an input.
 */
const STATES = [
  { caseId: "builtin-provider-dialog", runtimeId: "builtin", providerField: "providerId", provider: "DeepSeek",
    expect: ["API Key*", "Model*"] },
  { caseId: "builtin-provider-dialog", runtimeId: "builtin", providerField: "providerId", provider: "OpenAI Compatible",
    // builtin.form.json lists Base URL in no `required` (only minLength), so no mark.
    expect: ["API Key*", "Base URL", "Model*"] },
  { caseId: "pi-provider-dialog", runtimeId: "pi", providerField: "provider", provider: "DeepSeek",
    expect: ["API Key", "Model*"] },
] as const;

const FORMS: Record<string, RuntimeFormV2Mock> = {
  builtin: { runtimeId: "builtin", form: runtimeFormFixture("builtin.form.json"), sources: builtinSources() },
  pi: {
    runtimeId: "pi",
    form: runtimeFormFixture("pi.form.json"),
    sources: {
      provider: runtimeFormFixture("pi.option-source.provider.json"),
      model: runtimeFormFixture("pi.option-source.fallback.json"),
      providerModel: runtimeFormFixture("pi.option-source.provider-model.json"),
    },
  },
};

async function primeCatalog(page: import("@playwright/test").Page, runtimeId: string) {
  await mockRuntimeFormsV2(page, [FORMS[runtimeId]]);
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

for (const state of STATES) {
  test(`${state.runtimeId}/${state.provider} conditional inputs obey the field axis`, async ({ page }) => {
    await primeCatalog(page, state.runtimeId);
    await page.goto(`/visual-testing.html?case=components.members.create-agent.${state.caseId}`);
    await page.waitForSelector('[data-slot="field"]');
    await page.waitForTimeout(900);

    // Precondition by effect: the catalog hydrated and this runtime is selected.
    const runtimeLabel = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="select-value"]')].map((v) => (v.textContent || "").trim())[1] ?? null);
    expect(runtimeLabel, `a runtime is actually selected`).toBeTruthy();

    // Provider is a v2 option-source field: a searchable combobox.
    await page.getByTestId(`runtime-form-v2-${state.providerField}`).click();
    await page.getByRole("option", { name: state.provider, exact: true }).click();
    await page.waitForTimeout(900);
    await expect(page.getByTestId(`runtime-form-v2-${state.providerField}`), `provider switched`).toHaveValue(state.provider);

    const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
    for (const want of state.expect) {
      expect(labels, `"${want}" revealed by ${state.runtimeId}/${state.provider}`).toContain(want);
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
      `measured exactly the named conditional inputs`).toEqual([...state.expect].sort());
    for (const m of measured) {
      expect(m.onAxis, `"${m.label}" must carry text-field/font-field`).toBe(true);
      expect(m.fontSize, `"${m.label}" font-size`).toBe(t.fontSize);
      expect(m.fontWeight, `"${m.label}" font-weight`).toBe(t.fontWeight);
      expect(m.lineHeight, `"${m.label}" line-height`).toBe(t.lineHeight);
    }
  });
}
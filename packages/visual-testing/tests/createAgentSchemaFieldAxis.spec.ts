import { expect, test } from "@playwright/test";

/**
 * task #9, the three schema-driven migrated inputs.
 *
 * `SchemaDrivenRuntimeFields` renders from a server-supplied form definition, so
 * reaching its inputs needs three mocked endpoints, not one: the runtime option
 * must carry a formDefinitionRef, the definition itself must load, and its option
 * sources must resolve. cindyz authorised the case for this ("B").
 *
 * The payload mirrors packages/web/tests/schemaCreateAgentDialog.behavior.test.tsx.
 * Copy it rather than trimming it: the parser uses exact-key and membership checks,
 * and simplifying `forbiddenPointers` to [] silently fails the whole definition —
 * the form then renders "configuration is unavailable" and every field is absent,
 * which reads like the fields not existing rather than the fixture being wrong.
 */

type Theme = "brutal" | "elegant";

const ref = { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v2" };

const definition = {
  ...ref,
  dataSchema: {
    type: "object", additionalProperties: false,
    required: ["providerId", "apiKey", "model"],
    properties: {
      providerId: { type: "string", title: "Provider", minLength: 1 },
      apiKey: { type: "string", title: "API Key", minLength: 1, writeOnly: true },
      baseUrl: { type: "string", title: "Base URL", minLength: 1, format: "uri" },
      supportsImageInput: { type: "boolean", title: "Image input" },
      model: { type: "string", title: "Model", minLength: 1 },
      envVars: { type: "object", title: "Environment Variables", additionalProperties: { type: "string" } },
    },
  },
  uiSchema: {
    order: ["providerId", "apiKey", "baseUrl", "supportsImageInput", "model", "envVars"],
    layout: { advanced: ["/envVars"] },
    visibility: [
      { pointer: "/baseUrl", when: { pointer: "/providerId", in: ["openai-compatible"] } },
      { pointer: "/supportsImageInput", when: { pointer: "/providerId", in: ["openai-compatible"] } },
    ],
    localization: {},
  },
  // `/hostUserState` is required by the parser — not decorative.
  capabilities: { providerKinds: ["preset", "gateway"], writeOnlyPointers: ["/apiKey"], forbiddenPointers: ["/hostUserState"] },
  optionSources: {
    provider: { ...ref, sourceId: "provider", kind: "select", pointer: "/providerId" },
    model: { ...ref, sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId" },
  },
};
const providerSource = {
  ...ref, sourceId: "provider", kind: "select", pointer: "/providerId",
  options: [
    { value: "deepseek", label: "Server DeepSeek", providerKind: "preset" },
    { value: "openai-compatible", label: "Server Gateway", providerKind: "gateway" },
  ],
  defaultValue: "deepseek",
};
const modelSource = {
  ...ref, sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
  optionsByValue: { deepseek: [{ value: "deepseek/deepseek-v4-pro", label: "Server Model" }], "openai-compatible": [] },
  defaultValueByValue: { deepseek: "deepseek/deepseek-v4-pro" },
  customValueAllowedByValue: { deepseek: false, "openai-compatible": true },
};

async function primeSchema(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (url.includes("/runtime-options")) {
      const machineId = url.split("/machines/")[1]?.split("/")[0] ?? "";
      return json({ context: "new_agent", machineId, options: [{
        runtimeId: "builtin", capabilityStatus: "available", admissionStatus: "available_for_new",
        admissionReason: null, current: false, availableForNew: true,
        manageableForCurrentAgent: false, canSelectInThisContext: true, formDefinitionRef: ref }] });
    }
    if (url.includes("/option-sources/provider")) return json(providerSource);
    if (url.includes("/option-sources/model")) return json(modelSource);
    if (url.includes("/runtime-form-definitions/builtin")) return json(definition);
    return route.continue();
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

async function measure(page: import("@playwright/test").Page, wanted: string[]) {
  return page.evaluate((names) => {
    return [...document.querySelectorAll('[data-slot="field"]')].map((f) => {
      const label = (f.querySelector('[data-slot="field-label"]')?.textContent || "").trim();
      const ctrl = f.querySelector("input") as HTMLElement | null;
      if (!ctrl || !names.includes(label)) return null;
      const s = getComputedStyle(ctrl);
      return { label, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight,
               onAxis: ctrl.className.includes("text-field") && ctrl.className.includes("font-field") };
    }).filter(Boolean) as Array<{ label: string; fontSize: string; fontWeight: string; lineHeight: string; onAxis: boolean }>;
  }, wanted);
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  for (const state of [
      // Model is a SELECT in the preset state (its option source supplies values), so
    // it is not a migrated <Input> there; it becomes a text input only under the
    // gateway provider, which is the "gateway/custom model" migration point.
    { provider: null as string | null, expect: ["Server DeepSeek API Key*"] },
    { provider: "Server Gateway", expect: ["Server Gateway API Key*", "Base URL*", "Model*"] },
  ]) {
    const name = state.provider ?? "default preset";
    test(`${theme}: schema-driven inputs obey the field axis (${name})`, async ({ page }) => {
      await primeSchema(page);
      await page.goto("/visual-testing.html?case=components.members.create-agent.builtin-provider-dialog"
        + (theme === "elegant" ? "&theme=elegant" : ""));
      await page.waitForSelector('[data-slot="field"]');
      await page.waitForTimeout(1400);

      // The definition must actually have loaded. Without this, every field is
      // absent and an empty measurement would look like "nothing to check".
      const unavailable = await page.locator('[data-testid^="schema-runtime"]').filter({ hasText: /unavailable|Refresh/i }).count();
      expect(unavailable, `${theme}: the schema definition loaded (not the unavailable state)`).toBe(0);

      if (state.provider) {
        const trigger = page.locator('[data-slot="field"]').filter({ hasText: "Provider" })
          .locator('[data-slot="button"]').first();
        await trigger.click();
        await page.waitForTimeout(400);
        await page.locator('[data-slot="select-item"]').filter({ hasText: state.provider }).first().click();
        await page.waitForTimeout(900);
      }

      const labels = (await page.locator('[data-slot="field-label"]').allTextContents()).map((l) => l.trim());
      for (const want of state.expect) {
        expect(labels, `${theme}: "${want}" rendered`).toContain(want);
      }

      const t = await tokens(page);
      const measured = await measure(page, [...state.expect]);
      expect(measured.map((m) => m.label).sort(),
        `${theme}: measured exactly the named schema inputs`).toEqual([...state.expect].sort());
      for (const m of measured) {
        expect(m.onAxis, `${theme}: "${m.label}" must carry text-field/font-field`).toBe(true);
        expect(m.fontSize, `${theme}: "${m.label}" font-size`).toBe(t.fontSize);
        expect(m.fontWeight, `${theme}: "${m.label}" font-weight`).toBe(t.fontWeight);
        expect(m.lineHeight, `${theme}: "${m.label}" line-height`).toBe(t.lineHeight);
      }
    });
  }
}

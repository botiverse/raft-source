import { expect, test } from "@playwright/test";
import { builtinSources, mockRuntimeFormsV2, runtimeFormFixture } from "./runtimeFormV2Mock";

/**
 * Agent Details' saved provider connection, measured against the runtime field
 * it sits beside.
 *
 * Under the v1 form the saved-connection choice was its own select OUTSIDE
 * RuntimeConfigFields (`runtime-built-in-provider-select`, task #28), so nothing
 * structural kept its type aligned with the runtime fields and this spec held
 * them together by COMPUTED values (@Mahua's condition: a class assertion says
 * the same token was requested, not that the two render alike).
 *
 * The protocol v2 form (task #8: the only runtime editor) moved the choice INTO
 * the form: Built-in's Provider field lists saved connections in a "Saved
 * providers" group ahead of the direct providers (capability
 * `provider.saved_connection`), and selecting one hands the connection-owned
 * fields (`x-connectionOwned`) to the connection. The Provider field is a
 * searchable combobox, the Runtime field a Select — different controls that
 * must still RENDER the same type, which is what is measured here. jsdom applies
 * no stylesheet, so this half can only live in the browser suite.
 *
 * The v1 spec's second test (an unselected saved connection without a credential
 * is filtered out of the options) is gone with the v1 select: under v2 the
 * server builds the option list, so a browser test could only check this mock.
 *
 * Reaching the form needs, besides the case's Built-in agent: the agent's
 * admission row with the v2 marker, its edit form (`/agents/:id/runtime-form`),
 * and Built-in's option sources. The edit form is the real
 * `builtin.edit.json` fixture with the saved-connection capability added the way
 * packages/web/src/features/agent/tests/schemaCreateAgentDialog.behavior.test.tsx (removed in the 2026-11 web DOM test prune) adds it.
 */

type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE_ID = "screens.members.agent-detail.runtime-connection";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SAVED_LABEL = "DeepSeek · ds official api";

const CASE = `/visual-testing.html?case=${CASE_ID}`;
const PROVIDER = '[data-testid="runtime-form-v2-providerId"]';
const API_KEY = '[data-testid="runtime-form-v2-apiKey"]';

/** builtin.edit.json, as a server with provider connections serves it. */
function savedConnectionEditForm() {
  const form = runtimeFormFixture("builtin.edit.json") as {
    requiredClientCapabilities: string[];
    dataSchema: { properties: Record<string, Record<string, unknown>> };
    values: Record<string, unknown>;
  };
  form.requiredClientCapabilities = [...form.requiredClientCapabilities, "provider.saved_connection"];
  for (const key of ["apiKey", "baseUrl", "supportsImageInput"]) {
    form.dataSchema.properties[key]!["x-connectionOwned"] = true;
  }
  // The agent currently runs on the direct DeepSeek provider.
  form.values = { providerId: "deepseek", model: "deepseek/deepseek-v4-pro", loadLocalPlugins: false, envVars: {} };
  return form;
}

async function primeForm(page: import("@playwright/test").Page) {
  // The pencil action next to a selected connection reads the saved list.
  await page.route("**/provider-connections", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connections: [{
          id: CONNECTION_ID,
          name: "ds official api",
          providerId: "deepseek",
          authMethod: "api_key",
          endpointUrl: null,
          supportsImageInput: false,
          enabled: true,
          status: "ready",
          configVersion: 1,
          credentialVersion: 1,
          hasCredential: true,
        }],
        providerOptions: [
          { providerId: "deepseek", label: "DeepSeek", authMethods: ["api_key"] },
        ],
      }),
    });
  });
  await mockRuntimeFormsV2(page, [{
    runtimeId: "builtin",
    current: true,
    edit: savedConnectionEditForm(),
    sources: builtinSources({ connectionId: CONNECTION_ID, label: SAVED_LABEL, underlyingProviderId: "deepseek" }),
  }]);
}

async function openRuntimeEditor(page: import("@playwright/test").Page) {
  await primeForm(page);
  await page.goto(CASE);
  await page.getByRole("button", { name: "Edit runtime config" }).click({ timeout: 10_000 });
  await page.waitForSelector(PROVIDER, { timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** Read from the node that carries the TEXT: a Select's value slot, or the input itself. */
async function textMetrics(page: import("@playwright/test").Page, selector: string): Promise<Metrics> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`not found: ${sel}`);
    const text = el.querySelector('[data-slot="select-value"]') ?? el;
    const s = getComputedStyle(text as Element);
    return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
  }, selector);
}

test(`the saved provider connection is chosen in the v2 Provider field, which measures the same as the Runtime field`, async ({ page }) => {
  await openRuntimeEditor(page);

  // Precondition, asserted rather than assumed: if the form never loaded every
  // comparison below is vacuous.
  await expect(page.locator('[data-testid="schema-runtime-unavailable"]'), `the v2 edit form loaded`).toHaveCount(0);
  const provider = page.locator(PROVIDER);
  await expect(provider, `the Provider field starts on the agent's direct provider`).toHaveValue("DeepSeek");
  await expect(page.locator(API_KEY), `a direct provider's key is the user's to enter`).toBeEnabled();

  // Positive selection contract: the saved connection renders by its exact
  // label, in the "Saved providers" group ahead of the direct one.
  await provider.click();
  const savedOpt = page.getByRole("option", { name: SAVED_LABEL, exact: true });
  const directOpt = page.getByRole("option", { name: "DeepSeek", exact: true });
  await expect(savedOpt, `saved option "${SAVED_LABEL}" must render`).toBeVisible();
  await expect(directOpt, `direct option "DeepSeek" must render`).toBeVisible();
  const allTexts = await page.locator('[role="option"]').allInnerTexts();
  const savedIdx = allTexts.findIndex((t) => t.includes("ds official api"));
  const directIdx = allTexts.findIndex((t) => t.trim().split("\n")[0] === "DeepSeek");
  expect(savedIdx, `the saved option is listed`).toBeGreaterThanOrEqual(0);
  expect(savedIdx, `saved option must sort before its direct provider`).toBeLessThan(directIdx);
  const groupTexts = (await page.locator('[data-slot="combobox-group-label"]').allInnerTexts()).map((t) => t.trim());
  expect(groupTexts, `saved group heads the list, direct follows`).toEqual(["Saved providers", "Direct setup"]);

  // Selecting it moves the field's text and hands the key to the connection:
  // disabled, with the connection named instead of a value.
  await savedOpt.click();
  await expect(provider, `the field must show the saved connection after selection`).toHaveValue(SAVED_LABEL);
  const apiKey = page.locator(API_KEY);
  await expect(apiKey, `API key must be disabled under a saved connection`).toBeDisabled();
  await expect(apiKey).toHaveAttribute("placeholder", `Provided by “${SAVED_LABEL}”`);

  const connection = await textMetrics(page, PROVIDER);
  const runtime = await page.evaluate(() => {
    const field = [...document.querySelectorAll('[data-slot="field"]')]
      .find((f) => (f.querySelector('[data-slot="field-label"]')?.textContent ?? "").trim().startsWith("Runtime"));
    const text = field?.querySelector('[data-slot="select-value"]');
    if (!text) throw new Error("no Runtime select to compare against");
    const s = getComputedStyle(text);
    return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
  });

  // Sanity-check the reads, so a failed lookup cannot become a vacuously
  // satisfiable "undefined === undefined".
  expect(connection.fontSize, `font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);
  expect(runtime.fontSize, `sibling font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);
  expect(connection.fontWeight, `font-weight resolves`).toMatch(/^\d+$/);

  expect(
    connection,
    `the Provider combobox that carries the saved connection must RENDER identically to the Runtime select beside it — different controls, nothing keeps them aligned automatically`,
  ).toEqual(runtime);
});

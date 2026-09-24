import { expect, test } from "@playwright/test";

/**
 * Agent Details' provider-connection select, measured against the runtime fields
 * it sits above.
 *
 * The split is deliberate: that select chooses WHICH SAVED CONNECTION to use and
 * toggles the runtime fields beneath it, so it is an upper-level switch rather
 * than a sibling field, and it stays outside RuntimeConfigFields (@cindyz,
 * task #28). Its appearance must still match theirs.
 *
 * The guard is needed precisely BECAUSE the split is deliberate. The two matched
 * historically for a reason that no longer exists — both inherited one global
 * `.runtime-config-select-trigger` override, which retiring the legacy chrome
 * deleted. Nothing structural holds them together now, so a later change to
 * RuntimeConfigFields' chrome would leave this one behind in silence.
 *
 * COMPUTED values, not class names (@Mahua's condition). A class assertion says
 * the same token was REQUESTED; it cannot say the two RENDER alike, and drift is
 * the whole failure mode. The dom suite cannot do this — jsdom applies no
 * stylesheet — so it lives here, and the class-level guard in
 * `agentRuntimeConnectionFields.behavior.test.tsx` is the half that runs in CI.
 *
 * Reaching this control needs a dedicated case: it renders only for Built-in
 * runtime with the connections flag on and a connection saved. The flag comes
 * from a STORE rather than an endpoint, so no amount of route-mocking switches
 * it on — `primeAgentDetailStores` seeds it for this case id. That is why the
 * control had no coverage at all before task #28.
 *
 * LOCAL-ONLY suite: Hosted is NOT COVERED for these assertions.
 */

type Theme = "brutal" | "elegant";
type Metrics = { fontSize: string; fontWeight: string; lineHeight: string };

const CASE_ID = "screens.members.agent-detail.runtime-connection";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

const CASE = (theme: Theme) =>
  `/visual-testing.html?case=${CASE_ID}` + (theme === "elegant" ? "&theme=elegant" : "");

/** The catalog itself is an ordinary fetch, so this half CAN be mocked. */
async function primeConnections(page: import("@playwright/test").Page) {
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
        }],
        providerOptions: [{ providerId: "deepseek", label: "DeepSeek", authMethods: ["api_key"] }],
      }),
    });
  });
}

async function openRuntimeEditor(page: import("@playwright/test").Page, theme: Theme) {
  await primeConnections(page);
  await page.goto(CASE(theme));
  await page.waitForSelector('[title="Edit runtime config"]', { timeout: 10_000 });
  await page.click('[title="Edit runtime config"]');
  await page.waitForSelector('[role="combobox"]', { timeout: 10_000 });
  await page.waitForTimeout(600);
}

/** Read from the node that carries the TEXT. A trigger's own box can differ from
 *  the type it renders, and the type is what a reader compares. */
async function metricsOf(page: import("@playwright/test").Page, selector: string): Promise<Metrics> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`not found: ${sel}`);
    const text = el.querySelector('[data-slot="select-value"]') ?? el;
    const s = getComputedStyle(text as Element);
    return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
  }, selector);
}

for (const theme of ["brutal", "elegant"] as Theme[]) {
  test(`${theme}: the provider-connection select measures the same as the runtime fields`, async ({ page }) => {
    await openRuntimeEditor(page, theme);

    // Precondition, asserted rather than assumed: if this control is absent every
    // comparison below is vacuous, and absent is exactly how it used to be.
    expect(
      await page.locator('[data-testid="edit-agent-provider-connection"]').count(),
      `${theme}: the provider-connection select must render — it needs Built-in + the flag + a saved connection`,
    ).toBe(1);

    const connection = await metricsOf(page, '[data-testid="edit-agent-provider-connection"]');
    const runtime = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="combobox"]')]
        .find((c) => c.getAttribute("data-testid") !== "edit-agent-provider-connection");
      if (!el) throw new Error("no runtime select to compare against");
      const text = el.querySelector('[data-slot="select-value"]') ?? el;
      const s = getComputedStyle(text as Element);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
    });

    // Sanity-check the reads, so a failed lookup cannot become a vacuously
    // satisfiable "undefined === undefined".
    expect(connection.fontSize, `${theme}: font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);
    expect(runtime.fontSize, `${theme}: sibling font-size resolves`).toMatch(/^\d+(\.\d+)?px$/);
    expect(connection.fontWeight, `${theme}: font-weight resolves`).toMatch(/^\d+$/);

    expect(
      connection,
      `${theme}: the provider-connection select must RENDER identically to the runtime fields beneath it, not merely request the same token — separate code, nothing keeps them aligned automatically`,
    ).toEqual(runtime);
  });
}

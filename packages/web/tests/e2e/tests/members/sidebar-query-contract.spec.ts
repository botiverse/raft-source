import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";

let cachedSeedState: PlaywrightSeedState | null = null;
let cachedLogin: Awaited<ReturnType<typeof loginViaApi>> | null = null;

async function getSeedAndLogin(request: APIRequestContext) {
  if (!cachedSeedState) {
    cachedSeedState = await waitForSeedState();
  }
  if (!cachedLogin) {
    cachedLogin = await loginViaApi(request, cachedSeedState);
  }
  return { seedState: cachedSeedState, login: cachedLogin };
}

async function dismissOwnerOnboarding(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.patch(
    `${seedState.urls.api}/api/servers/${seedState.server.id}/onboarding-settings`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { setupModalReminderOptOut: true },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to opt out of onboarding modal: ${response.status()} ${response.statusText()}`,
    );
  }
}

async function createAgentFixture(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/agents`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      name,
      runtime: "codex",
    },
  });
  if (!response.ok()) {
    throw new Error(`Failed to create agent fixture: ${response.status()} ${response.statusText()}`);
  }
  return response.json() as Promise<{ id: string; displayName: string | null; name: string }>;
}

// Rail mode is now path-derived (path /agent/<id> means members mode); the
// legacy `?sidebarTab=` and `?tab=` params are normalized away on entry by
// useRailLegacyRedirect. The contract here is therefore: those rail-mode
// query keys are absent from any URL we observe, and the path keeps its
// /agent/<id> shape (so the rail still highlights Members).
function assertScopedMembersContract(page: Page, expectedAgentTab: "activity" | "workspace") {
  return expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        agentDetail: /\/agent\/[^/?#]+$/.test(url.pathname),
        sidebarTab: url.searchParams.get("sidebarTab"),
        agentTab: url.searchParams.get("agentTab"),
        legacyTab: url.searchParams.get("tab"),
      };
    })
    .toEqual({
      agentDetail: true,
      sidebarTab: null,
      agentTab: expectedAgentTab,
      legacyTab: null,
    });
}

test.describe("Sidebar query contract", () => {
  test("members sidebar stays active when agent detail tabs change", async ({ page, request }) => {
    const { seedState, login } = await getSeedAndLogin(request);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const agentName = `sidebar-contract-${Date.now()}`;
    const agent = await createAgentFixture(request, seedState, login.accessToken, agentName);

    await page.goto(`/s/${seedState.server.slug}/agent/${agent.id}?sidebarTab=members`);
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-white/);

    await page.getByTestId("panel-tab-activity").click();
    await assertScopedMembersContract(page, "activity");
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-white/);

    await page.getByTestId("panel-tab-workspace").click();
    await assertScopedMembersContract(page, "workspace");
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-white/);
  });

  test("legacy tab=machines links still load members and normalize to sidebarTab on interaction", async ({
    page,
    request,
  }) => {
    const { seedState, login } = await getSeedAndLogin(request);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const agentName = `sidebar-legacy-${Date.now()}`;
    const agent = await createAgentFixture(request, seedState, login.accessToken, agentName);

    await page.goto(`/s/${seedState.server.slug}/agent/${agent.id}?tab=machines`);
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-white/);
    await page.getByTestId("panel-tab-activity").click();

    await assertScopedMembersContract(page, "activity");
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-white/);
  });
});

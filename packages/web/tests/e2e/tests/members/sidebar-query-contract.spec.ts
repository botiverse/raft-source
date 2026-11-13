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

// Rail mode is path-derived, and the legacy `?sidebarTab=` and `?tab=` params
// are normalized away on entry by useRailLegacyRedirect. Members is a full page
// with no sidebar (#13127): on desktop a profile URL (/agent/<id>) opens the
// Members page with that profile in the side panel (useMembersProfileRedirect).
// The contract here is therefore: those rail-mode query keys are absent from
// any URL we observe, the path is /members, and `profile=agent:<id>` keeps the
// agent open while its tabs change (so the rail still highlights Members).
function assertScopedMembersContract(
  page: Page,
  agentId: string,
  expectedAgentTab: "activity" | "workspace",
) {
  return expect
    .poll(() => {
      const url = new URL(page.url());
      return {
        membersPage: /\/members$/.test(url.pathname),
        profile: url.searchParams.get("profile"),
        sidebarTab: url.searchParams.get("sidebarTab"),
        agentTab: url.searchParams.get("agentTab"),
        legacyTab: url.searchParams.get("tab"),
      };
    })
    .toEqual({
      membersPage: true,
      profile: `agent:${agentId}`,
      sidebarTab: null,
      agentTab: expectedAgentTab,
      legacyTab: null,
    });
}

// The Members rail item stays the selected rail entry. Raft draws a selected
// rail item as a sticker (white in the light yellow frame, yellow in dark);
// assert the selection state the rail exposes, not the sticker's colour class.
async function expectMembersRailSelected(page: Page) {
  const members = page.getByRole("button", { name: "Members" });
  await expect(members).toHaveAttribute("aria-pressed", "true");
  await expect(members).toHaveAttribute("data-selected", "true");
}

test.describe("Members query contract", () => {
  test("the Members page stays active when agent profile tabs change", async ({ page, request }) => {
    const { seedState, login } = await getSeedAndLogin(request);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const agentName = `sidebar-contract-${Date.now()}`;
    const agent = await createAgentFixture(request, seedState, login.accessToken, agentName);

    await page.goto(`/s/${seedState.server.slug}/agent/${agent.id}?sidebarTab=members`);
    await expect(page.getByTestId("members-page")).toBeVisible();
    await expectMembersRailSelected(page);

    await page.getByTestId("panel-tab-activity").click();
    await assertScopedMembersContract(page, agent.id, "activity");
    await expectMembersRailSelected(page);

    await page.getByTestId("panel-tab-workspace").click();
    await assertScopedMembersContract(page, agent.id, "workspace");
    await expect(page.getByTestId("members-page")).toBeVisible();
    await expectMembersRailSelected(page);
  });

  test("legacy tab=machines profile links land on the Members page with the profile open", async ({
    page,
    request,
  }) => {
    const { seedState, login } = await getSeedAndLogin(request);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const agentName = `sidebar-legacy-${Date.now()}`;
    const agent = await createAgentFixture(request, seedState, login.accessToken, agentName);

    await page.goto(`/s/${seedState.server.slug}/agent/${agent.id}?tab=machines`);
    await expect(page.getByTestId("members-page")).toBeVisible();
    await expectMembersRailSelected(page);
    await page.getByTestId("panel-tab-activity").click();

    await assertScopedMembersContract(page, agent.id, "activity");
    await expectMembersRailSelected(page);
  });
});

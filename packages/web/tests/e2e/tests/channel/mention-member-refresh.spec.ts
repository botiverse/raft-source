import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

function headers(seedState: PlaywrightSeedState, accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": seedState.server.id,
  };
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: headers(seedState, accessToken),
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

test.describe("Channel member mention autocomplete", () => {
  test("refreshes @ suggestions immediately after adding an agent member", async ({ page, request }) => {
    await page.addInitScript(() => {
      class BlockedWebSocket {
        constructor() {
          throw new Error("WebSocket disabled for mention refresh test");
        }
      }
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: BlockedWebSocket,
      });
    });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);
    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `mention-refresh-${runId}`,
    );

    await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
    const composer = page.getByPlaceholder(`Message #${channel.name}`);
    await expect(composer).toBeVisible();

    await page.getByTitle("View participants").click();
    await page.getByRole("button", { name: "Add Member" }).click();
    await page.getByPlaceholder("Name").fill(seedState.agent.name);
    await page.getByRole("button", { name: new RegExp(seedState.agent.name) }).click();
    await expect(page.locator('button[title="View participants"]')).toContainText("2");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await composer.fill(`@${seedState.agent.name}`);

    await expect(page.getByRole("button", { name: new RegExp(`@${seedState.agent.name}`) })).toBeVisible();
    await expect(page.getByText("Not in this channel")).toHaveCount(0);
  });
});

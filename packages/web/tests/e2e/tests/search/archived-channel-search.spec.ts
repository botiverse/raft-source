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

async function createMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string; content: string }> {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(seedState, accessToken),
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; content: string }>;
}

async function archiveChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/archive`, {
    headers: headers(seedState, accessToken),
  });
  expect(response.ok()).toBeTruthy();
}

test.describe("Archived channel search result navigation", () => {
  test("opens an archived channel message from search", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
    const runId = Date.now().toString(36);

    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `archived-search-${runId}`,
    );
    const message = await createMessage(
      request,
      seedState,
      login.accessToken,
      channel.id,
      `archived search click target ${runId}`,
    );
    await archiveChannel(request, seedState, login.accessToken, channel.id);

    await page.goto(`/s/${seedState.server.slug}/search?q=${encodeURIComponent(runId)}`);
    const messageHit = page.getByRole("button", { name: new RegExp(message.content) }).first();
    await expect(messageHit).toBeVisible();

    await messageHit.click();

    await expect(page).toHaveURL(
      new RegExp(`/search\\?.*open=channel%3A${channel.id}.*msg=${message.id}`),
    );
    await expect(page.getByText("This channel is archived.")).toBeVisible();
    await expect(
      page.getByTestId("message-scroller").getByText(message.content),
    ).toBeVisible();
  });
});

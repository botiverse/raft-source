import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";

async function measureBottomGap(page: Parameters<typeof test>[0]["page"]) {
  const scroller = page.getByTestId("message-scroller");
  return scroller.evaluate((element) => {
    return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
  });
}

test("seeded chat loads at the bottom and receives a realtime message", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);

  await page.goto(`/s/${seedState.server.slug}`);

  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();
  // Allow up to one item height of slack here; scroll/layout settles asynchronously.
  await expect(measureBottomGap(page)).resolves.toBeLessThan(40);

  const smokeMessage = `Realtime smoke ${Date.now()}`;
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: smokeMessage,
    },
  });
  expect(response.ok()).toBeTruthy();

  await expect(page.getByText(smokeMessage)).toBeVisible();
});

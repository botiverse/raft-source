import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { name },
  });
  if (!response.ok()) {
    throw new Error(`Failed to create channel: ${response.status()} ${response.statusText()}`);
  }
  return response.json();
}

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId, content },
  });
  if (!response.ok()) {
    throw new Error(`Failed to post message: ${response.status()} ${response.statusText()}`);
  }
  return response.json();
}

test.describe("short channel anchors content to bottom", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("two-message channel renders messages flush with the input on mobile", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);

    const channel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `short-${Date.now().toString(36)}`,
    );
    await postMessage(request, seedState, login.accessToken, channel.id, "First short message");
    const second = await postMessage(
      request,
      seedState,
      login.accessToken,
      channel.id,
      "Second short message — should sit just above the input on mobile",
    );

    await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(second.content)).toBeVisible();

    // Wait for layout to settle.
    await expect
      .poll(async () => {
        return page.getByTestId("message-scroller").evaluate((el) => {
          const items = Array.from(el.querySelectorAll("[data-index]"));
          const last = items[items.length - 1] as HTMLElement | undefined;
          if (!last) return null;
          const scrollerRect = el.getBoundingClientRect();
          const lastRect = last.getBoundingClientRect();
          return Math.round(scrollerRect.bottom - lastRect.bottom);
        });
      }, { timeout: 5000 })
      // Allow up to one Footer-equivalent of slack (footer is ~24px: pb-3 + h-3).
      .toBeLessThan(40);
  });
});

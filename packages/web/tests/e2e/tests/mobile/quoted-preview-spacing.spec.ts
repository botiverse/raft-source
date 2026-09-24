import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

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
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string; content: string }> {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("mobile quoted message preview spacing", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("quoted preview message row hugs the preview instead of stretching to the viewport", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const targetChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `quote-target-${Date.now().toString(36)}`,
    );
    const previewChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `quote-preview-${Date.now().toString(36)}`,
    );
    const target = await postMessage(
      request,
      seedState,
      login.accessToken,
      targetChannel.id,
      "按你刚刚“Inbox = grouped Notification Center”的定义，我建议把 contract 收成这几条，然后我们再看实际实现应该怎么落。",
    );
    const permalink = `${seedState.urls.web}/s/${seedState.server.slug}/channel/${targetChannel.id}?msg=${target.id}`;
    const preview = await postMessage(
      request,
      seedState,
      login.accessToken,
      previewChannel.id,
      `mobile quoted preview ${permalink}`,
    );
    // No newer messages: the sparse channel should still keep this focused
    // quoted-preview row near the input instead of leaving a viewport-sized
    // void under the card.

    await page.goto(`/s/${seedState.server.slug}/channel/${previewChannel.id}?msg=${preview.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.locator(`#message-${preview.id}`)).toBeVisible();
    await expect(page.getByTestId("quoted-message-card")).toBeVisible();

    const geometry = await page.locator(`#message-${preview.id}`).evaluate((messageEl) => {
      const quoted = messageEl.querySelector('[data-testid="quoted-message-card"]') as HTMLElement | null;
      if (!quoted) throw new Error("quoted message card missing");
      const messageRect = messageEl.getBoundingClientRect();
      const quotedRect = quoted.getBoundingClientRect();
      const scroller = document.querySelector('[data-testid="message-scroller"]') as HTMLElement | null;
      if (!scroller) throw new Error("message scroller missing");
      const scrollerRect = scroller.getBoundingClientRect();
      return {
        messageHeight: Math.round(messageRect.height),
        quotedHeight: Math.round(quotedRect.height),
        bottomSlack: Math.round(messageRect.bottom - quotedRect.bottom),
        scrollerBottomSlack: Math.round(scrollerRect.bottom - messageRect.bottom),
      };
    });
    expect(geometry.bottomSlack).toBeLessThan(32);
    expect(geometry.messageHeight).toBeLessThan(geometry.quotedHeight + 96);
    expect(geometry.scrollerBottomSlack).toBeLessThan(64);
  });

  test("quoted preview resolves permalink followed by CJK punctuation and latin text", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const targetChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `quote-cjk-target-${Date.now().toString(36)}`,
    );
    const previewChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `quote-cjk-preview-${Date.now().toString(36)}`,
    );
    const target = await postMessage(
      request,
      seedState,
      login.accessToken,
      targetChannel.id,
      "CJK punctuation permalink target",
    );
    const permalink = `${seedState.urls.web}/s/${seedState.server.slug}/channel/${targetChannel.id}?msg=${target.id}`;
    const preview = await postMessage(
      request,
      seedState,
      login.accessToken,
      previewChannel.id,
      `谁做一下 ${permalink}，Kevin 不适合做这个`,
    );

    await page.goto(`/s/${seedState.server.slug}/channel/${previewChannel.id}?msg=${preview.id}`);
    await expect(page.locator(`#message-${preview.id}`)).toBeVisible();
    const quotedCard = page.getByTestId("quoted-message-card");
    await expect(quotedCard).toBeVisible();
    await expect(quotedCard).toContainText("CJK punctuation permalink target");
    await expect(quotedCard).not.toContainText("Message unavailable");
  });
});

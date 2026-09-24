import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding, newAuthenticatedContext } from "../../fixtures/session";

test.describe("P0 thread reopen consistency", () => {
  test("replies stay in thread and reopening preserves the same thread history", async ({
    browser,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const context = await newAuthenticatedContext(browser, {
      accessToken: login.accessToken,
      refreshToken: login.refreshToken,
      serverSlug: seedState.server.slug,
    });
    const threadPage = await context.newPage();

    try {
      const parentContent = `P0 thread parent ${Date.now()}`;
      const firstReply = `P0 thread first reply ${Date.now()}`;
      const secondReply = `P0 thread second reply ${Date.now()}`;

      const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          channelId: seedState.channel.id,
          content: parentContent,
        },
      });
      expect(parentResponse.ok()).toBeTruthy();
      const parentMessage = await parentResponse.json() as { id: string };

      const threadResponse = await request.post(
        `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
        {
          headers: {
            Authorization: `Bearer ${login.accessToken}`,
            "X-Server-Id": seedState.server.id,
          },
          data: {
            parentMessageId: parentMessage.id,
            content: firstReply,
          },
        },
      );
      expect(threadResponse.ok()).toBeTruthy();

      await threadPage.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
      const parentMessageCard = threadPage.locator(`#message-${parentMessage.id}`).first();
      await parentMessageCard.scrollIntoViewIfNeeded();
      await expect(parentMessageCard).toBeVisible();
      await parentMessageCard.hover();
      await parentMessageCard.getByLabel("Reply in thread").click();

      const threadScroller = threadPage.getByTestId("thread-message-scroller");
      const threadComposer = threadPage.getByPlaceholder("Message thread");
      const inlineReplies = parentMessageCard.locator(
        '[data-message-affordance="inline-thread-replies"]',
      );

      await expect(threadPage.getByText("Thread").first()).toBeVisible();
      await expect(threadScroller.getByText(firstReply)).toBeVisible();
      await expect(inlineReplies).toContainText(firstReply);

      await threadPage.getByTitle("Close thread").click();
      await expect(threadScroller).toHaveCount(0);
      await expect(threadComposer).toHaveCount(0);

      await parentMessageCard.hover();
      await parentMessageCard.getByLabel("Reply in thread").click();
      await expect(threadScroller.getByText(firstReply)).toBeVisible();

      await threadComposer.fill(secondReply);
      // The composer renders an optimistic row before POST /api/v2/messages has
      // completed. Closing the browser context on that optimistic signal aborts
      // the in-flight request; with the shared pglite e2e server, that leaves
      // the database queue wedged and every later spec stalls in auth login.
      // Pin the persisted-response boundary before treating the send as done.
      const [sendResponse] = await Promise.all([
        threadPage.waitForResponse((response) =>
          response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/v2/messages"
        ),
        threadComposer.press("Enter"),
      ]);
      expect(sendResponse.ok()).toBeTruthy();

      await expect(threadScroller.getByText(secondReply)).toBeVisible();
      await expect(inlineReplies).toContainText(secondReply);
    } finally {
      await context.close();
    }

    // Verify the shared API's database path is still live after context
    // teardown. This catches future optimistic-send races at the initiating
    // spec instead of misreporting every following spec as an auth failure.
    const healthResponse = await request.get(`${seedState.urls.api}/health`, { timeout: 5_000 });
    expect(healthResponse.ok()).toBeTruthy();
  });
});

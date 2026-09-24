import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import {
  dismissOwnerOnboarding,
  loginWithCredentials,
  newAuthenticatedContext,
} from "../../fixtures/session";

test.describe("P0 DM messaging", () => {
  test("open DM from human detail and send a message in the same DM", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const dmMessage = `P0 DM send ${Date.now()}`;

    await page.goto(`/s/${seedState.server.slug}/human/${seedState.extraHuman.userId}?sidebarTab=members`);
    await page.getByRole("button", { name: "Message" }).click();

    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/dm/`));
    await page.locator("textarea").fill(dmMessage);
    await page.getByRole("button", { name: /^Send$/ }).click();

    const sentMessage = page.getByTestId("message-scroller").getByText(dmMessage);
    await expect(sentMessage).toBeVisible({ timeout: 15000 });
    await expect(sentMessage).toHaveCount(1);
  });

  test("reply from the other participant stays in the same DM and arrives realtime", async ({
    browser,
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

    const dmResponse = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: {
        Authorization: `Bearer ${ownerLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { userId: seedState.extraHuman.userId },
    });
    expect(dmResponse.ok()).toBeTruthy();
    const dmChannel = await dmResponse.json() as { id: string };

    const extraHumanLogin = await loginWithCredentials(
      request,
      seedState.urls.api,
      seedState.extraHuman.email,
      seedState.extraHuman.password,
    );

    const extraHumanContext = await newAuthenticatedContext(browser, {
      accessToken: extraHumanLogin.accessToken,
      refreshToken: extraHumanLogin.refreshToken,
      serverSlug: seedState.server.slug,
    });
    const extraHumanPage = await extraHumanContext.newPage();
    const replyMessage = `P0 DM realtime reply ${Date.now()}`;

    try {
      await page.goto(`/s/${seedState.server.slug}/dm/${dmChannel.id}`);
      await expect(page).toHaveURL(new RegExp(`/dm/${dmChannel.id}$`));
      // A newly-created DM can legitimately be empty. In that state the chat
      // surface renders the composer and empty-state copy, not a message
      // scroller. The composer is the load-bearing readiness signal before the
      // peer sends the first message.
      await expect(page.locator("textarea")).toBeVisible();

      await extraHumanPage.goto(`/s/${seedState.server.slug}/dm/${dmChannel.id}`);
      await expect(extraHumanPage).toHaveURL(new RegExp(`/dm/${dmChannel.id}$`));
      await extraHumanPage.locator("textarea").fill(replyMessage);
      await extraHumanPage.getByRole("button", { name: /^Send$/ }).click();

      const receivedReply = page.getByTestId("message-scroller").getByText(replyMessage);
      await expect(receivedReply).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/dm/${dmChannel.id}$`));
      await expect(receivedReply).toHaveCount(1);
    } finally {
      await extraHumanContext.close();
    }
  });
});

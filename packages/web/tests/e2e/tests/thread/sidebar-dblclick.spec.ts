import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import {
  dismissOwnerOnboarding,
  loginWithCredentials,
} from "../../fixtures/session";

test.describe("Threads sidebar entry click vs. double-click", () => {
  test("single click navigates to /inbox", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const inboxButton = page.getByRole("button", { name: /^Activity/ }).first();
    await expect(inboxButton).toBeVisible();

    await inboxButton.click();

    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    await expect(page.getByTestId("thread-panel-parent")).toHaveCount(0);
  });

  test("double-click with an unread thread lands in /inbox + highlights the first unread row without opening the thread panel", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

    const parentContent = `dblclick parent ${Date.now()}`;
    const replyContent = `dblclick reply ${Date.now()}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${ownerLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = await parentResponse.json() as { id: string };

    const followResponse = await request.post(
      `${seedState.urls.api}/api/channels/threads/follow`,
      {
        headers: {
          Authorization: `Bearer ${ownerLogin.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMessage.id },
      },
    );
    expect(followResponse.ok()).toBeTruthy();
    const { threadChannelId } = await followResponse.json() as { threadChannelId: string };

    const extraHumanLogin = await loginWithCredentials(
      request,
      seedState.urls.api,
      seedState.extraHuman.email,
      seedState.extraHuman.password,
    );
    const r = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${extraHumanLogin.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMessage.id, content: replyContent },
      },
    );
    expect(r.ok()).toBeTruthy();

    await expect.poll(async () => {
      const followed = await request.get(
        `${seedState.urls.api}/api/channels/threads/followed`,
        {
          headers: {
            Authorization: `Bearer ${ownerLogin.accessToken}`,
            "X-Server-Id": seedState.server.id,
          },
        },
      );
      expect(followed.ok()).toBeTruthy();
      const followedBody = await followed.json() as { threads: Array<{ threadChannelId: string; unreadCount: number }> };
      return followedBody.threads.find((t) => t.threadChannelId === threadChannelId)?.unreadCount ?? 0;
    }).toBeGreaterThan(0);

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

    const inboxButton = page.getByRole("button", { name: /^Activity/ }).first();
    await expect(inboxButton).toBeVisible();

    await inboxButton.dblclick();

    // huxijin's revised UX: the dblclick should keep the user in the Inbox
    // inbox surface (NOT auto-open the right thread panel) and highlight the
    // matching row so they can scan adjacent unread threads.
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/activity$`));
    await expect(page.getByTestId("thread-panel-parent")).toHaveCount(0);

    // The first unread row gets the transient focus state. The visual style is
    // intentionally shared with message permalink focus, not selected-tab yellow.
    const focusedRow = page
      .locator('[data-testid="inbox-row"][data-focused="true"]')
      .filter({ hasText: replyContent });
    await expect(focusedRow).toBeVisible();

    // Server-side unread count should NOT have been cleared — we never opened
    // the thread, just landed in the inbox.
    const followedAfter = await request.get(
      `${seedState.urls.api}/api/channels/threads/followed`,
      {
        headers: {
          Authorization: `Bearer ${ownerLogin.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
      },
    );
    const followedBody = await followedAfter.json() as { threads: Array<{ threadChannelId: string; unreadCount: number }> };
    expect(followedBody.threads.find((t) => t.threadChannelId === threadChannelId)?.unreadCount).toBeGreaterThan(0);
  });
});

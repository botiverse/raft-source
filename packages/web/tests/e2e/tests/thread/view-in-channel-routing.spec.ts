import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// Covers the bug Jianwei filed in #engineering task #288: on mobile, tapping
// "View in channel" inside a DM thread routed to /channel/<dmId> instead of
// /dm/<dmId> (404), and a leftover closeThread() call raced the freshly-pushed
// ?msg= query, replacing it with the old thread URL.
test.describe("thread view-in-channel routing", () => {
  test("mobile: channel thread → /channel/<id>?msg=<parentId>", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `Channel thread parent ${Date.now()}`;
    const reply = `Channel thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?thread=${seedState.channel.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
    await expect(page.getByTestId("thread-mobile-back")).toBeVisible();

    const viewInChannel = page.getByRole("button", { name: "View in channel" });
    await expect(viewInChannel).not.toHaveAttribute("title", /.+/);
    await viewInChannel.hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("View in channel");
    await viewInChannel.click();

    await expect(page).toHaveURL(
      new RegExp(
        `/s/${seedState.server.slug}/channel/${seedState.channel.id}\\?msg=${parentMsg.id}$`,
      ),
    );
    await expect(page.getByTestId("thread-message-scroller")).toHaveCount(0);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
  });

  test("mobile: DM thread → /dm/<id>?msg=<parentId> (no /channel/ rewrite, no race)", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const dmResp = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { userId: seedState.extraHuman.userId },
    });
    expect(dmResp.ok()).toBeTruthy();
    const dm = (await dmResp.json()) as { id: string };

    const parentContent = `DM thread parent ${Date.now()}`;
    const reply = `DM thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: dm.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${dm.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/dm/${dm.id}?thread=${dm.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();
    await expect(page.getByTestId("thread-mobile-back")).toBeVisible();

    await page.getByRole("button", { name: "View in channel" }).click();

    // Critical: the path is /dm/, not /channel/, AND ?msg= survives (the
    // old closeThread() race wiped the query, leaving us at /dm/<id> alone).
    await expect(page).toHaveURL(
      new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${parentMsg.id}$`),
    );
    await expect(page.getByTestId("thread-message-scroller")).toHaveCount(0);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
  });

  test("desktop: DM thread → toDmMessage builds /dm/ permalink", async ({
    page,
    request,
  }) => {
    // Default desktop viewport — ThreadPanel keeps the side-by-side layout.
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const dmResp = await request.post(`${seedState.urls.api}/api/channels/dm`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { userId: seedState.extraHuman.userId },
    });
    expect(dmResp.ok()).toBeTruthy();
    const dm = (await dmResp.json()) as { id: string };

    const parentContent = `DM desktop thread parent ${Date.now()}`;
    const reply = `DM desktop thread reply ${Date.now()}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: dm.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${dm.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    await page.goto(
      `/s/${seedState.server.slug}/dm/${dm.id}?thread=${dm.id}:${parentMsg.id}`,
    );
    await expect(page.getByTestId("thread-message-scroller")).toBeVisible();

    await page.getByRole("button", { name: "View in channel" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/s/${seedState.server.slug}/dm/${dm.id}\\?msg=${parentMsg.id}$`),
    );
  });

  test("desktop: thread panel does not render parent channel context when msg points outside the thread", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const runId = Date.now();
    const parentContent = `Thread scoped parent ${runId}`;
    const reply = `Thread scoped reply ${runId}`;
    const unrelatedChannelMessage = `Thread scoped unrelated channel message ${runId}`;

    const parent = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: parentContent },
    });
    expect(parent.ok()).toBeTruthy();
    const parentMsg = (await parent.json()) as { id: string };

    const threadResp = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: reply },
      },
    );
    expect(threadResp.ok()).toBeTruthy();

    const unrelated = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { channelId: seedState.channel.id, content: unrelatedChannelMessage },
    });
    expect(unrelated.ok()).toBeTruthy();
    const unrelatedMsg = (await unrelated.json()) as { id: string };

    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?thread=${seedState.channel.id}:${parentMsg.id}&msg=${unrelatedMsg.id}`,
    );

    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller).toBeVisible({ timeout: 15000 });
    await expect(threadScroller.getByText(reply)).toBeVisible();
    await expect(threadScroller.getByText(unrelatedChannelMessage)).toHaveCount(0);
  });
});

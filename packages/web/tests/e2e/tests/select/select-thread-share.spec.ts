import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { clickShareMessagesMenu } from "../../fixtures/contextMenu";

// v1.4 contract (scope option A — "what you see is what you share"):
//   - Channel timeline share is anchored to the single message the user
//     right-clicked. Thread replies are not auto-included because they may
//     not be mounted in the DOM (the share PNG only renders DOM rows).
//   - To share a thread, the user opens the thread panel and triggers Share
//     from there; the toolbar then mounts inside the panel, starts with only
//     the clicked message selected, and exposes Select all for parent + replies.

test("channel select mode selects only the right-clicked message (thread replies not auto-included)", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();

  const tag = `selthread-${Date.now()}`;
  const parent = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: `${tag} parent` },
  });
  expect(parent.ok()).toBeTruthy();
  const parentMsg = (await parent.json()) as { id: string };
  for (const i of [0, 1, 2]) {
    const r = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: `${tag} reply ${i}` },
      },
    );
    expect(r.ok()).toBeTruthy();
  }

  // Right-click the parent in the channel timeline and pick Share messages…
  const parentCard = page.locator(`#message-${parentMsg.id}`).first();
  await parentCard.scrollIntoViewIfNeeded();
  await clickShareMessagesMenu(page, parentCard);

  // Only the parent itself — replies are reached via the thread panel.
  await expect(page.getByTestId("select-mode-toolbar")).toBeVisible();
  await expect(page.getByTestId("select-mode-count")).toHaveText("1 selected");
  await expect(page.getByTestId("select-mode-select-all")).toHaveCount(0);

  // Cancel cleans up.
  await page.getByTestId("select-mode-cancel").click();
  await expect(page.getByTestId("select-mode-toolbar")).toHaveCount(0);
});

test("ThreadPanel select mode mounts toolbar in the thread, not in the channel", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();

  const tag = `selthr2-${Date.now()}`;
  const parent = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId: seedState.channel.id, content: `${tag} parent` },
  });
  const parentMsg = (await parent.json()) as { id: string };
  for (const i of [0, 1]) {
    await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: { parentMessageId: parentMsg.id, content: `${tag} reply ${i}` },
      },
    );
  }

  const parentCard = page.locator(`#message-${parentMsg.id}`).first();
  await parentCard.scrollIntoViewIfNeeded();
  await parentCard.hover();
  // The hover-only affordance is incidental here; this test is about thread
  // select-mode routing after the panel opens.
  await parentCard.getByLabel("Reply in thread").click({ force: true });
  const threadScroller = page.getByTestId("thread-message-scroller");
  await expect(threadScroller.getByText(`${tag} reply 1`)).toBeVisible();

  // Right-click a reply inside the thread → Share messages… enters thread
  // mode anchored at the parent, but only the clicked reply is pre-selected.
  await clickShareMessagesMenu(page, threadScroller.getByText(`${tag} reply 0`));

  // Toolbar appears inside the thread. ChatPanel below should *not* render its
  // own toolbar in thread mode.
  const toolbars = page.getByTestId("select-mode-toolbar");
  await expect(toolbars).toHaveCount(1);
  await expect(page.getByTestId("select-mode-count")).toHaveText("1 selected");

  // Thread mode offers an explicit Select all for parent + replies.
  await page.getByTestId("select-mode-select-all").click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("3 selected");

  await page.getByTestId("select-mode-cancel").click();
  await expect(toolbars).toHaveCount(0);
});

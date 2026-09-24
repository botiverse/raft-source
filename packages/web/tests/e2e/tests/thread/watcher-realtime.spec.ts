import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import {
  dismissOwnerOnboarding,
  loginWithCredentials,
  newAuthenticatedContext,
} from "../../fixtures/session";

function headers(seedState: Awaited<ReturnType<typeof waitForSeedState>>, accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": seedState.server.id,
  };
}

async function createChannel(
  request: APIRequestContext,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
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

async function addChannelHuman(
  request: APIRequestContext,
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  channelId: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/members`, {
    headers: headers(seedState, accessToken),
    data: { userId },
  });
  expect(response.ok()).toBeTruthy();
}

test("public thread watcher receives new replies realtime without following", async ({
  browser,
  request,
}) => {
  const seedState = await waitForSeedState();
  const ownerLogin = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

  const watcherLogin = await loginWithCredentials(
    request,
    seedState.urls.api,
    seedState.extraHuman.email,
    seedState.extraHuman.password,
  );
  await dismissOwnerOnboarding(request, seedState, watcherLogin.accessToken);

  const parentContent = `Thread watcher parent ${Date.now()}`;
  const initialReply = `Thread watcher initial ${Date.now()}`;
  const liveReply = `Thread watcher live ${Date.now()}`;

  const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${ownerLogin.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: parentContent,
    },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parentMessage = await parentResponse.json() as { id: string };

  const initialThreadResponse = await request.post(
    `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
    {
      headers: {
        Authorization: `Bearer ${ownerLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        parentMessageId: parentMessage.id,
        content: initialReply,
      },
    },
  );
  expect(initialThreadResponse.ok()).toBeTruthy();

  const watcherContext = await newAuthenticatedContext(browser, {
    accessToken: watcherLogin.accessToken,
    refreshToken: watcherLogin.refreshToken,
    serverSlug: seedState.server.slug,
  });
  const watcherPage = await watcherContext.newPage();

  try {
    await watcherPage.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const parentMessageCard = watcherPage.locator(`#message-${parentMessage.id}`).first();
    await parentMessageCard.scrollIntoViewIfNeeded();
    await expect(parentMessageCard).toBeVisible();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = watcherPage.getByTestId("thread-message-scroller");
    await expect(threadScroller.getByText(initialReply)).toBeVisible();

    const followedBeforeResponse = await request.get(`${seedState.urls.api}/api/channels/threads/followed`, {
      headers: {
        Authorization: `Bearer ${watcherLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
    });
    expect(followedBeforeResponse.ok()).toBeTruthy();
    const followedBefore = await followedBeforeResponse.json() as { threads: Array<{ parentMessageId: string }> };
    expect(followedBefore.threads.some((thread) => thread.parentMessageId === parentMessage.id)).toBeFalsy();

    const liveReplyResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${ownerLogin.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          parentMessageId: parentMessage.id,
          content: liveReply,
        },
      },
    );
    expect(liveReplyResponse.ok()).toBeTruthy();

    await expect(threadScroller.getByText(liveReply)).toBeVisible();
  } finally {
    await watcherContext.close();
  }
});

test("parent activity mute suppresses channel root while followed thread still promotes live Activity", async ({
  page,
  request,
}) => {
  const seedState = await waitForSeedState();
  const ownerLogin = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

  const extraHumanLogin = await loginWithCredentials(
    request,
    seedState.urls.api,
    seedState.extraHuman.email,
    seedState.extraHuman.password,
  );
  await dismissOwnerOnboarding(request, seedState, extraHumanLogin.accessToken);

  const runId = Date.now().toString(36);
  const channel = await createChannel(
    request,
    seedState,
    ownerLogin.accessToken,
    `muted-live-${runId}`,
  );
  await addChannelHuman(request, seedState, ownerLogin.accessToken, channel.id, seedState.extraHuman.userId);

  const parentContent = `muted live parent ${runId}`;
  const preMuteReply = `muted live pre ${runId}`;
  const mutedLiveReply = `muted live ordinary ${runId}`;
  const mutedRootMessage = `muted root ordinary ${runId}`;

  const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(seedState, ownerLogin.accessToken),
    data: {
      channelId: channel.id,
      content: parentContent,
    },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parentMessage = await parentResponse.json() as { id: string };

  const followResponse = await request.post(`${seedState.urls.api}/api/channels/threads/follow`, {
    headers: headers(seedState, ownerLogin.accessToken),
    data: { parentMessageId: parentMessage.id },
  });
  expect(followResponse.ok()).toBeTruthy();

  const preMuteReplyResponse = await request.post(
    `${seedState.urls.api}/api/channels/${channel.id}/threads`,
    {
      headers: headers(seedState, extraHumanLogin.accessToken),
      data: {
        parentMessageId: parentMessage.id,
        content: preMuteReply,
      },
    },
  );
  expect(preMuteReplyResponse.ok()).toBeTruthy();

  const muteResponse = await request.patch(
    `${seedState.urls.api}/api/channels/${channel.id}/notification-settings`,
    {
      headers: headers(seedState, ownerLogin.accessToken),
      data: { activityMuted: true },
    },
  );
  expect(muteResponse.ok()).toBeTruthy();
  await expect(await muteResponse.json() as { activityMuted: boolean }).toMatchObject({ activityMuted: true });

  const mutedRootResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(seedState, extraHumanLogin.accessToken),
    data: {
      channelId: channel.id,
      content: mutedRootMessage,
    },
  });
  expect(mutedRootResponse.ok()).toBeTruthy();

  await page.goto(`/s/${seedState.server.slug}/activity`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  const threadRow = page.getByTestId("inbox-row")
    .filter({
      has: page.locator('[data-testid="conversation-card-title-icon"][data-kind="thread"]'),
    })
    .filter({ hasText: parentContent });
  await expect(threadRow).toBeVisible();
  await expect(threadRow).toContainText(preMuteReply);
  await expect(threadRow).not.toContainText(mutedLiveReply);
  await expect(page.getByText(mutedRootMessage, { exact: true })).not.toBeVisible();

  await threadRow.click();
  const threadScroller = page.getByTestId("thread-message-scroller");
  await expect(threadScroller).toBeVisible();
  await expect(threadScroller.getByText(preMuteReply)).toBeVisible();

  const mutedReplyResponse = await request.post(
    `${seedState.urls.api}/api/channels/${channel.id}/threads`,
    {
      headers: headers(seedState, extraHumanLogin.accessToken),
      data: {
        parentMessageId: parentMessage.id,
        content: mutedLiveReply,
      },
    },
  );
  expect(mutedReplyResponse.ok()).toBeTruthy();

  await expect(threadScroller.getByText(mutedLiveReply)).toBeVisible();
  await expect(threadRow).toContainText(mutedLiveReply);
  await expect(threadRow).not.toContainText(preMuteReply);
  await expect(page.getByText(mutedRootMessage, { exact: true })).not.toBeVisible();
});

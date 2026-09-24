import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import {
  dismissOwnerOnboarding,
  loginWithCredentials,
  newAuthenticatedContext,
} from "../../fixtures/session";

function headers(token: string, serverId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(serverId ? { "X-Server-Id": serverId } : {}),
  };
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: headers(token, seedState.server.id),
    data: {
      name,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

async function addChannelHuman(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  token: string,
  channelId: string,
  userId: string,
) {
  const response = await request.post(
    `${seedState.urls.api}/api/channels/${channelId}/members`,
    {
      headers: headers(token, seedState.server.id),
      data: { userId },
    },
  );
  expect(response.ok()).toBeTruthy();
}

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  token: string,
  serverId: string,
  channelId: string,
  content: string,
): Promise<{ id: string; content: string }> {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(token, serverId),
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; content: string }>;
}

test.describe("joint channel permalink previews", () => {
  test("thread reply previews are visible to joint members and unavailable to non-members", async ({
    browser,
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

    const runId = Date.now().toString(36);
    const outsider = await loginWithCredentials(
      request,
      seedState.urls.api,
      seedState.extraHuman.email,
      seedState.extraHuman.password,
    );

    const targetServerResponse = await request.post(`${seedState.urls.api}/api/servers`, {
      headers: headers(ownerLogin.accessToken),
      data: {
        name: `Joint Target ${runId}`,
        slug: `joint-target-${runId}`,
      },
    });
    expect(targetServerResponse.ok()).toBeTruthy();
    const targetServer = await targetServerResponse.json() as { id: string; slug: string };

    const createJointResponse = await request.post(`${seedState.urls.api}/api/channels`, {
      headers: headers(ownerLogin.accessToken, seedState.server.id),
      data: {
        name: `joint-e2e-${runId}`,
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [seedState.user.email],
      },
    });
    expect(createJointResponse.ok()).toBeTruthy();
    const hostProjection = await createJointResponse.json() as {
      id: string;
      jointInvite: { id: string };
    };

    const acceptResponse = await request.post(
      `${seedState.urls.api}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`,
      {
        headers: headers(ownerLogin.accessToken, targetServer.id),
      },
    );
    expect(acceptResponse.ok()).toBeTruthy();

    const containingChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `joint-preview-container-${runId}`,
    );
    await addChannelHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      containingChannel.id,
      seedState.extraHuman.userId,
    );

    const parent = await postMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      seedState.server.id,
      hostProjection.id,
      `Joint permalink parent ${runId}`,
    );

    const threadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${hostProjection.id}/threads`,
      {
        headers: headers(ownerLogin.accessToken, seedState.server.id),
        data: { parentMessageId: parent.id },
      },
    );
    expect(threadResponse.ok()).toBeTruthy();
    const thread = await threadResponse.json() as { threadChannelId: string };

    const targetContent = `Joint permalink reply target ${runId}`;
    const reply = await postMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      seedState.server.id,
      thread.threadChannelId,
      targetContent,
    );

    const permalink = `${seedState.urls.web}/s/${seedState.server.slug}/channel/${hostProjection.id}?thread=${hostProjection.id}:${parent.id}&msg=${reply.id}`;
    const preview = await postMessage(
      request,
      seedState,
      ownerLogin.accessToken,
      seedState.server.id,
      containingChannel.id,
      `joint permalink preview ${permalink}`,
    );

    await page.goto(`/s/${seedState.server.slug}/channel/${containingChannel.id}?msg=${preview.id}`);
    const memberPreviewCard = page.locator(`#message-${preview.id}`).getByTestId("quoted-message-card");
    await expect(memberPreviewCard).toBeVisible();
    await expect(memberPreviewCard).toContainText(targetContent);
    await expect(memberPreviewCard).not.toContainText("Message unavailable");

    const outsiderContext = await newAuthenticatedContext(browser, {
      accessToken: outsider.accessToken,
      refreshToken: outsider.refreshToken,
      serverSlug: seedState.server.slug,
    });
    const outsiderPage = await outsiderContext.newPage();
    try {
      await outsiderPage.goto(
        `/s/${seedState.server.slug}/channel/${containingChannel.id}?msg=${preview.id}`,
      );
      const outsiderMessage = outsiderPage.locator(`#message-${preview.id}`);
      await expect(outsiderMessage).toBeVisible();
      const unavailableMarker = outsiderMessage.getByText("Unavailable linked message", {
        exact: true,
      });
      await expect(unavailableMarker).toBeVisible();
      await expect(unavailableMarker).toHaveCount(1);
      await expect(
        outsiderMessage.locator("a").filter({ hasText: "Unavailable linked message" }),
      ).toHaveCount(0);
      for (const privateTargetId of [hostProjection.id, parent.id, reply.id]) {
        await expect(
          outsiderMessage.locator(
            `[href*="${privateTargetId}"], [title*="${privateTargetId}"]`,
          ),
        ).toHaveCount(0);
      }
      await expect(outsiderMessage.getByTestId("quoted-message-card")).toHaveCount(0);
      await expect(outsiderMessage).not.toContainText(targetContent);
      await expect(outsiderMessage).not.toContainText(`#joint-e2e-${runId}`);
      await expect(outsiderMessage).not.toContainText(permalink);
    } finally {
      await outsiderContext.close();
    }
  });
});

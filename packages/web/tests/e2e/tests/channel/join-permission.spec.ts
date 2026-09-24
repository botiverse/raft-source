import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import {
  dismissOwnerOnboarding,
  loginWithCredentials,
  newAuthenticatedContext,
} from "../../fixtures/session";

test.describe("P0 channel join and permission boundary", () => {
  test("unjoined member sees join gate before they can send", async ({
    browser,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);

    const channelName = `p0-join-${Date.now()}`;
    const createChannelResponse = await request.post(`${seedState.urls.api}/api/channels`, {
      headers: {
        Authorization: `Bearer ${ownerLogin.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        name: channelName,
        description: "Playwright join gate",
      },
    });
    expect(createChannelResponse.ok()).toBeTruthy();
    const createdChannel = await createChannelResponse.json() as { id: string; name: string };

    const extraHumanLogin = await loginWithCredentials(
      request,
      seedState.urls.api,
      seedState.extraHuman.email,
      seedState.extraHuman.password,
    );

    const memberContext = await newAuthenticatedContext(browser, {
      accessToken: extraHumanLogin.accessToken,
      refreshToken: extraHumanLogin.refreshToken,
      serverSlug: seedState.server.slug,
    });
    const memberPage = await memberContext.newPage();

    try {
      await memberPage.goto(`/s/${seedState.server.slug}/channel/${createdChannel.id}`);

      await expect(
        memberPage.getByRole("button", { name: `Join #${createdChannel.name}` }),
      ).toBeVisible();
      await expect(
        memberPage.getByPlaceholder(`Message #${createdChannel.name}`),
      ).toHaveCount(0);

      await memberPage.getByRole("button", { name: `Join #${createdChannel.name}` }).click();
      await expect(
        memberPage.getByPlaceholder(`Message #${createdChannel.name}`),
      ).toBeVisible();

      const joinedMessage = `Joined channel message ${Date.now()}`;
      await memberPage.getByPlaceholder(`Message #${createdChannel.name}`).fill(joinedMessage);
      await memberPage.getByRole("button", { name: /^Send$/ }).click();
      await expect(memberPage.getByText(joinedMessage)).toBeVisible();
    } finally {
      await memberContext.close();
    }
  });
});

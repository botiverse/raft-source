import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding, loginWithCredentials } from "../../fixtures/session";

function headers(seedState: PlaywrightSeedState, accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": seedState.server.id,
  };
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
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

async function createMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: headers(seedState, accessToken),
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string }>;
}

async function addChannelHuman(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
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

test.describe("Inbox Mentions filter (Plan A)", () => {
  // Plan A spec from #proj-uiux:6beb878c msg=691ade99 (Joy + tygg, 2026-05-12):
  // The Mentions filter aggregates by channel/thread and includes rows where
  // the user has been @-mentioned regardless of read state. Reading a mention
  // must NOT drop the row from the Mentions tab — users want to find historical
  // mentions, not just unread ones.
  test("shows mention rows even after they're read; non-mention rows stay hidden", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const ownerLogin = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, ownerLogin.accessToken);
    const extraHumanLogin = await loginWithCredentials(
      request,
      seedState.urls.api,
      seedState.extraHuman.email,
      seedState.extraHuman.password,
    );
    const runId = Date.now().toString(36);

    // Channel A: extraHuman @-mentions the owner. Should appear in Mentions.
    const mentionChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-mentions-${runId}`,
    );
    await addChannelHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      mentionChannel.id,
      seedState.extraHuman.userId,
    );
    const mentionText = `inbox mention @${seedState.user.name} ${runId}`;
    await createMessage(
      request,
      seedState,
      extraHumanLogin.accessToken,
      mentionChannel.id,
      mentionText,
    );

    // Channel B: plain unread message, no mention. Must NOT appear in Mentions.
    const noMentionChannel = await createChannel(
      request,
      seedState,
      ownerLogin.accessToken,
      `inbox-no-mention-${runId}`,
    );
    await addChannelHuman(
      request,
      seedState,
      ownerLogin.accessToken,
      noMentionChannel.id,
      seedState.extraHuman.userId,
    );
    const noMentionText = `inbox no mention plain message ${runId}`;
    await createMessage(
      request,
      seedState,
      extraHumanLogin.accessToken,
      noMentionChannel.id,
      noMentionText,
    );

    await page.goto(`/s/${seedState.server.slug}/inbox`);
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await expect(page.getByTestId("inbox-filter-mentions")).toBeVisible();

    // All filter — both channels visible.
    const rows = page.getByTestId("inbox-row");
    await expect(rows.filter({ hasText: mentionText })).toBeVisible();
    await expect(rows.filter({ hasText: noMentionText })).toBeVisible();

    // Mentions filter — only the @-mentioned channel.
    await page.getByTestId("inbox-filter-mentions").click();
    await expect(rows.filter({ hasText: mentionText })).toBeVisible();
    await expect(rows.filter({ hasText: noMentionText })).toHaveCount(0);

    // Mark the @-mentioned channel as read via API. Plan A: row must persist.
    const readResponse = await request.post(
      `${seedState.urls.api}/api/channels/${mentionChannel.id}/read-all`,
      { headers: headers(seedState, ownerLogin.accessToken) },
    );
    expect(readResponse.ok()).toBeTruthy();

    // Reload to refetch inbox. Mentions tab still shows the now-read row.
    await page.goto(`/s/${seedState.server.slug}/inbox`);
    await page.getByTestId("inbox-filter-mentions").click();
    const persistedRow = page.getByTestId("inbox-row").filter({ hasText: mentionText });
    await expect(persistedRow).toBeVisible();
    await expect(persistedRow).not.toContainText(" new");

    // Unread filter — read row should NOT appear.
    await page.getByTestId("inbox-filter-unread").click();
    await expect(page.getByTestId("inbox-row").filter({ hasText: mentionText })).toHaveCount(0);

    // Marking the row done removes it from Mentions (consistent with All).
    await page.getByTestId("inbox-filter-mentions").click();
    const mentionRow = page.getByTestId("inbox-row").filter({ hasText: mentionText });
    await expect(mentionRow).toBeVisible();
    // The card reveals pointer actions on hover.
    await mentionRow.hover();
    await mentionRow.getByTitle("Mark as Done").click();
    await expect(page.getByTestId("inbox-row").filter({ hasText: mentionText })).toHaveCount(0);
  });
});

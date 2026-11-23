import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

// #proj-workspace:#331. A thread folded over the chat (the row too narrow for the
// channel and the thread side by side, #189 rule 3) shows Back in its head. Back
// closes the thread in place and shows the same channel's chat under it
// (design: patterns/responsive.md, "Folded, the thread lies over the chat"). It is
// never a step back in the browser's history: a thread the channel's memory
// restored on entry (useBesideMemory, replace) has no history entry of its own, so
// a step back left for the channel visited before.
test("Back on a folded, restored thread stays in its channel", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const headers = { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id };
  const suffix = Date.now();

  const otherResponse = await request.post(`${seedState.urls.api}/api/channels`, {
    headers,
    data: { name: `folded-back-${suffix}`, description: "Playwright folded thread Back" },
  });
  expect(otherResponse.ok()).toBeTruthy();
  const other = (await otherResponse.json()) as { id: string };

  const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers,
    data: { channelId: seedState.channel.id, content: `folded back parent ${suffix}` },
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parent = (await parentResponse.json()) as { id: string };
  const replyResponse = await request.post(`${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`, {
    headers,
    data: { parentMessageId: parent.id, content: `folded back reply ${suffix}` },
  });
  expect(replyResponse.ok()).toBeTruthy();

  const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;
  const threadInUrl = new RegExp(`thread=${seedState.channel.id}(?:%3A|:)${parent.id}`);

  // Wide: open the thread beside the chat, so the channel remembers it.
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.goto(channelPath);
  // Pin the sidebar so 900px folds whatever the default: 900 - 57 rail - 320 = 523 < 720.
  await page.evaluate(() => localStorage.setItem("slock:sidebarWidth", "320"));
  await page.reload();
  const parentCard = page.locator(`#message-${parent.id}`).first();
  await parentCard.scrollIntoViewIfNeeded();
  await expect(parentCard).toBeVisible();
  const inlineReplies = parentCard.locator('[data-message-affordance="inline-thread-replies"]');
  await expect(inlineReplies).toBeVisible();
  await inlineReplies.click();
  await expect(page).toHaveURL(threadInUrl);

  // To the other channel and back through the sidebar: entering the channel
  // restores its thread in place of the entry, with no history entry for it.
  await page.locator(`[data-sidebar-channel-id="${other.id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/channel/${other.id}`));
  await page.locator(`[data-sidebar-channel-id="${seedState.channel.id}"]`).first().click();
  await expect(page).toHaveURL(threadInUrl);

  // Narrow: the thread folds over the chat and its head shows Back.
  await page.setViewportSize({ width: 900, height: 700 });
  const threadColumn = page.getByTestId("thread-side-column");
  await expect(threadColumn).toHaveAttribute("data-covers");
  await expect(page.getByTestId("thread-mobile-back")).toBeVisible();

  await page.getByTestId("thread-mobile-back").click();
  await expect(threadColumn).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  await expect(page.locator(`#message-${parent.id}`).first()).toBeVisible();
});

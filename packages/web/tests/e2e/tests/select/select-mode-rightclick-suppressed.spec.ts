import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { clickShareMessagesMenu, shareMessagesMenu } from "../../fixtures/contextMenu";

// Once select mode is active, a second right-click on any message should NOT
// re-open the context menu. Per huxijin's 2026-05-01 feedback
// ("已经进入 multi select state 之后, should not right click again").
test("right-click on a message while select mode is active does not re-open context menu", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

  // Wait until the channel is rendered so the socket.io per-channel room is
  // joined before we POST messages (see "socket.io rooms have no buffer").
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

  // Seed two messages so there's something to right-click.
  const tag = `rightclick-suppress-${Date.now()}`;
  for (let i = 0; i < 2; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}` },
    });
  }
  await expect(page.getByText(`${tag} 0`).first()).toBeVisible();
  await expect(page.getByText(`${tag} 1`).first()).toBeVisible();

  // Enter select mode via right-click → "Share messages…"
  await clickShareMessagesMenu(page, page.getByText(`${tag} 0`).first());
  await expect(page.getByTestId("select-mode-toolbar")).toBeVisible();

  // Right-click on the OTHER message while select mode is active.
  // The context menu must NOT appear, and the "Share messages…" entry
  // in particular must be absent — we're already in select mode, a second
  // menu would only derail the flow.
  await page.getByText(`${tag} 1`).first().click({ button: "right" });
  // Give any delayed popup a tick to render if the guard were broken.
  await page.waitForTimeout(150);
  await expect(shareMessagesMenu(page)).toHaveCount(0);

  // Sanity: the right-click is still treated as a "toggle selection" tap
  // on the bubble is NOT the contract here — right-click on messages while
  // in select mode is just a no-op. Count should still be 1 (only the first
  // message is selected). Left-click remains the way to toggle selection.
  await expect(page.getByTestId("select-mode-count")).toHaveText("1 selected");

  // Cleanup
  await page.getByTestId("select-mode-cancel").click();
  await expect(page.getByTestId("select-mode-toolbar")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import {
  clickSelectModeMoreAction,
  clickShareMessagesMenu,
  openSelectModeMoreMenu,
} from "../../fixtures/contextMenu";

// Captures the share-preview contract: image sharing starts at one generic
// Share... toolbar entry, then artifact and platform actions live in the
// preview lightbox.
test("non-contiguous selection renders real Share preview content with an X target", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');
  await page.waitForTimeout(800);

  const tag = `sharex-${Date.now()}`;
  const lines = [
    "PR is up for the multi-select share flow",
    "nice — does Share preview still produce a real PNG?",
    "yep, html2canvas-pro is solid",
    "does skipping a row preserve the selection?",
    "yes — the last row is still included",
  ];
  for (let i = 0; i < lines.length; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}: ${lines[i]}` },
    });
  }
  await page.waitForSelector(`text=${tag} 4:`);
  await page.waitForTimeout(400);

  // Enter select mode, then select two non-adjacent rows.
  await clickShareMessagesMenu(page, page.getByText(`${tag} 0:`).first());
  await page.getByText(`${tag} 2:`).first().click();
  await page.getByText(`${tag} 4:`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("3 selected");
  await expect(page.getByTestId("select-mode-share-x")).toHaveCount(0);
  await expect(page.getByTestId("select-mode-more")).toBeVisible();

  await openSelectModeMoreMenu(page);
  await expect(page.getByTestId("select-mode-share-open")).toBeVisible();
  await expect(page.getByTestId("select-mode-share-open")).toHaveText(/Generate image/);
  await expect(page.getByTestId("select-mode-copy-md")).toBeVisible();

  await page.getByTestId("select-mode-share-open").click();
  const lightbox = page.getByTestId("select-share-lightbox");
  await expect(lightbox).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("select-share-lightbox-download")).toHaveText(/Download/);
  await expect(page.getByTestId("select-share-lightbox-system-share")).toHaveCount(0);
  await expect(page.getByTestId("select-share-lightbox-share-x")).toHaveText(/Share to X/);

  const renderedImage = lightbox.locator("img");
  await expect(renderedImage).toBeVisible();
  const source = await renderedImage.getAttribute("src");
  expect(source).toMatch(/^data:image\/png;base64,/);
  expect(source?.split(",", 2)[1]?.length ?? 0).toBeGreaterThan(50_000);
});

test("select mode → Copy MD → clipboard contains **sender**: content format", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await page.waitForSelector('[data-testid="message-scroller"]');
  await page.waitForTimeout(800);

  const tag = `copymd-${Date.now()}`;
  const lines = [
    "PR is up for the multi-select share flow",
    "nice — does Share preview still produce a real PNG?",
    "yep, html2canvas-pro is solid",
  ];
  for (let i = 0; i < lines.length; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}: ${lines[i]}` },
    });
  }
  await page.waitForSelector(`text=${tag} 2:`);
  await page.waitForTimeout(400);

  // Enter select mode → pick all 3 messages
  await clickShareMessagesMenu(page, page.getByText(`${tag} 0:`).first());
  await page.getByText(`${tag} 1:`).first().click();
  await page.getByText(`${tag} 2:`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("3 selected");

  await clickSelectModeMoreAction(page, "select-mode-copy-md");

  // The More menu closes after the action; reopening shows the copied affordance.
  await openSelectModeMoreMenu(page);
  await expect(page.getByTestId("select-mode-copy-md")).toHaveText(/Copied MD/);

  const clip = await page.evaluate(() => navigator.clipboard.readText());

  // Format contract: **sender**: content per line, blank line between, no
  // hover-only buttons leaking in, sorted by chat order.
  expect(clip).toMatch(new RegExp(`\\*\\*[^*]+\\*\\*: ${tag} 0:`));
  expect(clip).toMatch(new RegExp(`\\*\\*[^*]+\\*\\*: ${tag} 1:`));
  expect(clip).toMatch(new RegExp(`\\*\\*[^*]+\\*\\*: ${tag} 2:`));
  // Order: 0 then 1 then 2
  const i0 = clip.indexOf(`${tag} 0:`);
  const i1 = clip.indexOf(`${tag} 1:`);
  const i2 = clip.indexOf(`${tag} 2:`);
  expect(i0).toBeLessThan(i1);
  expect(i1).toBeLessThan(i2);
});

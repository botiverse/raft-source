import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import {
  clickSelectModeMoreAction,
  clickShareMessagesMenu,
  openSelectModeMoreMenu,
} from "../../fixtures/contextMenu";

async function clearNativeSelection(page: Page) {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(page.getByRole("menu", { name: "Selected text actions" })).toBeHidden();
}

test("selection shortcut covers word and browser whole-paragraph triple-click selection", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const runId = Date.now().toString(36);
  const channelResponse = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
    data: { name: `selection-shortcut-${runId}` },
  });
  expect(channelResponse.ok()).toBe(true);
  const channel = await channelResponse.json() as { id: string };

  const content = `Selection shortcut plain message ${runId}`;
  const createResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId: channel.id, content },
  });
  expect(createResponse.ok()).toBe(true);

  await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  const messageBody = page.locator("[data-message-selectable='true']", {
    hasText: content,
  }).last();
  await expect(messageBody).toBeVisible();

  await messageBody.click({ clickCount: 2, position: { x: 8, y: 10 } });
  await expect(page.getByRole("menu", { name: "Selected text actions" })).toBeVisible();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe("Selection");
  await clearNativeSelection(page);

  await messageBody.click({ clickCount: 3, position: { x: 8, y: 10 } });
  const selectionShortcut = page.getByRole("menu", { name: "Selected text actions" });
  await expect(selectionShortcut).toBeVisible();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe(content);
  await page.waitForTimeout(150);

  // Keep the browser selection alive after Copy so the real
  // pointerdown -> mousedown -> mouseup -> click sequence proves the shortcut
  // mouseup listener cannot re-arm the menu after the click closes it.
  await page.evaluate(() => {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges = () => {};
  });
  await selectionShortcut.getByRole("menuitem", { name: "Copy" }).click();
  await expect(selectionShortcut).toBeHidden();
  await page.waitForTimeout(500);
  await expect(selectionShortcut).toBeHidden();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe(content);

  await messageBody.click({ clickCount: 3, position: { x: 8, y: 10 } });
  await expect(selectionShortcut).toBeVisible();
  await page.evaluate(() => {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges = () => {};
  });
  const keyboardCopy = selectionShortcut.getByRole("menuitem", { name: "Copy" });
  await keyboardCopy.focus();
  await keyboardCopy.press("Space");
  await expect(selectionShortcut).toBeHidden();
  await page.waitForTimeout(500);
  await expect(selectionShortcut).toBeHidden();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe(content);
});

test("selection shortcut appears after browser triple-click selects a rich text message", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const runId = Date.now().toString(36);
  const channelResponse = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
    data: { name: `selection-shortcut-rich-${runId}` },
  });
  expect(channelResponse.ok()).toBe(true);
  const channel = await channelResponse.json() as { id: string };

  const content = `我来查我这边 Quiver ${runId} 的 worktree/branch 状态。只会删 clean 且已经 merge 到 \`origin/main\` 的 worktree；如果有没有合的分支会单独列出来，不直接动。`;
  const createResponse = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
    data: { channelId: channel.id, content },
  });
  expect(createResponse.ok()).toBe(true);

  await page.goto(`/s/${seedState.server.slug}/channel/${channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();

  const messageBody = page.locator("[data-message-selectable='true']", {
    hasText: `Quiver ${runId} 的 worktree/branch 状态`,
  }).last();
  await expect(messageBody).toBeVisible();
  await expect(messageBody.locator("code", { hasText: "origin/main" })).toBeVisible();

  await messageBody.locator("code", { hasText: "origin/main" }).click({ clickCount: 3 });

  await expect(page.getByRole("menu", { name: "Selected text actions" })).toBeVisible();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim()).toBe(content.replace(/`/g, ""));
});

test("select mode entry + check circles + toolbar render", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);

  // Wait until the channel is rendered (latest seeded message visible) so the
  // socket.io per-channel room is joined. Otherwise messages we POST below
  // get broadcast to a room that doesn't include this client yet — see
  // "socket.io rooms have no buffer" feedback.
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

  // Send a couple messages so we have something to right-click.
  const tag = `selectsmoke-${Date.now()}`;
  for (let i = 0; i < 2; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}` },
    });
  }

  // Wait for our messages to render
  await expect(page.getByText(`${tag} 0`).first()).toBeVisible();
  await expect(page.getByText(`${tag} 1`).first()).toBeVisible();

  // Right-click the first message → context menu shows "Share messages…" first
  const firstMsg = page.getByText(`${tag} 0`).first();
  await clickShareMessagesMenu(page, firstMsg);

  // Toolbar visible at bottom
  const toolbar = page.getByTestId("select-mode-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(page.getByTestId("select-mode-count")).toHaveText("1 selected");
  // Share preview lives in More and is enabled with one selected message.
  await expect(page.getByTestId("select-mode-more")).toBeEnabled();
  await openSelectModeMoreMenu(page);
  await expect(page.getByTestId("select-mode-share-open")).toBeEnabled();
  await page.getByTestId("select-mode-more").click();
  await expect(page.getByTestId("select-mode-more-menu")).toHaveCount(0);

  // Exactly one message has the filled (yellow) check circle — the one we
  // entered select mode on. Filter the testid set by the bg-soft-signal
  // class on the same element (`.has(.bg-soft-signal)` would look at
  // descendants).
  const filledCircles = page.locator(
    '[data-testid^="message-select-circle-"].bg-soft-signal',
  );
  await expect(filledCircles).toHaveCount(1);

  // Click another message → 2 selected
  await page.getByText(`${tag} 1`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");

  // Cancel exits
  await page.getByTestId("select-mode-cancel").click();
  await expect(toolbar).toHaveCount(0);
});

test("sharing grouped continuations keeps one sender avatar for the selected segment", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

  const tag = `grouped-share-avatar-${Date.now()}`;
  for (let i = 0; i < 3; i += 1) {
    const response = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}` },
    });
    expect(response.ok()).toBe(true);
  }
  await expect(page.getByText(`${tag} 2`).first()).toBeVisible();

  // Enter selection on the first row, then leave only the continuation row
  // selected. This is the exact case where grouped rendering used to export
  // a row with no avatar because it relied on the omitted preceding row.
  await clickShareMessagesMenu(page, page.getByText(`${tag} 0`).first());
  await page.getByText(`${tag} 1`).first().click();
  await page.getByText(`${tag} 0`).first().click();
  await page.getByText(`${tag} 2`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");

  const continuationBody = page.locator("[data-message-selectable='true']", { hasText: `${tag} 1` }).last();
  const continuationRow = continuationBody.locator("xpath=ancestor::div[starts-with(@id, 'message-')][1]");
  const lastBody = page.locator("[data-message-selectable='true']", { hasText: `${tag} 2` }).last();
  const lastRow = lastBody.locator("xpath=ancestor::div[starts-with(@id, 'message-')][1]");
  await expect(continuationRow.locator("[data-avatar-kind]")).toHaveCount(1);
  await expect(lastRow.locator("[data-avatar-kind]")).toHaveCount(0);

  await clickSelectModeMoreAction(page, "select-mode-share-open");
  const lightbox = page.getByTestId("select-share-lightbox");
  await expect(lightbox).toBeVisible({ timeout: 10000 });
  await expect(lightbox.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
});

test("select mode → Share... → preview lightbox → Download triggers download", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

  const tag = `selectsave-${Date.now()}`;
  for (let i = 0; i < 2; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}` },
    });
  }
  await expect(page.getByText(`${tag} 1`).first()).toBeVisible();

  // Enter select mode on the first message + add the second
  await clickShareMessagesMenu(page, page.getByText(`${tag} 0`).first());
  await page.getByText(`${tag} 1`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");

  // Listen for download trigger via the data: anchor click — html-to-image
  // produces a data URL, Playwright surfaces it as a Download event.
  const downloadPromise = page.waitForEvent("download");

  // Share... → lightbox renders preview
  await clickSelectModeMoreAction(page, "select-mode-share-open");
  const lightbox = page.getByTestId("select-share-lightbox");
  await expect(lightbox).toBeVisible({ timeout: 10000 });
  await expect(lightbox.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.getByTestId("select-share-lightbox-copy-image")).toHaveText(/Copy image/);
  await expect(page.getByTestId("select-share-lightbox-download")).toHaveText(/Download/);
  await expect(page.getByTestId("select-share-lightbox-share-x")).toHaveText(/Share to X/);

  // Click Download → download fires + lightbox closes + select mode exits
  await page.getByTestId("select-share-lightbox-download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/);

  await expect(lightbox).toHaveCount(0);
  await expect(page.getByTestId("select-mode-toolbar")).toHaveCount(0);
});

test("select mode → Share preview → close lightbox preserves selection (v1.3)", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByTestId("message-scroller")).toBeVisible();
  await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

  const tag = `selectclose-${Date.now()}`;
  for (let i = 0; i < 2; i++) {
    await request.post(`${seedState.urls.api}/api/messages`, {
      headers: { Authorization: `Bearer ${login.accessToken}`, "X-Server-Id": seedState.server.id },
      data: { channelId: seedState.channel.id, content: `${tag} ${i}` },
    });
  }
  await expect(page.getByText(`${tag} 1`).first()).toBeVisible();

  await clickShareMessagesMenu(page, page.getByText(`${tag} 0`).first());
  await page.getByText(`${tag} 1`).first().click();
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");

  // Open preview, then close via the X button. Select mode + selection must persist.
  await clickSelectModeMoreAction(page, "select-mode-share-open");
  const lightbox = page.getByTestId("select-share-lightbox");
  await expect(lightbox).toBeVisible({ timeout: 10000 });

  await page.getByTestId("select-share-lightbox-close").click();
  await expect(lightbox).toHaveCount(0);
  await expect(page.getByTestId("select-mode-toolbar")).toBeVisible();
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");

  // Re-open: the redundant footer Cancel button is intentionally absent.
  // Closing still goes through the header X and preserves selection.
  await clickSelectModeMoreAction(page, "select-mode-share-open");
  await expect(lightbox).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("select-share-lightbox-cancel")).toHaveCount(0);
  await page.getByTestId("select-share-lightbox-close").click();
  await expect(lightbox).toHaveCount(0);
  await expect(page.getByTestId("select-mode-count")).toHaveText("2 selected");
});

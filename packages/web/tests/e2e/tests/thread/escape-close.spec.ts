import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

const HTML_FIXTURE = Buffer.from(`<!doctype html><html><body><h1>Thread HTML Escape Preview</h1></body></html>`, "utf8");

test.describe("thread panel Escape close", () => {
  test("Escape keeps composer focus safe and closes from non-editable thread focus", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const parentContent = `Thread Escape parent ${Date.now()}`;
    const reply = `Thread Escape reply ${Date.now()}`;

    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: parentContent,
      },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = (await parentResponse.json()) as { id: string };

    const threadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          parentMessageId: parentMessage.id,
          content: reply,
        },
      },
    );
    expect(threadResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const parentMessageCard = page.locator(`#message-${parentMessage.id}`).first();
    await parentMessageCard.scrollIntoViewIfNeeded();
    await expect(parentMessageCard).toBeVisible();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = page.getByTestId("thread-message-scroller");
    const threadComposer = page.getByPlaceholder("Message thread");
    await expect(threadScroller.getByText(reply)).toBeVisible();

    await threadComposer.focus();
    await page.keyboard.press("Escape");
    await expect(threadScroller).toBeVisible();

    await page.getByRole("button", { name: "View in channel" }).focus();
    await page.keyboard.press("Escape");
    await expect(threadScroller).toHaveCount(0);
    await expect(threadComposer).toHaveCount(0);
  });

  test("Escape closes HTML preview opened from a thread without closing the thread", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const suffix = randomUUID();
    const upload = await request.post(`${seedState.urls.api}/api/attachments/upload`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      multipart: {
        channelId: seedState.channel.id,
        files: {
          name: `thread-preview-${suffix}.html`,
          mimeType: "text/html",
          buffer: HTML_FIXTURE,
        },
      },
    });
    expect(upload.ok()).toBeTruthy();
    const attachment = ((await upload.json()) as { attachments: Array<{ id: string }> }).attachments[0];

    const parentContent = `Thread HTML Escape parent ${suffix}`;
    const parentResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: parentContent,
        attachmentIds: [attachment.id],
      },
    });
    expect(parentResponse.ok()).toBeTruthy();
    const parentMessage = (await parentResponse.json()) as { id: string };

    const reply = `Thread HTML Escape reply ${suffix}`;
    const threadResponse = await request.post(
      `${seedState.urls.api}/api/channels/${seedState.channel.id}/threads`,
      {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "X-Server-Id": seedState.server.id,
        },
        data: {
          parentMessageId: parentMessage.id,
          content: reply,
        },
      },
    );
    expect(threadResponse.ok()).toBeTruthy();

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const parentMessageCard = page.locator(`#message-${parentMessage.id}`).first();
    await parentMessageCard.scrollIntoViewIfNeeded();
    await parentMessageCard.hover();
    await parentMessageCard.getByLabel("Reply in thread").click();

    const threadScroller = page.getByTestId("thread-message-scroller");
    await expect(threadScroller.getByText(reply)).toBeVisible();

    const threadParent = page.getByTestId("thread-panel-parent");
    const attachmentButton = threadParent.getByLabel(`thread-preview-${suffix}.html`);
    await attachmentButton.click();
    await expect(page.locator('iframe[title^="HTML preview"]')).toBeVisible();

    // Keep focus in the parent document before pressing Escape. If Chromium
    // leaves focus inside the sandboxed iframe, the parent preview shell cannot
    // receive the key event.
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(page.locator('iframe[title^="HTML preview"]')).toHaveCount(0);
    await expect(threadScroller).toBeVisible();
    await expect(threadScroller.getByText(reply)).toBeVisible();
  });
});

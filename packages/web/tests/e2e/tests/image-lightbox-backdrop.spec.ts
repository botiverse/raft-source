import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import { dismissOwnerOnboarding } from "../fixtures/session";

const PROOF_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAAA2CAIAAAC3LQuFAAAAZ0lEQVR42u3QQQkAQAgAMKOZ6/rYyD5eCsHHYAkW03nLq1NCkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBuz50p3KXsCdByQAAAABJRU5ErkJggg==";

test("clicking outside the image closes the message image lightbox after zoom", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const filename = `lightbox-${Date.now()}.png`;
  const imageBuffer = Buffer.from(PROOF_IMAGE_BASE64, "base64");
  const upload = await request.post(`${seedState.urls.api}/api/attachments/upload`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    multipart: {
      channelId: seedState.channel.id,
      files: {
        name: filename,
        mimeType: "image/png",
        buffer: imageBuffer,
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = ((await upload.json()) as { attachments: Array<{ id: string }> }).attachments[0];
  expect(attachment?.id).toBeTruthy();

  const tag = `lightbox backdrop ${randomUUID()}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachment.id],
    },
  });
  expect(message.ok()).toBeTruthy();

  // E2E serves the app and the API on different ports, and the API streams
  // local-storage files with helmet's `Cross-Origin-Resource-Policy:
  // same-origin`, so the browser blocks every <img> of an attachment
  // (production redirects to presigned storage URLs instead). The lightbox
  // shows its error state for an image that never loads, and this test needs
  // one that renders: serve attachment images to the page without that header.
  await page.route(`${seedState.urls.api}/api/attachments/**`, async (route) => {
    if (route.request().resourceType() !== "image") return route.fallback();
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["cross-origin-resource-policy"];
    await route.fulfill({ response, headers });
  });

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByText(tag)).toBeVisible();
  await page.getByLabel(`Preview ${filename}`).click();

  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();

  const image = page.getByTestId("image-lightbox-image");
  const imageBoxBeforeZoom = await image.boundingBox();
  expect(imageBoxBeforeZoom).toBeTruthy();

  // A single click on the image zooms instead of closing (#bug-triage task #12);
  // wait for the animated zoom to commit before measuring.
  await image.click();
  await expect(lightbox).toBeVisible();
  await expect(image).not.toHaveCSS("transform", "none");
  await expect.poll(() => image.evaluate((el) => (el as HTMLElement).style.transition)).toBe("");

  const imageBoxAfterZoom = await image.boundingBox();
  const stageBox = await page.getByTestId("image-lightbox-stage").boundingBox();
  expect(imageBoxAfterZoom).toBeTruthy();
  expect(stageBox).toBeTruthy();
  if (!imageBoxBeforeZoom || !imageBoxAfterZoom || !stageBox) throw new Error("missing lightbox geometry");

  const leftZoomedEdgeX = imageBoxAfterZoom.x + 8;
  const rightZoomedEdgeX = imageBoxAfterZoom.x + imageBoxAfterZoom.width - 8;
  const beforeRight = imageBoxBeforeZoom.x + imageBoxBeforeZoom.width;
  const zoomedVisualX = leftZoomedEdgeX < imageBoxBeforeZoom.x ? leftZoomedEdgeX : rightZoomedEdgeX;
  const zoomedVisualY = imageBoxAfterZoom.y + imageBoxAfterZoom.height / 2;
  expect(zoomedVisualX < imageBoxBeforeZoom.x || zoomedVisualX > beforeRight).toBeTruthy();
  expect(zoomedVisualX >= imageBoxAfterZoom.x && zoomedVisualX <= imageBoxAfterZoom.x + imageBoxAfterZoom.width).toBeTruthy();
  // A click on the zoomed image's pixels outside its original box is still an
  // image click: it zooms back to fit and does not close.
  await page.mouse.click(zoomedVisualX, zoomedVisualY);
  await expect(lightbox).toBeVisible();
  await expect(image).toHaveCSS("transform", "none");
  await expect.poll(() => image.evaluate((el) => (el as HTMLElement).style.transition)).toBe("");

  // Zoom in again, so the blank click below proves a ZOOMED lightbox closes.
  await image.click();
  await expect(image).not.toHaveCSS("transform", "none");
  await expect.poll(() => image.evaluate((el) => (el as HTMLElement).style.transition)).toBe("");

  const blankX = stageBox.x + 8;
  const blankY = stageBox.y + 8;
  expect(
    blankX < imageBoxAfterZoom.x ||
    blankX > imageBoxAfterZoom.x + imageBoxAfterZoom.width ||
    blankY < imageBoxAfterZoom.y ||
    blankY > imageBoxAfterZoom.y + imageBoxAfterZoom.height,
  ).toBeTruthy();
  await expect(image).not.toHaveCSS("transform", "none");
  await page.mouse.click(blankX, blankY);
  await expect(lightbox).toHaveCount(0);
});

test("thumbnail download button triggers download without opening lightbox", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  const filename = `thumbnail-download-${Date.now()}.png`;
  const imageBuffer = Buffer.from(PROOF_IMAGE_BASE64, "base64");
  const upload = await request.post(`${seedState.urls.api}/api/attachments/upload`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    multipart: {
      channelId: seedState.channel.id,
      files: {
        name: filename,
        mimeType: "image/png",
        buffer: imageBuffer,
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const attachment = ((await upload.json()) as { attachments: Array<{ id: string }> }).attachments[0];
  expect(attachment?.id).toBeTruthy();

  const tag = `thumbnail download ${randomUUID()}`;
  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachment.id],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = (await message.json()) as { id: string };

  await page.route(`**/api/messages/channel/${seedState.channel.id}?**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const messages = Array.isArray(body) ? body : body.messages;
    const patchedMessages = messages.map((item: any) => item.id === messageBody.id
      ? {
          ...item,
          attachments: item.attachments.map((att: any) => att.id === attachment.id
            ? {
                ...att,
                width: 96,
                height: 54,
                thumbnailUrl: "https://thumbnail.test/proof.png",
              }
            : att),
        }
      : item);
    await route.fulfill({
      response,
      json: Array.isArray(body) ? patchedMessages : { ...body, messages: patchedMessages },
    });
  });
  await page.route("https://thumbnail.test/proof.png", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imageBuffer,
    });
  });
  const downloadFixturePath = `/thumbnail-download-fixture/${attachment.id}/${filename}`;
  await page.route(`**/api/attachments/${attachment.id}/url**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("disposition") === "attachment") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: downloadFixturePath }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: `data:image/png;base64,${PROOF_IMAGE_BASE64}` }),
    });
  });
  await page.route(`**${downloadFixturePath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: imageBuffer,
    });
  });

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  await expect(page.getByText(tag)).toBeVisible();

  const preview = page.getByLabel(`Preview ${filename}`);
  await preview.click();
  const lightbox = page.getByTestId("image-lightbox");
  await expect(lightbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  const downloadButton = page.getByLabel(`Download ${filename}`);
  await preview.hover();
  await expect(downloadButton).toBeVisible();
  const attachmentUrlResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/attachments/${attachment.id}/url?disposition=attachment`) &&
    response.status() === 200,
  );
  const [download, signedUrlResponse] = await Promise.all([
    page.waitForEvent("download"),
    attachmentUrlResponse,
    downloadButton.click(),
  ]);
  expect(signedUrlResponse.ok()).toBeTruthy();
  expect(await signedUrlResponse.json()).toEqual({ url: downloadFixturePath });
  expect(download.url()).toContain(downloadFixturePath);
  expect(download.suggestedFilename()).toBe(filename);
  await expect(lightbox).toHaveCount(0);
});

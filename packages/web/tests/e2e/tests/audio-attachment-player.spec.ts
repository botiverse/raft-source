import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import { dismissOwnerOnboarding } from "../fixtures/session";

function makeWavFixture(durationSeconds = 4) {
  const sampleRate = 8_000;
  const bytesPerSample = 2;
  const channels = 1;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * bytesPerSample * channels;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0x2000);
    buffer.writeInt16LE(sample, 44 + index * bytesPerSample);
  }
  return buffer;
}

async function uploadAudioAttachment(request: APIRequestContext, seedState: Awaited<ReturnType<typeof waitForSeedState>>, accessToken: string, suffix: string) {
  const response = await request.post(`${seedState.urls.api}/api/attachments/upload`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    multipart: {
      channelId: seedState.channel.id,
      files: {
        name: `audio-player-${suffix}.wav`,
        mimeType: "audio/wav",
        buffer: makeWavFixture(),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as { attachments: Array<{ id: string }> };
  return body.attachments[0]!.id;
}

async function openSeededAudioMessage(page: Page, request: APIRequestContext) {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const suffix = randomUUID();
  const attachmentId = await uploadAudioAttachment(request, seedState, login.accessToken, suffix);
  const tag = `custom audio player ${suffix}`;

  const message = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: {
      channelId: seedState.channel.id,
      content: tag,
      attachmentIds: [attachmentId],
    },
  });
  expect(message.ok()).toBeTruthy();
  const messageBody = await message.json() as { id: string };

  await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
  const messageCard = page.locator(`#message-${messageBody.id}`).first();
  const player = messageCard.locator("[data-message-affordance='inline-audio-player']");
  await expect(messageCard.getByText(tag)).toBeVisible();
  await expect(player).toBeVisible();
  await expect(messageCard.locator("[data-message-affordance='audio-preview']")).toHaveCount(0);
  await expect(messageCard.locator("audio[controls]")).toHaveCount(0);
  await expect(messageCard.locator("audio[preload='metadata']")).toHaveCount(1);
  await expect(player.locator("[data-message-affordance='audio-time']")).toContainText("/ 0:04", { timeout: 10_000 });
  return { messageCard, player, suffix };
}

test("audio attachments expose a custom inline player with keyboard-accessible controls", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { messageCard, player, suffix } = await openSeededAudioMessage(page, request);

  const play = player.getByRole("button", { name: `Play audio audio-player-${suffix}.wav` });
  await expect(play).toBeVisible();
  await play.focus();
  await expect(play).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(player.getByRole("button", { name: `Pause audio audio-player-${suffix}.wav` })).toBeVisible();

  const seek = player.locator("[data-message-affordance='audio-seek']");
  const seekRail = player.locator("[data-message-affordance='audio-seek-rail']");
  await expect(seek).toHaveAttribute("aria-label", `Seek audio audio-player-${suffix}.wav`);
  await page.keyboard.press("Tab");
  await expect(seek).toBeFocused();
  await expect(seekRail).toHaveCSS("outline-style", "solid");
  await expect(seekRail).toHaveCSS("outline-width", "2px");
  await seek.evaluate((input) => {
    const range = input as HTMLInputElement;
    range.value = "2";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(player.locator("[data-message-affordance='audio-time']")).toContainText("0:02 / 0:04");

  const volume = player.locator("[data-message-affordance='audio-volume']");
  const volumeRail = player.locator("[data-message-affordance='audio-volume-rail']");
  await expect(volume).toHaveAttribute("aria-label", `Audio volume audio-player-${suffix}.wav`);
  await page.keyboard.press("Tab");
  await expect(volume).toBeFocused();
  await expect(volumeRail).toHaveCSS("outline-style", "solid");
  await expect(volumeRail).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("ArrowLeft");
  await expect(volume).toHaveAttribute("aria-valuetext", /9[0-9]%/);

  const screenshotDir = process.env.SLOCK_AUDIO_PLAYER_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    const preview = messageCard.locator("[data-message-affordance='inline-audio-preview']");
    await preview.screenshot({ path: path.join(screenshotDir, "audio-player-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(player).toBeVisible();
    await preview.screenshot({ path: path.join(screenshotDir, "audio-player-mobile.png") });
  }
});

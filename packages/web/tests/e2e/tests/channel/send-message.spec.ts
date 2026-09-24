import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

async function createChannel(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ id: string; name: string }>;
}

async function postMessage(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId, content },
  });
  expect(response.ok()).toBeTruthy();
}

async function selectSidebarSortMode(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  mode: string,
  section = "channels",
) {
  await page.locator(`[data-testid="sidebar-sort-menu-button"][data-sort-section="${section}"]`).click();
  await page.getByRole("button", { name: mode, exact: true }).click();
}

async function getSidebarOrder(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ channelSortMode: string; pinnedSortMode: string }>;
}

async function patchSidebarOrder(
  request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  seedState: Awaited<ReturnType<typeof waitForSeedState>>,
  accessToken: string,
  body: Record<string, unknown>,
) {
  const response = await request.patch(`${seedState.urls.api}/api/servers/${seedState.server.id}/sidebar-order`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: body,
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function channelRowTop(page: Parameters<Parameters<typeof test>[1]>[0]["page"], name: string) {
  const row = page.locator("#sidebar-section-channels").getByRole("button", { name, exact: true }).first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  return box!.y;
}

function sidebarButtonName(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s+\\d+)?$`);
}

async function sidebarRowTop(page: Parameters<Parameters<typeof test>[1]>[0]["page"], name: string) {
  const row = page.getByRole("button", { name: sidebarButtonName(name) }).first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  return box!.y;
}

async function isPinnedBefore(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  firstName: string,
  secondName: string,
) {
  const labels = await page.locator("#sidebar-section-pinned button").evaluateAll((buttons) =>
    buttons.map((button) => button.textContent ?? ""),
  );
  const firstIndex = labels.findIndex((label) => label.includes(firstName));
  const secondIndex = labels.findIndex((label) => label.includes(secondName));
  return firstIndex !== -1 && secondIndex !== -1 && firstIndex < secondIndex;
}

test.describe("P0 channel messaging", () => {
  test("composer draft restores after reload without a beforeunload dialog", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const draft = `reload-safe draft ${Date.now()}`;
    const beforeUnloadDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      beforeUnloadDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      await dialog.accept();
    });

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    const composer = page.getByPlaceholder(`Message #${seedState.channel.name}`);
    await expect(composer).toBeVisible();
    await composer.fill(draft);

    await expect.poll(async () => page.evaluate((channelId) => {
      const raw = localStorage.getItem("slock_drafts");
      if (!raw) return null;
      const drafts = JSON.parse(raw) as Record<string, string>;
      return drafts[channelId] ?? null;
    }, seedState.channel.id)).toBe(draft);

    await page.reload();
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toHaveValue(draft);
    await page.close({ runBeforeUnload: true });

    expect(beforeUnloadDialogs).toEqual([]);
  });

  test("joined user sends a message in the current channel", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const message = `P0 channel send ${Date.now()}`;

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    await page.getByPlaceholder(`Message #${seedState.channel.name}`).fill(message);
    await page.getByRole("button", { name: /^Send$/ }).click();

    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByText(message)).toHaveCount(1);
  });

  test("recent sidebar sort moves the current channel after sending there", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const oldChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `recent-old-${Date.now().toString(36)}`,
    );
    const newChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `recent-new-${Date.now().toString(36)}`,
    );
    await postMessage(
      request,
      seedState,
      login.accessToken,
      oldChannel.id,
      `Old channel recent seed ${Date.now()}`,
    );

    await page.goto(`/s/${seedState.server.slug}/channel/${newChannel.id}`);
    await expect(page.getByPlaceholder(`Message #${newChannel.name}`)).toBeVisible();
    await selectSidebarSortMode(page, "Recent");
    await expect.poll(async () => (await getSidebarOrder(request, seedState, login.accessToken)).channelSortMode).toBe("recent");

    await page.reload();
    await expect(page.getByPlaceholder(`Message #${newChannel.name}`)).toBeVisible();

    await expect.poll(async () => (
      await sidebarRowTop(page, oldChannel.name)
    ) < (
      await sidebarRowTop(page, newChannel.name)
    )).toBeTruthy();

    const message = `Current channel recent sort ${Date.now()}`;
    await page.getByPlaceholder(`Message #${newChannel.name}`).fill(message);
    await page.getByRole("button", { name: /^Send$/ }).click();
    await expect(page.getByText(message)).toBeVisible();

    await expect.poll(async () => {
      return (await channelRowTop(page, newChannel.name)) < (await channelRowTop(page, oldChannel.name));
    }).toBeTruthy();
  });

  test("recent pinned sidebar sort persists and sorts pinned channels by latest message", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const oldChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `pinned-old-${Date.now().toString(36)}`,
    );
    const newChannel = await createChannel(
      request,
      seedState,
      login.accessToken,
      `pinned-new-${Date.now().toString(36)}`,
    );
    await postMessage(request, seedState, login.accessToken, oldChannel.id, `Pinned old seed ${Date.now()}`);
    await postMessage(request, seedState, login.accessToken, newChannel.id, `Pinned new seed ${Date.now()}`);
    await patchSidebarOrder(request, seedState, login.accessToken, {
      pinnedChannelIds: [oldChannel.id, newChannel.id],
      pinnedOrder: [oldChannel.id, newChannel.id],
      pinnedSortMode: "manual",
    });

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect.poll(async () => isPinnedBefore(page, oldChannel.name, newChannel.name)).toBeTruthy();

    await selectSidebarSortMode(page, "Recent", "pinned");
    await expect.poll(async () => (await getSidebarOrder(request, seedState, login.accessToken)).pinnedSortMode).toBe("recent");

    await page.reload();
    await expect.poll(async () => isPinnedBefore(page, newChannel.name, oldChannel.name)).toBeTruthy();
  });
});

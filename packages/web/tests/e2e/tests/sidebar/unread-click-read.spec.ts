import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { assertApiOk } from "../../fixtures/apiResponse";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding, loginWithCredentials } from "../../fixtures/session";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function authHeaders(accessToken: string, serverId: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Server-Id": serverId,
  };
}

function sidebarButtonName(name: string) {
  return new RegExp(`^${escapeRegExp(name)}(?:\\s+\\d+)?$`);
}

function channelPath(seedState: PlaywrightSeedState, channelId: string) {
  return `/s/${seedState.server.slug}/channel/${channelId}`;
}

function dmPath(seedState: PlaywrightSeedState, channelId: string) {
  return `/s/${seedState.server.slug}/dm/${channelId}`;
}

async function createChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { name },
  });
  await assertApiOk(response, `POST /api/channels (name=${name})`);
  return response.json() as Promise<{ id: string; name: string }>;
}

async function createDm(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/dm`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { userId },
  });
  await assertApiOk(response, `POST /api/channels/dm (userId=${userId})`);
  return response.json() as Promise<{ id: string }>;
}

async function addHumanToChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  userId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/members`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { userId },
  });
  await assertApiOk(response, `POST /api/channels/${channelId}/members (userId=${userId})`);
}

async function createMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: authHeaders(accessToken, seedState.server.id),
    data: { channelId, content },
  });
  await assertApiOk(response, `POST /api/messages (channelId=${channelId})`);
}

async function markChannelRead(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/channels/${channelId}/read-all`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  await assertApiOk(response, `POST /api/channels/${channelId}/read-all`);
}

async function getServerUnreadCount(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
) {
  const response = await request.get(`${seedState.urls.api}/api/channels/unread`, {
    headers: authHeaders(accessToken, seedState.server.id),
  });
  await assertApiOk(response, "GET /api/channels/unread");
  const body = await response.json() as Record<string, number>;
  return body[channelId] ?? 0;
}

function channelRow(page: Page, name: string) {
  return page
    .locator("#sidebar-section-channels")
    .getByRole("button", { name: sidebarButtonName(name) })
    .first();
}

function dmRow(page: Page, channelId: string) {
  return page.locator(`button[data-sidebar-channel-id="${channelId}"]`).first();
}

async function openRowMenu(row: Locator, page: Page) {
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  const markAction = page.getByRole("menuitem", { name: /Mark as (Read|Unread)/ });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await row.click({ button: "right" });
    try {
      await expect(markAction).toBeVisible({ timeout: 5000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function expectUnreadBadge(row: Locator, count: number) {
  const unreadBadge = row.locator("span.bg-brutal-pink");
  if (count > 0) {
    await expect(unreadBadge).toHaveText(String(count));
    return;
  }
  await expect(unreadBadge).toHaveCount(0);
}

test("sidebar Mark as Unread works across channels and DMs from current or other chats", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);
  const extraHumanLogin = await loginWithCredentials(
    request,
    seedState.urls.api,
    seedState.extraHuman.email,
    seedState.extraHuman.password,
  );

  const runId = Date.now().toString(36);
  const anchorChannel = await createChannel(request, seedState, login.accessToken, `unread-anchor-${runId}`);
  await createMessage(
    request,
    seedState,
    login.accessToken,
    anchorChannel.id,
    `Unread matrix anchor message ${runId}`,
  );
  const matrixChannel = await createChannel(request, seedState, login.accessToken, `unread-channel-${runId}`);
  await addHumanToChannel(
    request,
    seedState,
    login.accessToken,
    matrixChannel.id,
    seedState.extraHuman.userId,
  );
  const matrixDm = await createDm(request, seedState, login.accessToken, seedState.extraHuman.userId);

  const conversations = [
    {
      kind: "channel",
      id: matrixChannel.id,
      label: matrixChannel.name,
      path: channelPath(seedState, matrixChannel.id),
      row: () => channelRow(page, matrixChannel.name),
    },
    {
      kind: "dm",
      id: matrixDm.id,
      label: `DM with ${seedState.extraHuman.name}`,
      path: dmPath(seedState, matrixDm.id),
      row: () => dmRow(page, matrixDm.id),
    },
  ] as const;

  const latestAuthors = ["peer", "self"] as const;
  const startingPlaces = ["target", "other"] as const;

  for (const conversation of conversations) {
    for (const latestAuthor of latestAuthors) {
      for (const startingPlace of startingPlaces) {
        await test.step(`${conversation.kind}: latest ${latestAuthor}, starting from ${startingPlace}`, async () => {
          const contentBase = `${conversation.kind}-${latestAuthor}-${startingPlace}-${Date.now().toString(36)}`;
          await createMessage(
            request,
            seedState,
            extraHumanLogin.accessToken,
            conversation.id,
            `Unread eligible peer message ${contentBase}`,
          );
          if (latestAuthor === "self") {
            await createMessage(
              request,
              seedState,
              login.accessToken,
              conversation.id,
              `Self-authored latest message ${contentBase}`,
            );
          }
          await markChannelRead(request, seedState, login.accessToken, conversation.id);

          const startPath = startingPlace === "target"
            ? conversation.path
            : channelPath(seedState, anchorChannel.id);
          await page.goto(startPath, { waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("message-scroller")).toBeVisible();

          const row = conversation.row();
          await expectUnreadBadge(row, 0);
          await openRowMenu(row, page);

          const unreadResponsePromise = page.waitForResponse((response) =>
            response.request().method() === "POST"
            && response.url().includes(`/api/channels/${conversation.id}/unread`)
          );
          await page.getByRole("menuitem", { name: "Mark as Unread" }).click();
          await expect(page.getByRole("menuitem", { name: "Mark as Unread" })).toHaveCount(0);
          await expectUnreadBadge(row, 1);

          const unreadResponse = await unreadResponsePromise;
          expect(unreadResponse.ok()).toBeTruthy();
          expect((await unreadResponse.json() as { unreadCount: number }).unreadCount).toBe(1);
          await expect.poll(async () =>
            getServerUnreadCount(request, seedState, login.accessToken, conversation.id)
          ).toBe(1);
          await expectUnreadBadge(row, 1);

          if (startingPlace === "target") {
            await channelRow(page, anchorChannel.name).click();
            await expect(page).toHaveURL(new RegExp(`/channel/${escapeRegExp(anchorChannel.id)}(?:$|[?#])`));
            await expectUnreadBadge(row, 1);
          }

          const readResponsePromise = page.waitForResponse((response) =>
            response.request().method() === "POST"
            && response.url().includes(`/api/channels/${conversation.id}/read-all`)
          );
          await row.click();
          const readResponse = await readResponsePromise;
          expect(readResponse.ok()).toBeTruthy();
          await expectUnreadBadge(row, 0);
          await expect.poll(async () =>
            getServerUnreadCount(request, seedState, login.accessToken, conversation.id)
          ).toBe(0);
        });
      }
    }
  }
});
